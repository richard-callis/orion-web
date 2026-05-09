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
  if (MCP_TOKEN) {
    const token = req.headers.get('x-mcp-token')
    if (token !== MCP_TOKEN) {
      return NextResponse.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
        { status: 401 },
      )
    }
  }

  // ── Per-request context (agent and room for tool execution) ───────────────
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId') ?? undefined
  const roomId  = searchParams.get('roomId')  ?? undefined

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

    // Tool discovery
    case 'tools/list': {
      const tools = getToolsForContext('chat')
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
