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
import { timingSafeEqual } from 'crypto'
import { getToolsForContext, executeRegisteredTool } from '@/lib/tool-registry'
import { checkToolPermission } from '@/lib/tool-permissions'
import { prisma } from '@/lib/db'
import { decryptStrict } from '@/lib/encryption'
// Side-effect import: ensures ALL tools are registered (core + Warden SIEM + GitHub),
// not just the core tools defined inline in tool-registry. Without this the MCP path
// only sees core tools because tool-registry does not import the extra registrations.
import '@/lib/management-tools'

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
  // Token transport: x-mcp-token header (preferred) or Authorization: Bearer <token>
  const bearer =
    req.headers.get('x-mcp-token') ??
    (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') ||
    null

  if (!bearer) {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
      { status: 401 },
    )
  }

  const { searchParams } = new URL(req.url)
  const rawAgentId = searchParams.get('agentId') ?? undefined
  const roomId     = searchParams.get('roomId')  ?? undefined

  // ── Legacy shared-token path ──────────────────────────────────────────────
  // ORION_MCP_TOKEN is kept for outbound service auth and legacy inbound compat.
  // When it matches, allow immediately (no per-agent lookup needed).
  let usedLegacyToken = false
  if (MCP_TOKEN) {
    const aLen = Buffer.byteLength(bearer)
    const bLen = Buffer.byteLength(MCP_TOKEN)
    if (aLen === bLen && timingSafeEqual(Buffer.from(bearer), Buffer.from(MCP_TOKEN))) {
      usedLegacyToken = true
      console.warn('[mcp] Legacy ORION_MCP_TOKEN used — migrate to per-agent tokens')
    }
  }

  // ── Per-request context (agent and room for tool execution) ───────────────
  // Verify agentId refers to a real agent and, for per-agent token path, verify the token.
  let agentId: string | undefined
  let agentAllowedTools: string[] | null = null
  if (rawAgentId) {
    const agent = await prisma.agent.findUnique({
      where:  { id: rawAgentId },
      select: { id: true, metadata: true, mcpToken: true },
    })
    if (!agent) {
      return NextResponse.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: agentId not found' }, id: null },
        { status: 401 },
      )
    }

    if (!usedLegacyToken) {
      // Per-agent token verification: look up agent, decrypt stored token, timingSafeEqual
      if (!agent.mcpToken) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
          { status: 401 },
        )
      }
      let storedToken: string
      try {
        storedToken = decryptStrict(agent.mcpToken, 'mcpToken')
      } catch {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
          { status: 401 },
        )
      }
      const aBytes = Buffer.from(bearer)
      const bBytes = Buffer.from(storedToken)
      if (aBytes.length !== bBytes.length || !timingSafeEqual(aBytes, bBytes)) {
        return NextResponse.json(
          { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
          { status: 401 },
        )
      }
    }

    agentId = agent.id
    const allowed = (agent.metadata as { contextConfig?: { allowedTools?: unknown } } | null)?.contextConfig?.allowedTools
    if (Array.isArray(allowed)) {
      agentAllowedTools = allowed.filter((t): t is string => typeof t === 'string')
    }
  } else if (!usedLegacyToken) {
    // No agentId and token didn't match the legacy env var — reject
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
      { status: 401 },
    )
  } else if (!MCP_TOKEN) {
    // MCP_TOKEN not set and no agentId — reject
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'MCP server not configured (ORION_MCP_TOKEN not set)' }, id: null },
      { status: 503 },
    )
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
