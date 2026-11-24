/**
 * Client for the agent dispatcher's request API (external service; a coding
 * agent works a request and opens a PR the owner reviews).
 *
 *   POST {DISPATCHER_REQUESTS_URL}/api/v1/requests   Authorization: Bearer <token>
 *     body { repo: "<owner/name>", ref: "<1-64 of [A-Za-z0-9_-]>", title: "<=120", problem: "<=8000", evidence: "<=20000" }
 *     202 { task_id, branch, state } | 409 { error, task_id, branch, pr_url } (ref still open)
 *     429 a limit was reached | 503 paused or review gate off | 400 invalid | 401 bad token | 404 feature off
 *   GET  {DISPATCHER_REQUESTS_URL}/api/v1/requests   -> overview + per-request state, gate and usage
 *
 * Off (no network call) unless DISPATCHER_REQUESTS_URL, DISPATCHER_REQUESTS_TOKEN
 * and DISPATCHER_REQUESTS_REPO are all set. TLS is verified normally. The token
 * is only ever sent in the Authorization header, never logged.
 */

const TIMEOUT_MS = 15_000

export interface DispatcherUsage {
  cost_usd: number
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  attempts: number
}

export interface DispatcherRequest {
  ref: string
  repo: string
  branch: string
  created: string
  task_id: string
  state: string
  pr_url: string | null
  gate: { state: string; round: number; owner_merges: boolean } | null
  usage: DispatcherUsage | null
}

export interface DispatcherOverview {
  configured: boolean
  paused: boolean
  last_24h: number
  max_per_day: number
  open: number
  max_open: number
  usd_last_24h: number
  max_usd_per_day: number
  usage_last_24h: unknown
  requests: DispatcherRequest[]
}

export interface NewRequest { ref: string; title: string; problem: string; evidence: string }
export interface Accepted { task_id: string; branch: string; state: string }

export type ListResult =
  | { ok: true; overview: DispatcherOverview }
  | { ok: false; reason: 'not_configured' | 'unauthorized' | 'disabled' | 'unavailable' | 'error'; status?: number }

export type CreateResult =
  | { ok: true; outcome: 'accepted'; request: Accepted }
  | { ok: true; outcome: 'duplicate'; request: { task_id: string; branch: string; pr_url: string | null } }
  | { ok: false; reason: 'not_configured' | 'limit' | 'paused' | 'invalid' | 'unauthorized' | 'disabled' | 'error'; status?: number; detail?: string }

interface Config { url: string; token: string; repo: string }

export function dispatcherConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const url = env.DISPATCHER_REQUESTS_URL?.trim().replace(/\/+$/, '')
  const token = env.DISPATCHER_REQUESTS_TOKEN?.trim()
  const repo = env.DISPATCHER_REQUESTS_REPO?.trim()
  return url && token && repo ? { url, token, repo } : null
}

export const isDispatcherConfigured = () => dispatcherConfig() !== null

interface ReplyBody { error?: unknown; task_id?: string; branch?: string; state?: string; pr_url?: string | null; requests?: unknown }

async function call(cfg: Config, method: 'GET' | 'POST', body?: unknown): Promise<{ status: number; json: ReplyBody | null }> {
  const res = await fetch(`${cfg.url}/api/v1/requests`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

// Log the error name, message and the network cause (fetch puts ECONNREFUSED, ENOTFOUND or a
// certificate error there), with the token scrubbed in case a message echoes it.
function describeError(cfg: Config, e: unknown): string {
  if (!(e instanceof Error)) return 'unknown error'
  const cause = e.cause instanceof Error ? ` (${(e.cause as { code?: string }).code ?? ''} ${e.cause.message})` : ''
  return `${e.name}: ${e.message}${cause}`.split(cfg.token).join('[REDACTED]')
}
const logFailure = (cfg: Config, what: string, e: unknown) =>
  console.error(`[dispatcher-requests] ${what} failed: ${describeError(cfg, e)}`)

export async function listRequests(): Promise<ListResult> {
  const cfg = dispatcherConfig()
  if (!cfg) return { ok: false, reason: 'not_configured' }
  try {
    const { status, json } = await call(cfg, 'GET')
    if (status === 200 && json && Array.isArray(json.requests)) {
      const requests = (json.requests as unknown[]).filter((r): r is DispatcherRequest =>
        !!r && typeof r === 'object' && typeof (r as DispatcherRequest).ref === 'string' && typeof (r as DispatcherRequest).task_id === 'string')
      return { ok: true, overview: { ...(json as unknown as DispatcherOverview), requests } }
    }
    if (status === 401) return { ok: false, reason: 'unauthorized', status }
    if (status === 404) return { ok: false, reason: 'disabled', status }
    if (status === 503) return { ok: false, reason: 'unavailable', status }
    return { ok: false, reason: 'error', status }
  } catch (e) {
    logFailure(cfg, 'list', e)
    return { ok: false, reason: 'error' }
  }
}

export async function createRequest(req: NewRequest): Promise<CreateResult> {
  const cfg = dispatcherConfig()
  if (!cfg) return { ok: false, reason: 'not_configured' }
  try {
    const { status, json } = await call(cfg, 'POST', { repo: cfg.repo, ...req })
    if (status === 202 && json?.task_id) return { ok: true, outcome: 'accepted', request: { task_id: json.task_id, branch: json.branch ?? '', state: json.state ?? '' } }
    if (status === 409 && json?.task_id) return { ok: true, outcome: 'duplicate', request: { task_id: json.task_id, branch: json.branch ?? '', pr_url: json.pr_url ?? null } }
    const reason = ({ 429: 'limit', 503: 'paused', 400: 'invalid', 401: 'unauthorized', 404: 'disabled' } as const)[status as 429 | 503 | 400 | 401 | 404]
    // The dispatcher's error text for a 400 (token scrubbed, capped) tells a bad repo setting from a bad request.
    const detail = status === 400 && typeof json?.error === 'string' ? json.error.split(cfg.token).join('[REDACTED]').slice(0, 200) : undefined
    return { ok: false, reason: reason ?? 'error', status, ...(detail ? { detail } : {}) }
  } catch (e) {
    logFailure(cfg, 'create', e)
    return { ok: false, reason: 'error' }
  }
}
