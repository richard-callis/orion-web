/**
 * ORION MCP Server — exposes the tool registry to Claude via the
 * Model Context Protocol (MCP) streamable-HTTP transport.
 *
 * The orion-claude sidecar writes a per-request .mcp.json pointing here,
 * so Claude can call ORION tools natively instead of going around the system.
 *
 * Auth: x-mcp-token header (ORION_MCP_TOKEN env var, same secret in both containers).
 * Context: agentId and roomId are passed as query params per request.
 *
 * Gateway tools: an authenticated agent also sees the tools of its linked
 * environment's gateway (kubectl_*, helm_*, custom tools) and may call the ones
 * an admin granted it — the same rule OpenAI/Ollama task agents follow
 * (checkToolPermission). Registry tools win on a name clash.
 */

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getToolsForContext, executeRegisteredTool, getToolDefinition } from '@/lib/tool-registry'
import { resolveAgentGateway, type AgentGateway } from '@/lib/agent-gateway'
import { validateArgsAgainstSchema } from '@/lib/tool-args-validation'
import type { GatewayTool } from '@/lib/agent-runner/types'
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
    ((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || null)

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

  // Gateway of the agent's linked environment (agents only; lazily resolved)
  let gatewayCache: { gw: AgentGateway | null; tools: GatewayTool[] } | undefined
  const loadGateway = async () => {
    if (gatewayCache) return gatewayCache
    const gw = agentId ? await resolveAgentGateway(agentId).catch(() => null) : null
    const tools = gw ? await gw.client.listTools().catch((): GatewayTool[] => []) : []
    gatewayCache = { gw, tools }
    return gatewayCache
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
      const registry = getToolsForContext('chat')
      const { tools: gatewayTools } = await loadGateway()
      let tools = [
        ...registry.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ...gatewayTools
          .filter(t => !getToolDefinition(t.name))
          .map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      ]
      if (agentAllowedTools) {
        tools = tools.filter(t => agentAllowedTools!.includes(t.name))
      }
      return ok(id, { tools })
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
      const isGatewayTool = !getToolDefinition(toolName)
      const { gw, tools: gatewayTools } = isGatewayTool ? await loadGateway() : { gw: null, tools: [] as GatewayTool[] }
      const gatewayTool = isGatewayTool ? gatewayTools.find(t => t.name === toolName) : undefined
      if (isGatewayTool && (!gw || !gatewayTool)) {
        return ok(id, {
          content: [{ type: 'text', text: `Error: Unknown tool '${toolName}' — it is neither an ORION tool nor offered by this agent's environment gateway.` }],
          isError: true,
        })
      }

      const permission = await checkToolPermission(toolName, agentId ?? null, gw?.environmentId ?? null)
      if (!permission.allowed) {
        return ok(id, {
          content: [{ type: 'text', text: `Error: Tool '${toolName}' is not permitted for this agent. ${permission.reason ?? ''}` }],
          isError: true,
        })
      }

      if (gw && gatewayTool) {
        const validation = validateArgsAgainstSchema(gatewayTool.inputSchema, toolArgs)
        if (!validation.valid) {
          return ok(id, {
            content: [{ type: 'text', text: `Tool validation failed for ${toolName}: ${validation.errors.join(', ')}. Check the tool schema and retry with correct arguments.` }],
            isError: true,
          })
        }
        try {
          const result = await gw.client.executeTool(toolName, toolArgs)
          return ok(id, { content: [{ type: 'text', text: result }], isError: false })
        } catch (e) {
          return ok(id, { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true })
        }
      }

      try {
        // ctx.userId is intentionally left unset: this transport authenticates
        // per-agent (mcpToken) or via the legacy shared ORION_MCP_TOKEN — there
        // is no human browser/session identity anywhere in this request (no
        // cookie, no NextAuth token). Tools like knowledge_search that read
        // ctx.userId to scope results to a specific user's notes therefore run
        // trusted/unscoped here, same as the service/gateway path — see
        // ownerFilterSql's doc comment in lib/embeddings.ts.
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
