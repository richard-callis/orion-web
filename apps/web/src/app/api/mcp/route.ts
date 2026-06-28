/**
 * ORION MCP Server — exposes the tool registry to Claude via the
 * Model Context Protocol (MCP) streamable-HTTP transport.
 *
 * The orion-claude sidecar writes a per-request .mcp.json pointing here,
 * so Claude can call ORION tools natively instead of going around the system.
 *
 * Auth: x-mcp-token header (ORION_MCP_TOKEN env var, same secret in both containers).
 * Context: agentId and roomId are passed as query params per request.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getToolsForContext, executeRegisteredTool } from '@/lib/tool-registry'
import { checkToolPermission } from '@/lib/tool-permissions'
import { prisma } from '@/lib/db'

const MCP_TOKEN = process.env.ORION_MCP_TOKEN

type JsonRpcRequest = {
  jsonrpc: string
  id?: string | number | null
  method: string
  params?: unknown
}

function ok(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result })
}

function err(id: unknown, code: number, message: string) {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } })
}

export async function POST(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  // Fail CLOSED when MCP_TOKEN is not configured — the previous code accepted
  // all requests when the env var was unset, silently disabling auth.
  if (!MCP_TOKEN) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'MCP server not configured (ORION_MCP_TOKEN not set)' }, id: null },
      { status: 503 },
    )
  }
  const token = req.headers.get('x-mcp-token')
  if (token !== MCP_TOKEN) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
      { status: 401 },
    )
  }

  // ── Per-request context (agent and room for tool execution) ───────────────
  // agentId and roomId come from query params set by the orion-claude sidecar.
  // We validate agentId against the DB to prevent impersonation by arbitrary
  // string injection — the sidecar is trusted, but any token holder can set these.
  const { searchParams } = new URL(req.url)
  const rawAgentId = searchParams.get('agentId') ?? undefined
  const roomId     = searchParams.get('roomId')  ?? undefined

  // Verify agentId refers to a real agent (prevents audit-trail forgery)
  let agentId: string | undefined
  let agentAllowedTools: string[] | null = null
  if (rawAgentId) {
    const agent = await prisma.agent.findUnique({ where: { id: rawAgentId }, select: { id: true, metadata: true } })
    agentId = agent?.id  // undefined if not found — tools run with unknown actor
    // Per-agent tool allowlist: metadata.contextConfig.allowedTools, if present, restricts
    // which tools this agent can list/call. Absent/null means "no restriction".
    const allowed = (agent?.metadata as { contextConfig?: { allowedTools?: unknown } } | null)?.contextConfig?.allowedTools
    if (Array.isArray(allowed)) {
      agentAllowedTools = allowed.filter((t): t is string => typeof t === 'string')
    }
  }

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: JsonRpcRequest
  try {
    body = await req.json()
  } catch {
    return err(null, -32700, 'Parse error')
  }

  const { id, method, params } = body

  // MCP notifications have no id and expect no response body
  if (id === undefined || id === null) {
    return new NextResponse(null, { status: 202 })
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────
  switch (method) {
    // Handshake
    case 'initialize':
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities:    { tools: {} },
        serverInfo:      { name: 'orion', version: '1.0.0' },
      })

    case 'ping':
      return ok(id, {})

    // Tool discovery — return tools filtered to 'chat' context
    case 'tools/list': {
      let tools = getToolsForContext('chat')
      if (agentAllowedTools) {
        tools = tools.filter(t => agentAllowedTools!.includes(t.name))
      }
      return ok(id, {
        tools: tools.map(t => ({
          name:        t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    }

    // Tool execution
    case 'tools/call': {
      const p        = params as { name?: string; arguments?: Record<string, unknown> } | undefined
      const toolName = p?.name
      const toolArgs = p?.arguments ?? {}

      if (!toolName) return err(id, -32602, 'Missing required param: name')

      // Per-agent tool allowlist enforcement — reject tools not in the agent's allowedTools.
      if (agentAllowedTools && !agentAllowedTools.includes(toolName)) {
        return ok(id, {
          content: [{ type: 'text', text: `Error: Tool '${toolName}' is not permitted for this agent.` }],
          isError: true,
        })
      }

      // BLOCKER fix: MCP route previously bypassed checkToolPermission entirely.
      // Every other execution path (openai-runner, ollama-runner, claude.ts) gates
      // on it first, enforcing ToolAgentRestriction whitelists and destructive-tier
      // ToolExecutionGrant requirements. Without this check, any MCP token holder
      // could invoke destructive tools with zero approval.
      const permission = await checkToolPermission(toolName, agentId ?? null, null)
      if (!permission.allowed) {
        return ok(id, {
          content: [{ type: 'text', text: `Error: Tool '${toolName}' is not permitted for this agent. ${permission.reason ?? ''}` }],
          isError: true,
        })
      }

      try {
        const result = await executeRegisteredTool(toolName, toolArgs, {
          agentId,
          roomId,
          prisma,
        })
        return ok(id, {
          content: [{ type: 'text', text: result }],
          isError: false,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return ok(id, {
          content: [{ type: 'text', text: `Error: ${msg}` }],
          isError: true,
        })
      }
    }

    default:
      return err(id, -32601, `Method not found: ${method}`)
  }
}
