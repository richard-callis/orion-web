/**
 * Mission Control Gateway — MCP Server
 *
 * Runs alongside a cluster or Docker node. Registers with MCC, fetches tool config,
 * and exposes those tools via the MCP protocol for AI agents to call.
 *
 * Environment variables:
 *   MCC_URL           — e.g. http://mission-control.management.svc.cluster.local
 *   ENVIRONMENT_ID    — Prisma ID of the Environment row in MCC
 *   GATEWAY_TOKEN     — Auth token stored in Environment.gatewayToken
 *   GATEWAY_URL       — This gateway's own URL (reported to MCC), e.g. http://10.2.2.84:3001
 *   PORT              — Port to listen on (default 3001)
 *   GATEWAY_TYPE      — "cluster" | "docker" (controls which built-in tools are registered)
 */

import express, { type Request, type Response, type NextFunction } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { MccClient, type McpToolConfig } from './mcc-client.js'
import { runTool } from './tool-runner.js'
import { kubernetesTools } from './builtin-tools/kubernetes.js'
import { dockerTools } from './builtin-tools/docker.js'

// ── Config ────────────────────────────────────────────────────────────────────

const MCC_URL     = process.env.MCC_URL     ?? ''
const JOIN_TOKEN  = process.env.JOIN_TOKEN  ?? ''
const PORT        = parseInt(process.env.PORT ?? '3001', 10)
const GATEWAY_TYPE = process.env.GATEWAY_TYPE ?? 'cluster'
const GATEWAY_URL  = process.env.GATEWAY_URL ?? `http://localhost:${PORT}`

let ENVIRONMENT_ID = process.env.ENVIRONMENT_ID ?? ''
let GATEWAY_TOKEN  = process.env.GATEWAY_TOKEN  ?? ''

if (!MCC_URL) {
  console.error('[gateway] FATAL: MCC_URL must be set')
  process.exit(1)
}
if (!JOIN_TOKEN && (!ENVIRONMENT_ID || !GATEWAY_TOKEN)) {
  console.error('[gateway] FATAL: Either JOIN_TOKEN or both ENVIRONMENT_ID+GATEWAY_TOKEN must be set')
  process.exit(1)
}

/** Exchange a one-time join token for permanent credentials */
async function joinWithToken(joinToken: string): Promise<void> {
  console.log('[gateway] Joining MCC with join token…')
  const res = await fetch(`${MCC_URL}/api/environments/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ joinToken, gatewayUrl: GATEWAY_URL, gatewayType: GATEWAY_TYPE }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Join failed: ${res.status} ${err}`)
  }
  const data = await res.json()
  ENVIRONMENT_ID = data.environmentId
  GATEWAY_TOKEN  = data.apiToken
  console.log(`[gateway] Joined as environment "${data.environmentName}" (${ENVIRONMENT_ID})`)
}

// ── Built-in tool registry ────────────────────────────────────────────────────

type BuiltinTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string>
}

const BUILTIN_REGISTRY: Record<string, BuiltinTool> = {}

function registerBuiltins(tools: BuiltinTool[]) {
  for (const t of tools) BUILTIN_REGISTRY[t.name] = t
}

if (GATEWAY_TYPE === 'cluster') registerBuiltins(kubernetesTools)
if (GATEWAY_TYPE === 'docker')  registerBuiltins(dockerTools)
// Cluster gateways also expose docker if desired
if (GATEWAY_TYPE === 'cluster' && process.env.ENABLE_DOCKER === 'true') registerBuiltins(dockerTools)

// ── MCC client (constructed after join so credentials are resolved) ───────────

let mcc: MccClient  // initialised in start()

// Tools currently active (refreshed from MCC on heartbeat)
let activeTools: McpToolConfig[] = []

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mission-control-gateway', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, () => {
  const tools = activeTools.map(t => ({
    name:        t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
  return { tools }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  const tool = activeTools.find(t => t.name === name)
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }

  try {
    let result: string
    if (tool.builtIn && BUILTIN_REGISTRY[name]) {
      result = await BUILTIN_REGISTRY[name].execute(args as Record<string, unknown>)
    } else {
      result = await runTool(tool, args as Record<string, unknown>)
    }
    return { content: [{ type: 'text', text: result }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[gateway] Tool ${name} failed:`, msg)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

// ── Express + SSE transport ───────────────────────────────────────────────────

const app = express()
app.use(express.json())

// Simple token auth middleware for REST endpoints
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth || auth !== `Bearer ${GATEWAY_TOKEN}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

// Health check (used by MCC, k8s probes — no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', environmentId: ENVIRONMENT_ID, tools: activeTools.length, type: GATEWAY_TYPE })
})

// REST tool API — used by Ollama/Gemini agents that can't speak MCP natively
app.get('/tools', requireAuth, (_req, res) => {
  res.json(activeTools.map(t => ({
    name:        t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })))
})

app.post('/tools/execute', requireAuth, async (req, res) => {
  const { name, arguments: args = {} } = req.body as { name: string; arguments?: Record<string, unknown> }
  const tool = activeTools.find(t => t.name === name)
  if (!tool) { res.status(404).json({ error: `Unknown tool: ${name}` }); return }

  try {
    let result: string
    if (tool.builtIn && BUILTIN_REGISTRY[name]) {
      result = await BUILTIN_REGISTRY[name].execute(args)
    } else {
      result = await runTool(tool, args)
    }
    res.json({ result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: msg })
  }
})

// MCP SSE endpoint — AI agents connect here
const transports: Map<string, SSEServerTransport> = new Map()

app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/mcp/message', res)
  const sessionId = transport.sessionId
  transports.set(sessionId, transport)
  res.on('close', () => transports.delete(sessionId))
  await server.connect(transport)
})

app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId as string
  const transport = transports.get(sessionId)
  if (!transport) { res.status(404).json({ error: 'Session not found' }); return }
  await transport.handlePostMessage(req, res)
})

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  // Exchange join token for permanent credentials if needed
  if (JOIN_TOKEN) await joinWithToken(JOIN_TOKEN)

  // Construct MCC client now that credentials are resolved
  mcc = new MccClient({ mccUrl: MCC_URL, environmentId: ENVIRONMENT_ID, gatewayToken: GATEWAY_TOKEN, gatewayUrl: GATEWAY_URL })

  // Register with MCC and fetch initial tool config
  await mcc.register()
  activeTools = await mcc.fetchTools()
  console.log(`[gateway] Loaded ${activeTools.length} tools from MCC`)

  // Start heartbeat — refreshes tool config every 30s
  mcc.startHeartbeat((tools) => {
    activeTools = tools
    console.log(`[gateway] Tool config refreshed: ${tools.length} tools`)
  })

  app.listen(PORT, () => {
    console.log(`[gateway] MCP server listening on :${PORT}`)
    console.log(`[gateway] Type: ${GATEWAY_TYPE} | Environment: ${ENVIRONMENT_ID}`)
  })
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[gateway] Shutting down…')
  mcc.stopHeartbeat()
  await mcc.disconnect()
  process.exit(0)
})

start().catch(err => { console.error('[gateway] Startup failed:', err); process.exit(1) })
