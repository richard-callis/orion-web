/**
 * ORION Gateway — MCP Server
 *
 * Runs alongside a cluster, Docker node, or the ORION management host itself.
 * Registers with ORION, fetches tool config, and exposes those tools via the MCP
 * protocol for AI agents to call.
 *
 * Environment variables:
 *   ORION_URL           — e.g. http://orion.management.svc.cluster.local
 *   ENVIRONMENT_ID    — Prisma ID of the Environment row in ORION
 *   GATEWAY_TOKEN     — Auth token stored in Environment.gatewayToken
 *   GATEWAY_URL       — This gateway's own URL (reported to ORION), e.g. http://10.2.2.9:3001
 *   PORT              — Port to listen on (default 3001)
 *   GATEWAY_TYPE      — "cluster" | "docker" | "localhost" (controls built-in tools)
 *   GATEWAY_CREDS_FILE — Path to persist credentials for restart resilience (localhost mode)
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync } from 'fs'
import express, { type Request, type Response, type NextFunction } from 'express'

const execFileAsync = promisify(execFile)
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { OrionClient, type McpToolConfig } from './orion-client.js'
import { runTool } from './tool-runner.js'
import { kubernetesTools } from './builtin-tools/kubernetes.js'
import { dockerTools } from './builtin-tools/docker.js'
import { localhostTools } from './builtin-tools/localhost.js'
import { ArgoCDWatcher } from './argocd-watcher.js'
import { IngressWatcher } from './ingress-watcher.js'

// ── Config ────────────────────────────────────────────────────────────────────

const ORION_URL           = process.env.ORION_URL           ?? ''
const JOIN_TOKEN          = process.env.JOIN_TOKEN           ?? ''
const PORT                = parseInt(process.env.PORT ?? '3001', 10)
const GATEWAY_TYPE        = process.env.GATEWAY_TYPE         ?? 'cluster'
const rawGatewayUrl       = process.env.GATEWAY_URL          ?? `http://localhost:${PORT}`
const GATEWAY_URL         = rawGatewayUrl.startsWith('http') ? rawGatewayUrl : `http://${rawGatewayUrl}`
const GATEWAY_SECRET_NAME = process.env.GATEWAY_SECRET_NAME  ?? ''
const GATEWAY_CREDS_FILE  = process.env.GATEWAY_CREDS_FILE   ?? ''

let ENVIRONMENT_ID = process.env.ENVIRONMENT_ID ?? ''
let GATEWAY_TOKEN  = process.env.GATEWAY_TOKEN  ?? ''

/** Load persisted credentials from a file (used in localhost mode for restart resilience) */
function loadPersistedCredentials(): void {
  if (!GATEWAY_CREDS_FILE) return
  try {
    const data = JSON.parse(readFileSync(GATEWAY_CREDS_FILE, 'utf8')) as { environmentId?: string; gatewayToken?: string }
    if (data.environmentId && data.gatewayToken) {
      ENVIRONMENT_ID = data.environmentId
      GATEWAY_TOKEN  = data.gatewayToken
      console.log(`[gateway] Loaded persisted credentials from ${GATEWAY_CREDS_FILE}`)
    }
  } catch {
    // File doesn't exist yet — first boot
  }
}

/** Write credentials to file (localhost mode) */
function saveCredentialsToFile(): void {
  if (!GATEWAY_CREDS_FILE) return
  try {
    writeFileSync(GATEWAY_CREDS_FILE, JSON.stringify({ environmentId: ENVIRONMENT_ID, gatewayToken: GATEWAY_TOKEN }), 'utf8')
    console.log(`[gateway] Credentials saved to ${GATEWAY_CREDS_FILE}`)
  } catch (err) {
    console.warn('[gateway] Could not save credentials to file:', err instanceof Error ? err.message : String(err))
  }
}

if (!ORION_URL) {
  console.error('[gateway] FATAL: ORION_URL must be set')
  process.exit(1)
}
// Try loading from file before validating (file credentials take precedence over join token)
loadPersistedCredentials()

const WAITING_FOR_SETUP = !JOIN_TOKEN && (!ENVIRONMENT_ID || !GATEWAY_TOKEN)
if (WAITING_FOR_SETUP) {
  console.warn('[gateway] No credentials or join token available — waiting for ORION setup to complete…')
  console.warn('[gateway] Run bootstrap.sh to auto-generate LOCALHOST_JOIN_TOKEN, then restart this container.')
  // Keep alive without crashing so Docker does not apply exponential restart backoff.
  setInterval(() => {
    console.log('[gateway] Still waiting for join token — restart this container after LOCALHOST_JOIN_TOKEN is set in .env')
  }, 30_000)
}

/** Exchange a one-time join token for permanent credentials */
async function joinWithToken(joinToken: string): Promise<void> {
  console.log('[gateway] Joining ORION with join token…')
  const res = await fetch(`${ORION_URL}/api/environments/join`, {
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
  await persistCredentials()
  saveCredentialsToFile()
}

/** Persist permanent credentials into the K8s Secret so restarts skip re-join */
async function persistCredentials(): Promise<void> {
  if (!GATEWAY_SECRET_NAME || !ENVIRONMENT_ID || !GATEWAY_TOKEN) return
  const patch = JSON.stringify({ stringData: { 'environment-id': ENVIRONMENT_ID, 'gateway-token': GATEWAY_TOKEN } })
  try {
    await execFileAsync('kubectl', [
      'patch', 'secret', GATEWAY_SECRET_NAME,
      '-n', 'management',
      '--type=merge',
      '-p', patch,
    ])
    console.log(`[gateway] Credentials persisted to secret ${GATEWAY_SECRET_NAME}`)
  } catch (err) {
    // Non-fatal — gateway still works this session; log and continue
    console.warn('[gateway] Could not persist credentials to secret:', err instanceof Error ? err.message : String(err))
  }
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

if (GATEWAY_TYPE === 'cluster')   registerBuiltins(kubernetesTools)
if (GATEWAY_TYPE === 'docker')    registerBuiltins(dockerTools)
if (GATEWAY_TYPE === 'localhost') { registerBuiltins(dockerTools); registerBuiltins(localhostTools) }
// Cluster gateways also expose docker if desired
if (GATEWAY_TYPE === 'cluster' && process.env.ENABLE_DOCKER === 'true') registerBuiltins(dockerTools)

// ── ORION client (constructed after join so credentials are resolved) ───────────

let orion: OrionClient              // initialised in start()
let argoCdWatcher:  ArgoCDWatcher  | undefined
let ingressWatcher: IngressWatcher | undefined

// Tools currently active (refreshed from ORION on heartbeat)
let activeTools: McpToolConfig[] = []

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'orion-gateway', version: '1.0.0' },
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

// Health check (used by ORION, k8s probes — no auth required)
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
  // Use persisted credentials if available, otherwise exchange join token
  if (ENVIRONMENT_ID && GATEWAY_TOKEN) {
    console.log(`[gateway] Using persisted credentials for environment ${ENVIRONMENT_ID}`)
  } else if (JOIN_TOKEN) {
    await joinWithToken(JOIN_TOKEN)
  }

  // Construct ORION client now that credentials are resolved
  orion = new OrionClient({ mccUrl: ORION_URL, environmentId: ENVIRONMENT_ID, gatewayToken: GATEWAY_TOKEN, gatewayUrl: GATEWAY_URL })

  // Register with ORION and fetch initial tool config
  await orion.register()
  activeTools = await orion.fetchTools()
  console.log(`[gateway] Loaded ${activeTools.length} tools from ORION`)

  // Start heartbeat — refreshes tool config every 30s
  orion.startHeartbeat((tools) => {
    activeTools = tools
    console.log(`[gateway] Tool config refreshed: ${tools.length} tools`)
  })

  // Start ArgoCD + Ingress watchers for K8s clusters
  if (GATEWAY_TYPE === 'cluster') {
    argoCdWatcher = new ArgoCDWatcher(
      async (apps) => { await orion.reportSyncStatus(apps) },
    )
    argoCdWatcher.start()

    ingressWatcher = new IngressWatcher(
      async (ingresses) => { await orion.reportIngresses(ingresses) },
    )
    ingressWatcher.start()
  }

  app.listen(PORT, () => {
    console.log(`[gateway] MCP server listening on :${PORT}`)
    console.log(`[gateway] Type: ${GATEWAY_TYPE} | Environment: ${ENVIRONMENT_ID}`)
  })
}

// Graceful shutdown — do NOT call disconnect() here.
// On rolling deploys the new pod registers before the old one shuts down,
// so calling disconnect() would race and mark the env as disconnected.
// The heartbeat self-heals status within 30s anyway.
process.on('SIGTERM', () => {
  console.log('[gateway] Shutting down…')
  argoCdWatcher?.stop()
  ingressWatcher?.stop()
  orion.stopHeartbeat()
  process.exit(0)
})

if (!WAITING_FOR_SETUP) {
  start().catch(err => { console.error('[gateway] Startup failed:', err); process.exit(1) })
}
