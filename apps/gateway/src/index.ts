/**
 * ORION Gateway — MCP Server
 *
 * Runs alongside a cluster, Docker node, or the ORION management host itself.
 * Registers with ORION, fetches tool config, and exposes those tools via the MCP
 * protocol for AI agents to call.
 *
 * Environment variables:
 *   ORION_URL              — e.g. http://orion.management.svc.cluster.local
 *   ENVIRONMENT_ID         — Prisma ID of the Environment row in ORION
 *   GATEWAY_TOKEN          — Auth token stored in Environment.gatewayToken (gateway → ORION,
 *                            and ORION → gateway unless GATEWAY_INBOUND_TOKEN is set)
 *   GATEWAY_INBOUND_TOKEN  — Optional separate token ORION must present to this gateway
 *   GATEWAY_URL            — This gateway's own URL (reported to ORION), e.g. http://10.2.2.9:3001
 *   PORT                   — Port to listen on (default 3001)
 *   GATEWAY_TYPE           — "cluster" | "docker" | "localhost" (controls built-in tools)
 *   GATEWAY_CREDS_FILE     — Path to persist credentials for restart resilience (localhost mode)
 *   POD_NAMESPACE          — Namespace this pod runs in (downward API); falls back to
 *                            GATEWAY_NAMESPACE, then the service-account namespace file
 *   GATEWAY_DEPLOYMENT_NAME — Deployment to restart on /update (default: the pod's `app` label)
 *   ENABLE_VELERO          — "true" to register velero tools even if the binary isn't on PATH
 *   SHUTDOWN_GRACE_MS      — How long SIGTERM waits for in-flight tool calls (default 25000)
 */

// SOC2: [M-004] Wrap console.log BEFORE any other import to catch all log output
import { wrapConsoleLog } from './lib/redact.js'
wrapConsoleLog()

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs'
import path from 'path'
import { randomUUID, timingSafeEqual } from 'crypto'
import { createRequire } from 'module'
import type { Server as HttpServer } from 'http'
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { OrionClient, OrionAuthError, type McpToolConfig } from './orion-client.js'
import { runTool, validateShellTemplate } from './tool-runner.js'
import { emitGatewayAuditEvent, buildAuditEvent } from './gateway-audit.js'
import { HooksEngine } from './hooks-engine.js'
import { SkillLoader } from './skill-loader.js'
import { kubernetesTools } from './builtin-tools/kubernetes.js'
import { dockerTools } from './builtin-tools/docker.js'
import { localhostTools } from './builtin-tools/localhost.js'
import { talosTools } from './builtin-tools/talos.js'
import { knowledgeGraphTools } from './builtin-tools/knowledge-graph.js'
import { securityTools } from './builtin-tools/security.js'
import { trivyTools } from './builtin-tools/trivy.js'
import { discoveryTools } from './builtin-tools/discovery.js'
import { backupTools } from './builtin-tools/backup.js'
import { ArgoCDWatcher } from './argocd-watcher.js'
import { IngressWatcher } from './ingress-watcher.js'
import { DockerComposeWatcher } from './docker-compose-watcher.js'
import { bootstrapArgoCD } from './argocd-bootstrap.js'
import { run } from './lib/run.js'
import { logger, errMsg } from './lib/logger.js'
import { resolveRestTool } from './lib/tool-policy.js'

const _require = createRequire(import.meta.url)
const GATEWAY_VERSION: string = (() => {
  try {
    const pkgPaths = ['/app/package.json', new URL('../package.json', import.meta.url).pathname]
    for (const p of pkgPaths) {
      if (existsSync(p)) return (_require(p) as { version: string }).version
    }
  } catch { /* ignore */ }
  return 'unknown'
})()

// ── Process-level safety nets ────────────────────────────────────────────────
//
// An unhandled rejection used to terminate the process (Node ≥15 default), so a
// single failed background fetch could take the gateway down. Log instead.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: errMsg(reason) }, 'unhandled promise rejection')
})
process.on('uncaughtException', (err) => {
  logger.fatal({ err: errMsg(err), stack: err.stack }, 'uncaught exception — shutting down')
  void shutdown('uncaughtException', 1)
})

// ── Config ────────────────────────────────────────────────────────────────────

const ORION_URL           = process.env.ORION_URL           ?? ''
const JOIN_TOKEN          = process.env.JOIN_TOKEN           ?? ''
const PORT                = parseInt(process.env.PORT ?? '3001', 10)
const GATEWAY_TYPE        = process.env.GATEWAY_TYPE         ?? 'cluster'
const rawGatewayUrl       = process.env.GATEWAY_URL          ?? `http://localhost:${PORT}`
const GATEWAY_URL         = rawGatewayUrl.startsWith('http') ? rawGatewayUrl : `http://${rawGatewayUrl}`
const GATEWAY_SECRET_NAME = process.env.GATEWAY_SECRET_NAME  ?? ''
const GATEWAY_CREDS_FILE  = process.env.GATEWAY_CREDS_FILE   ?? ''
const SHUTDOWN_GRACE_MS   = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '25000', 10)
/** Ready only while heartbeats keep succeeding within this window. */
const READY_HEARTBEAT_WINDOW_MS = 90_000

let ENVIRONMENT_ID = process.env.ENVIRONMENT_ID ?? ''
let GATEWAY_TOKEN  = process.env.GATEWAY_TOKEN  ?? ''

/** Token ORION must present to call this gateway. Separate from the outbound token when configured. */
function inboundToken(): string {
  return process.env.GATEWAY_INBOUND_TOKEN || GATEWAY_TOKEN
}

/**
 * Namespace this gateway runs in. The two deploy paths disagree: the join
 * manifest deploys into `management` (deployment `orion-gateway-<env>`), the
 * cluster bootstrap into `orion-management` (deployment `orion-gateway`). The
 * old code hard-coded `management` for the credential Secret and
 * `orion-management` for /update, so one of the two was always wrong.
 */
function podNamespace(): string {
  if (process.env.POD_NAMESPACE) return process.env.POD_NAMESPACE
  if (process.env.GATEWAY_NAMESPACE) return process.env.GATEWAY_NAMESPACE
  try {
    const ns = readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim()
    if (ns) return ns
  } catch { /* not running in a pod */ }
  return 'management'
}

/** Deployment to restart on /update: explicit env, else this pod's `app` label (both manifests set it). */
async function deploymentName(namespace: string): Promise<string> {
  if (process.env.GATEWAY_DEPLOYMENT_NAME) return process.env.GATEWAY_DEPLOYMENT_NAME
  const podName = process.env.POD_NAME ?? process.env.HOSTNAME
  if (podName) {
    try {
      const { stdout } = await run('kubectl', ['get', 'pod', podName, '-n', namespace, '-o', 'jsonpath={.metadata.labels.app}'], { timeoutMs: 10_000 })
      if (stdout.trim()) return stdout.trim()
    } catch (err) {
      logger.warn({ err: errMsg(err) }, 'could not read own pod labels')
    }
  }
  return 'orion-gateway'
}

/** Discover the node's own infrastructure IP address to replace placeholder GATEWAY_URLs */
async function discoverNodeIp(): Promise<string | null> {
  // Get the pod's node name via kubectl (downward API NODE_NAME may not be set)
  let nodeName = process.env.NODE_NAME
  if (!nodeName) {
    try {
      const podName = process.env.POD_NAME ?? (await run('hostname', [])).stdout.trim()
      nodeName = (await run('kubectl', ['get', 'pod', podName, '-o', 'jsonpath={.spec.nodeName}'])).stdout.trim()
    } catch (err) {
      console.warn('[gateway] Could not get pod node name:', errMsg(err))
    }
  }

  // Try to get InternalIP from the node
  if (nodeName) {
    try {
      const { stdout } = await run('kubectl', ['get', 'node', nodeName, '-o', `jsonpath={.status.addresses[?(@.type=="InternalIP")].address}`])
      const ip = stdout.trim()
      if (ip) {
        console.log(`[gateway] Discovered node IP from InternalIP: ${ip}`)
        return ip
      }
    } catch (err) {
      console.warn(`[gateway] Could not get InternalIP for node ${nodeName}:`, errMsg(err))
    }

    // Fallback: try ExternalIP if InternalIP is missing (some cloud providers)
    try {
      const { stdout } = await run('kubectl', ['get', 'node', nodeName, '-o', `jsonpath={.status.addresses[?(@.type=="ExternalIP")].address}`])
      const ip = stdout.trim()
      if (ip) {
        console.log(`[gateway] Discovered node IP from ExternalIP: ${ip}`)
        return ip
      }
    } catch {
      /* fall through */
    }
  }

  // Final fallback: first non-loopback, non-pod-network IPv4 from hostname -i
  try {
    const { stdout } = await run('hostname', ['-i'])
    const addrs = stdout.trim().split(/\s+/)
    for (const a of addrs) {
      const ip = a.trim()
      // Accept any valid IPv4 that's not loopback or pod network (10.244.x.x)
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('10.244.')) {
        console.log(`[gateway] Discovered node IP from hostname -i: ${ip}`)
        return ip
      }
    }
  } catch (err) {
    console.warn('[gateway] Could not get addresses from hostname -i:', errMsg(err))
  }

  return null
}

let ACTUAL_GATEWAY_URL = GATEWAY_URL

// Stable machine identity — generated once on first boot, persisted in the creds file
// (localhost mode) or K8s Secret (cluster mode). Sent with every join request so ORION
// can verify the fingerprint on re-join and reject stolen tokens.
let MACHINE_ID = process.env.MACHINE_ID ?? ''

interface CredsFile {
  environmentId?: string
  gatewayToken?:  string
  machineId?:     string
}

function readCredsFile(): CredsFile | null {
  if (!GATEWAY_CREDS_FILE) return null
  try {
    return JSON.parse(readFileSync(GATEWAY_CREDS_FILE, 'utf8')) as CredsFile
  } catch {
    return null // File doesn't exist yet — first boot
  }
}

/** Load persisted credentials from a file (used in localhost mode for restart resilience) */
function loadPersistedCredentials(): void {
  const data = readCredsFile()
  if (data?.environmentId && data.gatewayToken) {
    ENVIRONMENT_ID = data.environmentId
    GATEWAY_TOKEN  = data.gatewayToken
    console.log(`[gateway] Loaded persisted credentials from ${GATEWAY_CREDS_FILE}`)
  }
  if (data?.machineId) {
    MACHINE_ID = data.machineId
  }
  // Generate a new machineId if not loaded from file
  if (!MACHINE_ID) {
    MACHINE_ID = randomUUID()
  }
}

/** Write credentials to file (localhost mode). Owner-only: it holds the gateway token. */
function saveCredentialsToFile(): void {
  if (!GATEWAY_CREDS_FILE) return
  try {
    const creds: CredsFile = { environmentId: ENVIRONMENT_ID, gatewayToken: GATEWAY_TOKEN, machineId: MACHINE_ID }
    writeFileSync(GATEWAY_CREDS_FILE, JSON.stringify(creds), { encoding: 'utf8', mode: 0o600 })
    // `mode` only applies when the file is created — tighten a pre-existing 0644 file too.
    chmodSync(GATEWAY_CREDS_FILE, 0o600)
    console.log(`[gateway] Credentials saved to ${GATEWAY_CREDS_FILE}`)
  } catch (err) {
    console.warn('[gateway] Could not save credentials to file:', errMsg(err))
  }
}

if (!ORION_URL) {
  console.error('[gateway] FATAL: ORION_URL must be set')
  process.exit(1)
}

// Validate ORION_URL is a valid URL
try {
  new URL(ORION_URL)
} catch {
  console.error(`[gateway] FATAL: ORION_URL is not a valid URL: ${ORION_URL}`)
  process.exit(1)
}
// Try loading from file before validating (file credentials take precedence over join token)
loadPersistedCredentials()

const WAITING_FOR_SETUP = !JOIN_TOKEN && (!ENVIRONMENT_ID || !GATEWAY_TOKEN)
let waitingTimer: ReturnType<typeof setInterval> | undefined
if (WAITING_FOR_SETUP) {
  console.warn('[gateway] No credentials or join token available — waiting for ORION setup to complete…')
  console.warn('[gateway] Run bootstrap.sh to auto-generate LOCALHOST_JOIN_TOKEN, then restart this container.')
  // Keep alive without crashing so Docker does not apply exponential restart backoff.
  waitingTimer = setInterval(() => {
    console.log('[gateway] Still waiting for join token — restart this container after LOCALHOST_JOIN_TOKEN is set in .env')
  }, 30_000)
}

/** A join/registration failure that retrying cannot fix (bad or used token). */
class FatalStartupError extends Error {}

/** Exchange a one-time join token for permanent credentials */
async function joinWithToken(joinToken: string): Promise<void> {
  console.log('[gateway] Joining ORION with join token…')
  console.log(`[gateway]   ORION_URL: ${ORION_URL}`)
  console.log(`[gateway]   GATEWAY_URL: ${ACTUAL_GATEWAY_URL}`)
  console.log(`[gateway]   GATEWAY_TYPE: ${GATEWAY_TYPE}`)

  const res = await fetch(`${ORION_URL}/api/environments/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ joinToken, gatewayUrl: ACTUAL_GATEWAY_URL, gatewayType: GATEWAY_TYPE, machineId: MACHINE_ID }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const err = await res.text()
    const msg = `Join failed: HTTP ${res.status}: ${err}`
    console.error(`[gateway] ✗ ${msg}`)
    console.error('[gateway] Check:')
    console.error('[gateway]   1. ORION_URL is correct and reachable from this pod')
    console.error('[gateway]   2. JOIN_TOKEN is valid (24h expiry, not already used)')
    console.error('[gateway]   3. Network connectivity: can you curl ORION_URL from the pod?')
    // 4xx (other than timeout/rate-limit) means the token itself is bad — don't retry forever.
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new FatalStartupError(msg)
    }
    throw new Error(msg)
  }
  const data = await res.json()
  ENVIRONMENT_ID = data.environmentId
  GATEWAY_TOKEN  = data.apiToken
  console.log(`[gateway] ✓ Joined as environment "${data.environmentName}" (${ENVIRONMENT_ID})`)
  await persistCredentials()
  saveCredentialsToFile()
}

/** Persist permanent credentials into the K8s Secret so restarts skip re-join */
async function persistCredentials(): Promise<void> {
  if (!GATEWAY_SECRET_NAME || !ENVIRONMENT_ID || !GATEWAY_TOKEN) return
  const patch = JSON.stringify({ stringData: { 'environment-id': ENVIRONMENT_ID, 'gateway-token': GATEWAY_TOKEN, 'machine-id': MACHINE_ID } })
  const namespace = podNamespace()
  try {
    await run('kubectl', [
      'patch', 'secret', GATEWAY_SECRET_NAME,
      '-n', namespace,
      '--type=merge',
      '-p', patch,
    ])
    console.log(`[gateway] Credentials persisted to secret ${namespace}/${GATEWAY_SECRET_NAME}`)
  } catch (err) {
    // Non-fatal — gateway still works this session; log and continue
    console.warn('[gateway] Could not persist credentials to secret:', errMsg(err))
  }
}

// ── Built-in tool registry ────────────────────────────────────────────────────

type BuiltinToolCtx = {
  agentId?: string
  userId?: string
  actorType?: 'agent' | 'human'
}

type BuiltinTool = {
  name: string
  description: string
  category: string
  inputSchema: Record<string, unknown>
  // ctx is optional so tools that don't need attribution still work,
  // but localhost tools use it for executor actor attribution (B3 fix).
  execute: (args: Record<string, unknown>, ctx?: BuiltinToolCtx) => Promise<string>
}

const BUILTIN_REGISTRY: Record<string, BuiltinTool> = {}

function registerBuiltins(tools: BuiltinTool[]) {
  for (const t of tools) BUILTIN_REGISTRY[t.name] = t
}

function binaryOnPath(bin: string): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && existsSync(path.join(dir, bin)))
}

// velero isn't in the gateway image by default; registering its tools anyway
// made every velero_* call fail with ENOENT.
const VELERO_AVAILABLE = process.env.ENABLE_VELERO === 'true' || binaryOnPath('velero')
if (!VELERO_AVAILABLE && (GATEWAY_TYPE === 'cluster' || GATEWAY_TYPE === 'localhost')) {
  logger.info('velero not found on PATH — backup tools not registered (set ENABLE_VELERO=true to force)')
}

if (GATEWAY_TYPE === 'cluster') {
  registerBuiltins(kubernetesTools); registerBuiltins(talosTools); registerBuiltins(knowledgeGraphTools); registerBuiltins(discoveryTools)
  if (VELERO_AVAILABLE) registerBuiltins(backupTools)
}
if (GATEWAY_TYPE === 'docker')   { registerBuiltins(dockerTools); registerBuiltins(discoveryTools) }
// localhost = the gateway co-located with ORION on the management host.
// It can talk to the local cluster directly, so it gets the full cluster + talos toolset
// plus docker/localhost tools for managing the host itself.
if (GATEWAY_TYPE === 'localhost') {
  registerBuiltins(knowledgeGraphTools)
  registerBuiltins(kubernetesTools)
  registerBuiltins(talosTools)
  registerBuiltins(dockerTools)
  registerBuiltins(localhostTools)
  registerBuiltins(discoveryTools)
  if (VELERO_AVAILABLE) registerBuiltins(backupTools)
}
// Cluster gateways also expose docker if desired
if (GATEWAY_TYPE === 'cluster' && process.env.ENABLE_DOCKER === 'true') registerBuiltins(dockerTools)

// Security tools — always available (HTTP-based, call external monitoring)
registerBuiltins(securityTools)

// Trivy CVE scan tools (Phase 3 PR11). Only registered when trivy is
// installed in the gateway image — env flag avoids surfacing tools that
// can't actually run. docker-type gateways get all three (image, k8s, host);
// cluster-type gateways get image + k8s (no host rootfs from inside a pod).
if (process.env.ENABLE_TRIVY === 'true') {
  if (GATEWAY_TYPE === 'cluster') {
    registerBuiltins(trivyTools.filter((t) => t.name !== 'trivy_scan_host') as any)
  } else {
    registerBuiltins(trivyTools as any)
  }
}

// ── Runtime state ────────────────────────────────────────────────────────────

let orion: OrionClient | undefined   // initialised in start()
let argoCdWatcher:  ArgoCDWatcher  | undefined
let ingressWatcher: IngressWatcher | undefined
let dockerWatcher: DockerComposeWatcher | undefined
let hooksEngine:  HooksEngine  | undefined
let skillLoader:  SkillLoader | undefined
let httpServer:   HttpServer | undefined

// Tools currently active (refreshed from ORION on heartbeat)
let activeTools: McpToolConfig[] = []
/** True once ORION's tool policy has been fetched at least once — never inferred from activeTools.length. */
let toolsLoaded = false
let registeredAt = 0
let shuttingDown = false
let inFlight = 0

/** Apply a tool list from ORION, dropping shell tools whose templates are unsafe. */
function applyTools(tools: McpToolConfig[]): void {
  activeTools = tools.filter(t => {
    if (t.execType !== 'shell') return true
    const err = validateShellTemplate(String(t.execConfig?.command ?? ''))
    if (err) logger.error({ tool: t.name, reason: err }, 'rejecting shell tool with unsafe command template')
    return !err
  })
  toolsLoaded = true
}

/** Count a tool execution so SIGTERM can wait for it to finish. */
async function trackInFlight<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
  }
}

// ── Caller identity ──────────────────────────────────────────────────────────
//
// Identity comes from headers ORION sets on its (bearer-authenticated) calls —
// never from the request body, which the caller fully controls. The executor
// records this as the actor, so the body field `agent` must not be trusted.

const ACTOR_ID_HEADER   = 'x-orion-actor-id'
const ACTOR_TYPE_HEADER = 'x-orion-actor-type'

function headerValue(h: unknown): string | undefined {
  const v = Array.isArray(h) ? h[0] : h
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : undefined
}

function actorFromHeaders(headers: Record<string, unknown> | undefined): BuiltinToolCtx {
  const agentId = headerValue(headers?.[ACTOR_ID_HEADER])
  const type = headerValue(headers?.[ACTOR_TYPE_HEADER])
  return {
    agentId,
    actorType: type === 'human' ? 'human' : type === 'agent' ? 'agent' : agentId ? 'agent' : 'human',
  }
}

// ── MCP server (one per connection) ──────────────────────────────────────────
//
// A single shared Server can only be connected to one transport: the SDK throws
// "Already connected to a transport" on the second connect, which crashed the
// gateway via an unhandled rejection. Each MCP connection now gets its own Server.

function createMcpServer(): Server {
  const server = new Server(
    { name: 'orion-gateway', version: GATEWAY_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: activeTools.map(t => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params
    const tool = activeTools.find(t => t.name === name)
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }

    const headerCtx = actorFromHeaders(extra.requestInfo?.headers as Record<string, unknown> | undefined)
    const ctx: BuiltinToolCtx = headerCtx.agentId
      ? headerCtx
      : { agentId: `mcp-session:${extra.sessionId ?? 'stateless'}`, actorType: 'agent' }
    const agent = ctx.agentId ?? 'unknown'

    try {
      const result = await trackInFlight(() =>
        tool.builtIn && BUILTIN_REGISTRY[name]
          ? BUILTIN_REGISTRY[name].execute(args as Record<string, unknown>, ctx)
          : runTool(tool, args as Record<string, unknown>),
      )
      emitGatewayAuditEvent(buildAuditEvent({ toolName: name, result, args, error: false, agent }))
      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      const msg = errMsg(err)
      try {
        emitGatewayAuditEvent(buildAuditEvent({ toolName: name, result: `Error: ${msg}`, args, error: true, agent }))
      } catch { /* ignored */ }
      logger.error({ tool: name, err: msg }, 'MCP tool call failed')
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
    }
  })

  return server
}

// ── Express ──────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '5mb' }))

/** Express 4 does not catch async handler rejections — route them to the error handler. */
function asyncRoute(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { fn(req, res).catch(next) }
}

// Refuse new work while draining for shutdown (health endpoints stay up).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (shuttingDown && !['/health', '/livez', '/readyz'].includes(req.path)) {
    res.status(503).set('Connection', 'close').json({ error: 'Gateway is shutting down' })
    return
  }
  next()
})

// Token auth for REST/MCP endpoints.
// SOC2 [timing-attack]: constant-time comparison (=== leaks the matching prefix length).
function requireAuth(req: Request, res: Response, next: NextFunction) {
  // M2 fix: an empty token makes expected = 'Bearer ', which any request with that
  // exact header would pass. Fail closed until credentials exist.
  const token = inboundToken()
  if (!token) {
    res.status(503).json({ error: 'Gateway not configured: GATEWAY_TOKEN not set' })
    return
  }
  const auth = req.headers.authorization
  if (!auth || !timingSafeCompare(auth, `Bearer ${token}`)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

/** Constant-time string comparison to prevent timing attacks */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Liveness — the process is up and serving HTTP. Unauthenticated, so it reveals
// nothing about the environment (environmentId used to be included).
const livez = (_req: Request, res: Response) => { res.json({ status: 'ok' }) }
app.get('/livez', livez)
app.get('/health', livez) // back-compat: existing k8s probes and ORION use /health

// Readiness — registered with ORION, tool policy loaded, and heartbeats succeeding.
app.get('/readyz', (_req: Request, res: Response) => {
  const lastOk = Math.max(orion?.lastHeartbeatAt ?? 0, registeredAt)
  let reason: string | undefined
  if (shuttingDown) reason = 'shutting down'
  else if (!registeredAt) reason = WAITING_FOR_SETUP ? 'waiting for setup' : 'not registered with ORION'
  else if (!toolsLoaded) reason = 'tool policy not loaded'
  else if (Date.now() - lastOk > READY_HEARTBEAT_WINDOW_MS) reason = 'heartbeat to ORION failing'
  if (reason) {
    res.status(503).json({ status: 'not_ready', reason })
    return
  }
  res.json({ status: 'ready' })
})

// REST tool API — used by Ollama/Gemini agents that can't speak MCP natively
app.get('/tools', requireAuth, (_req: Request, res: Response) => {
  res.json(activeTools.map(t => ({
    name:        t.name,
    description: t.description,
    category:    BUILTIN_REGISTRY[t.name]?.category ?? 'general',
    inputSchema: t.inputSchema,
  })))
})

app.post('/tools/execute', requireAuth, asyncRoute(async (req: Request, res: Response) => {
  const { name, arguments: args = {} } = (req.body ?? {}) as { name?: string; arguments?: Record<string, unknown> }
  if (typeof name !== 'string' || !name) { res.status(400).json({ error: 'name is required' }); return }

  // B1 fix: built-ins must be enabled by ORION's policy, same as the MCP path.
  // Fails closed (503) until the policy has been fetched — see resolveRestTool.
  const decision = resolveRestTool(name, { toolsLoaded, activeTools, registry: BUILTIN_REGISTRY })
  if ('status' in decision) { res.status(decision.status).json({ error: decision.error }); return }

  const ctx = actorFromHeaders(req.headers as Record<string, unknown>)
  const agent = ctx.agentId ?? 'rest-client'
  try {
    const result = await trackInFlight(() =>
      decision.kind === 'builtin' ? decision.builtin.execute(args, ctx) : runTool(decision.tool, args),
    )
    emitGatewayAuditEvent(buildAuditEvent({ toolName: name, result, args, error: false, agent }))
    res.json({ result })
  } catch (e) {
    const msg = errMsg(e)
    try {
      emitGatewayAuditEvent(buildAuditEvent({ toolName: name, result: `Error: ${msg}`, args, error: true, agent }))
    } catch { /* ignored */ }
    res.status(500).json({ error: msg })
  }
}))

// Self-update endpoint — triggers a rolling restart so the pod is replaced with the latest image
app.post('/update', requireAuth, (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Update triggered — gateway will restart shortly' })
  // Defer the restart so the HTTP response is sent first
  setTimeout(() => {
    void (async () => {
      try {
        if (GATEWAY_TYPE === 'cluster') {
          // Rolling restart: Kubernetes pulls the latest image and replaces the pod
          const namespace = podNamespace()
          const deployment = await deploymentName(namespace)
          await run('kubectl', ['rollout', 'restart', `deployment/${deployment}`, '-n', namespace])
          logger.info({ namespace, deployment }, 'rolling restart triggered via kubectl')
        } else {
          // localhost/docker: exit so Docker restarts the container
          logger.info('exiting for Docker restart (update requested)')
          await shutdown('update', 0)
        }
      } catch (err) {
        logger.error({ err: errMsg(err) }, 'self-update failed')
      }
    })()
  }, 500)
})

// ── MCP transports ───────────────────────────────────────────────────────────
//
// POST /mcp            — Streamable HTTP (stateless: fresh Server + transport per request)
// GET  /mcp            — legacy SSE stream (deprecated transport, kept for existing clients)
// POST /mcp/message    — legacy SSE message channel
// SOC2 [gateway-auth]: all require authentication.

const sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>()

app.post('/mcp', requireAuth, asyncRoute(async (req: Request, res: Response) => {
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close().catch(() => {})
    void server.close().catch(() => {})
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}))

app.delete('/mcp', requireAuth, (_req: Request, res: Response) => {
  res.status(405).json({ error: 'Stateless MCP endpoint — no session to delete' })
})

app.get('/mcp', requireAuth, asyncRoute(async (_req: Request, res: Response) => {
  const server = createMcpServer()
  const transport = new SSEServerTransport('/mcp/message', res)
  const sessionId = transport.sessionId
  sseSessions.set(sessionId, { transport, server })
  res.on('close', () => {
    sseSessions.delete(sessionId)
    void server.close().catch(() => {})
  })
  await server.connect(transport)
}))

app.post('/mcp/message', requireAuth, asyncRoute(async (req: Request, res: Response) => {
  const session = sseSessions.get(String(req.query.sessionId ?? ''))
  if (!session) { res.status(404).json({ error: 'Session not found' }); return }
  // express.json() has already consumed the body stream — hand the parsed body over.
  await session.transport.handlePostMessage(req, res, req.body)
}))

// Error handler for asyncRoute rejections (must be registered last).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err: errMsg(err) }, 'request failed')
  if (!res.headersSent) res.status(500).json({ error: 'Internal gateway error' })
})

// ── Startup ───────────────────────────────────────────────────────────────────

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let delay = 1_000
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof FatalStartupError || err instanceof OrionAuthError || shuttingDown) throw err
      logger.warn({ err: errMsg(err), retryInMs: delay }, `${label} failed — retrying`)
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * 2, 60_000)
    }
  }
}

/** 401/403 from ORION: pick up a rotated token from the creds file, else stop serving. */
function handleAuthFailure(err: OrionAuthError): void {
  const creds = readCredsFile()
  if (creds?.gatewayToken && creds.gatewayToken !== GATEWAY_TOKEN && orion) {
    logger.warn('ORION rejected the gateway token — reloaded a rotated token from the credentials file')
    GATEWAY_TOKEN = creds.gatewayToken
    orion.setGatewayToken(GATEWAY_TOKEN)
    startHeartbeat()
    return
  }
  logger.fatal({ status: err.status }, 'ORION rejected the gateway credentials (revoked or rotated) — shutting down')
  void shutdown('auth-failure', 1)
}

function startHeartbeat(): void {
  orion?.startHeartbeat((tools) => {
    applyTools(tools)
    logger.debug({ tools: activeTools.length }, 'tool config refreshed')
  }, 30_000, GATEWAY_VERSION, handleAuthFailure)
}

function listen(): Promise<void> {
  return new Promise(resolve => {
    httpServer = app.listen(PORT, () => {
      logger.info({ port: PORT, version: GATEWAY_VERSION }, 'gateway listening')
      resolve()
    })
  })
}

async function start() {
  // Listen first so /livez and /readyz answer while registration retries; tool
  // endpoints fail closed (503) until credentials and tool policy are loaded.
  await listen()
  if (WAITING_FOR_SETUP) return

  // Resolve placeholder GATEWAY_URL (e.g. http://<node-ip>:30001) to NodePort URL
  // Always use the NodePort pattern so the gateway is reachable from outside the cluster
  if (GATEWAY_URL.includes('<node-ip>') || GATEWAY_URL.match(/^\d+\.\d+\.\d+\.\d+:\d+$/)) {
    console.log(`[gateway] Resolving GATEWAY_URL placeholder: ${GATEWAY_URL}`)
    const nodeIp = await discoverNodeIp()
    if (nodeIp) {
      // Use port 30001 (NodePort) so ORION can reach the gateway from outside the cluster
      ACTUAL_GATEWAY_URL = `http://${nodeIp}:30001`
      console.log(`[gateway] Resolved GATEWAY_URL: ${ACTUAL_GATEWAY_URL}`)
    } else {
      console.error('[gateway] Could not discover node IP for GATEWAY_URL. Check:')
      console.error('[gateway]   1. NODE_NAME / POD_NAME env vars are set or pod is in a namespace')
      console.error('[gateway]   2. kubectl access works (ServiceAccount has permissions)')
      console.error('[gateway]   3. Node has an InternalIP address (check: kubectl get nodes -o wide)')
      console.error('[gateway]   4. hostname -i returns a valid IPv4 address')
      console.error('[gateway] GATEWAY_URL remains a placeholder; ORION will not be able to reach this gateway.')
    }
  }

  // Use persisted credentials if available, otherwise exchange join token
  if (ENVIRONMENT_ID && GATEWAY_TOKEN) {
    console.log(`[gateway] Using persisted credentials for environment ${ENVIRONMENT_ID}`)
  } else if (JOIN_TOKEN) {
    await withRetry('join', () => joinWithToken(JOIN_TOKEN))
  }

  // Construct ORION client now that credentials are resolved
  const client = new OrionClient({ mccUrl: ORION_URL, environmentId: ENVIRONMENT_ID, gatewayToken: GATEWAY_TOKEN, gatewayUrl: ACTUAL_GATEWAY_URL })
  orion = client

  console.log(`[gateway] Version: ${GATEWAY_VERSION}`)
  await withRetry('register', () => client.register(GATEWAY_VERSION))
  applyTools(await withRetry('fetchTools', () => client.fetchTools()))
  registeredAt = Date.now()
  logger.info({ tools: activeTools.length, environmentId: ENVIRONMENT_ID }, 'registered with ORION and loaded tools')

  // Heartbeat — refreshes tool config every 30s
  startHeartbeat()

  // Hooks engine and skill loader — poll ORION for Nebula config
  hooksEngine = new HooksEngine(client)
  skillLoader = new SkillLoader()
  await hooksEngine.start(ENVIRONMENT_ID)
  await skillLoader.load(ENVIRONMENT_ID, client).catch(err => logger.warn({ err: errMsg(err) }, 'skill loader failed'))

  // ArgoCD + Ingress watchers for K8s clusters
  if (GATEWAY_TYPE === 'cluster') {
    // Bootstrap ArgoCD into the cluster (idempotent — safe on every restart)
    bootstrapArgoCD(ORION_URL, ENVIRONMENT_ID, GATEWAY_TOKEN).catch(err =>
      console.error('[gateway] ArgoCD bootstrap failed (non-fatal):', errMsg(err))
    )

    argoCdWatcher = new ArgoCDWatcher(async (apps) => { await client.reportSyncStatus(apps) })
    argoCdWatcher.start()

    ingressWatcher = new IngressWatcher(async (ingresses) => { await client.reportIngresses(ingresses) })
    ingressWatcher.start()
  }

  if (GATEWAY_TYPE === 'docker' || GATEWAY_TYPE === 'localhost') {
    dockerWatcher = new DockerComposeWatcher(async (apps) => { await client.reportSyncStatus(apps) })
    dockerWatcher.start()
  }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────
//
// Do NOT call orion.disconnect() here: on rolling deploys the new pod registers
// before the old one shuts down, so disconnect() would race and mark the env as
// disconnected. The heartbeat self-heals status within 30s anyway.

async function shutdown(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ reason, inFlight }, 'shutting down')

  if (waitingTimer) clearInterval(waitingTimer)
  argoCdWatcher?.stop()
  ingressWatcher?.stop()
  dockerWatcher?.stop()
  orion?.stopHeartbeat()   // orion is undefined in WAITING_FOR_SETUP mode
  hooksEngine?.stop()

  // Stop accepting connections; close long-lived SSE streams so close() can finish.
  httpServer?.close()
  for (const { transport, server } of sseSessions.values()) {
    void transport.close().catch(() => {})
    void server.close().catch(() => {})
  }

  // Let in-flight tool calls finish, bounded by the grace period.
  const deadline = Date.now() + SHUTDOWN_GRACE_MS
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
  }
  if (inFlight > 0) logger.warn({ inFlight }, 'grace period expired with tool calls still running')
  process.exit(code)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })

start().catch(err => {
  logger.fatal({ err: errMsg(err) }, 'startup failed')
  void shutdown('startup-failed', 1)
})
