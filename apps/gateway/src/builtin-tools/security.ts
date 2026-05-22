import { promisify } from 'util'
import { execFile } from 'child_process'
import { redactSensitive } from '../lib/redact'

const exec = promisify(execFile)

// ── Validation helpers ────────────────────────────────────────────────────────

// IPv4 dotted-quad (0–255 per octet) — accepts no CIDR suffix.
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/
// IPv6 (loose: hex groups with optional :: shorthand). Sufficient for validation gate.
const IPV6_RE = /^(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,7}:$|^(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}$|^(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}$|^(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}$|^(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}$|^[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}$|^:(?:(?::[0-9A-Fa-f]{1,4}){1,7}|:)$|^::1$|^::$/
// Wazuh agent naming
const AGENT_RE = /^[a-zA-Z0-9_-]+$/
// 2-letter country code
const COUNTRY_RE = /^[A-Z]{2}$/
// AS number (AS prefix optional)
const AS_RE = /^(?:AS)?\d+$/

const VALID_CROWDSEC_SCOPES = new Set(['ip', 'range', 'country', 'as'])

function isIpv4(value: string): boolean { return IPV4_RE.test(value) }
function isIpv6(value: string): boolean { return IPV6_RE.test(value) }
function isIp(value: string): boolean { return isIpv4(value) || isIpv6(value) }

/**
 * Validate CIDR notation. Returns { ok, error?, prefix? }.
 * Rejects /0 outright. For IPv4 expects 1..32, for IPv6 expects 1..128.
 */
function validateCidr(value: string): { ok: boolean; error?: string; prefix?: number } {
  const m = value.match(/^([^/]+)\/(\d+)$/)
  if (!m) return { ok: false, error: 'CIDR must be in <address>/<prefix> form' }
  const addr = m[1]
  const prefix = Number(m[2])
  if (!Number.isFinite(prefix)) return { ok: false, error: 'CIDR prefix must be a number' }
  if (prefix === 0) return { ok: false, error: 'CIDR /0 (whole internet) is not allowed' }
  if (isIpv4(addr)) {
    if (prefix < 1 || prefix > 32) return { ok: false, error: 'IPv4 prefix must be 1..32' }
    return { ok: true, prefix }
  }
  if (isIpv6(addr)) {
    if (prefix < 1 || prefix > 128) return { ok: false, error: 'IPv6 prefix must be 1..128' }
    return { ok: true, prefix }
  }
  return { ok: false, error: 'CIDR address is not a valid IP' }
}

/**
 * Reject obviously dangerous IPs (link-local, multicast, loopback unicast for ban targets,
 * and the unspecified address). This is a soft guard, not a full IP-classification suite.
 */
function isUnsafeBanTarget(ip: string): boolean {
  if (ip === '0.0.0.0' || ip === '::' || ip === '::1' || ip === '127.0.0.1') return true
  if (ip.startsWith('169.254.')) return true // IPv4 link-local
  if (/^fe80:/i.test(ip)) return true        // IPv6 link-local
  if (/^ff[0-9a-f]{2}:/i.test(ip)) return true // IPv6 multicast
  if (/^22[4-9]\.|^23\d\./.test(ip)) return true // IPv4 multicast 224-239
  return false
}

/**
 * Redact + bound an upstream error body before returning to the agent.
 * Falls back to raw truncation if the redactor isn't available.
 */
function sanitizeUpstream(body: string, max = 200): string {
  let safe: string
  try {
    safe = redactSensitive(body)
  } catch {
    safe = body
  }
  // Belt-and-braces: strip common auth header echos that redactSensitive's regex set
  // doesn't already cover (X-Api-Key in particular).
  safe = safe
    .replace(/X-Api-Key:\s*\S+/gi, 'X-Api-Key: ***REDACTED***')
    .replace(/Authorization:\s*\S+(?:\s+\S+)?/gi, 'Authorization: ***REDACTED***')
  if (safe.length > max) safe = safe.slice(0, max) + '…'
  return safe
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function httpGet(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return res.text()
}

function jsonStr(val: unknown): string {
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

// ── 1. crowdsec_blocks ────────────────────────────────────────────────────────

async function crowdsecGet(endpoint: string, params: Record<string, string> = {}): Promise<string> {
  const api = process.env.CROWDSEC_API
  if (!api) return 'CROWDSEC_API environment variable not configured'
  const key = process.env.CROWDSEC_API_KEY ?? ''
  const url = new URL(`${api.replace(/\/+$/, '')}${endpoint}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers: Record<string, string> = {}
  if (key) headers['X-Api-Key'] = key
  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return jsonStr(JSON.parse(await res.text()))
}

const readToolDefs = ([
  {
    name: 'crowdsec_blocks',
    description: 'Get blocked IPs / requests from CrowdSec LAPI',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of results (default 50)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.CROWDSEC_API
      if (!api) return 'CROWDSEC_API environment variable not configured'
      const key = process.env.CROWDSEC_API_KEY ?? ''
      const limit = args.limit ?? 50
      const url = `${api.replace(/\/+$/, '')}/api/v1/requests/search?limit=${limit}`
      const res = await fetch(url, {
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `CrowdSec error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 2. crowdsec_suggestions ─────────────────────────────────────────────────

  {
    name: 'crowdsec_suggestions',
    description: 'Get ban / block suggestions from CrowdSec LAPI',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const api = process.env.CROWDSEC_API
      if (!api) return 'CROWDSEC_API environment variable not configured'
      const key = process.env.CROWDSEC_API_KEY ?? ''
      const url = `${api.replace(/\/+$/, '')}/api/v1/suggestions`
      const res = await fetch(url, {
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `CrowdSec error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 3. ntopng_threats ───────────────────────────────────────────────────────

  {
    name: 'ntopng_threats',
    description: 'Get active threats from ntopng network monitoring',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of results (default 50)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.NTOPNG_API
      if (!api) return 'NTOPNG_API environment variable not configured'
      const limit = args.limit ?? 50
      const url = `${api.replace(/\/+$/, '')}/_/api/v2/threats?active=true&limit=${limit}`
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `ntopng error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 4. ntopng_top_talkers ──────────────────────────────────────────────────

  {
    name: 'ntopng_top_talkers',
    description: 'Get top network talkers from ntopng (last 60 minutes)',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Lookback window in minutes (default 60)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.NTOPNG_API
      if (!api) return 'NTOPNG_API environment variable not configured'
      const minutes = args.minutes ?? 60
      const url = `${api.replace(/\/+$/, '')}/_/api/v2/toptalkers?minutes=${minutes}`
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `ntopng error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 5. elk_flow_search ──────────────────────────────────────────────────────

  {
    name: 'elk_flow_search',
    description: 'Search NetFlow records in Elasticsearch',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Elasticsearch query string (default match_all)' },
        index:   { type: 'string', description: 'Elasticsearch index name (default: flow-*). Supports index patterns with wildcards.' },
        size:    { type: 'number', description: 'Number of hits to return (default 20)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const esUrl = process.env.ELASTICSEARCH_URL
      if (!esUrl) return 'ELASTICSEARCH_URL environment variable not configured'
      const user = process.env.ELASTICSEARCH_USERNAME ?? ''
      const pass = process.env.ELASTICSEARCH_PASSWORD ?? ''
      const index = String(args.index ?? 'flow-*')
      const size  = args.size ?? 20
      const query = args.query !== undefined
        ? JSON.parse(String(args.query))
        : { match_all: {} }

      const url = `${esUrl.replace(/\/+$/, '')}/${index}/_search`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(user && pass ? { Authorization: `Basic ${btoa(`${user}:${pass}`)}` } : {}),
        },
        body: JSON.stringify({ size, query }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `Elasticsearch error HTTP ${res.status}: ${await res.text()}`
      return jsonStr(JSON.parse(await res.text()))
    },
  },

  // ── 6. elk_syslog_search ────────────────────────────────────────────────────

  {
    name: 'elk_syslog_search',
    description: 'Search syslog entries in Elasticsearch',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Elasticsearch query string (default match_all on message). Supports query_string or match DSL.' },
        index:   { type: 'string', description: 'Elasticsearch index name (default: syslog-*). Supports index patterns.' },
        size:    { type: 'number', description: 'Number of hits to return (default 20)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const esUrl = process.env.ELASTICSEARCH_URL
      if (!esUrl) return 'ELASTICSEARCH_URL environment variable not configured'
      const user = process.env.ELASTICSEARCH_USERNAME ?? ''
      const pass = process.env.ELASTICSEARCH_PASSWORD ?? ''
      const index = String(args.index ?? 'syslog-*')
      const size  = args.size ?? 20
      let query = args.query !== undefined
        ? JSON.parse(String(args.query))
        : { match: { message: { query: '*' } } }

      const url = `${esUrl.replace(/\/+$/, '')}/${index}/_search`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(user && pass ? { Authorization: `Basic ${btoa(`${user}:${pass}`)}` } : {}),
        },
        body: JSON.stringify({ size, query }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `Elasticsearch error HTTP ${res.status}: ${await res.text()}`
      return jsonStr(JSON.parse(await res.text()))
    },
  },

  // ── 7. wazuh_alerts ─────────────────────────────────────────────────────────

  {
    name: 'wazuh_alerts',
    description: 'Get security alerts from Wazuh Manager',
    inputSchema: {
      type: 'object',
      properties: {
        limit:   { type: 'number', description: 'Number of alerts (default 50)' },
        filter:  { type: 'string', description: 'Wazuh filter string (e.g. "rule.level>=5")' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.WAZUH_API
      if (!api) return 'WAZUH_API environment variable not configured'
      const user = process.env.WAZUH_USERNAME ?? ''
      const pass = process.env.WAZUH_PASSWORD ?? ''
      const limit = args.limit ?? 50
      const filter = String(args.filter ?? '')
      const params = new URLSearchParams({
        select: '*',
        pretty: 'true',
        sort: 'timestamp',
        limit: String(limit),
      })
      if (filter) params.set('filter', filter)
      const url = `${api.replace(/\/+$/, '')}/alerts?${params.toString()}`
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `Wazuh error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 8. wazuh_rootcheck ──────────────────────────────────────────────────────

  {
    name: 'wazuh_rootcheck',
    description: 'Get rootcheck scan results from Wazuh',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of results (default 20)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.WAZUH_API
      if (!api) return 'WAZUH_API environment variable not configured'
      const user = process.env.WAZUH_USERNAME ?? ''
      const pass = process.env.WAZUH_PASSWORD ?? ''
      const limit = args.limit ?? 20
      const params = new URLSearchParams({
        monitor_results: 'true',
        limit: String(limit),
        pretty: 'true',
      })
      const url = `${api.replace(/\/+$/, '')}/rootcheck?${params.toString()}`
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `Wazuh error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 9. prometheus_query ─────────────────────────────────────────────────────

  {
    name: 'prometheus_query',
    description: 'Query VictoriaMetrics (Prometheus-compatible instant query)',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Prometheus query expression (e.g. "node_cpu_seconds_total{mode=\'idle\'}")' },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>) {
      const vmUrl = process.env.VICTORIA_METRICS_URL
      if (!vmUrl) return 'VICTORIA_METRICS_URL environment variable not configured'
      const query = String(args.query)
      const url = `${vmUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `VictoriaMetrics error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },

  // ── 10. prometheus_query_range ──────────────────────────────────────────────

  {
    name: 'prometheus_query_range',
    description: 'Query VictoriaMetrics (Prometheus-compatible range query for time series)',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Prometheus query expression' },
        start:  { type: 'string', description: 'Start time (RFC3339 or Unix timestamp, default: 1h ago)' },
        end:    { type: 'string', description: 'End time (RFC3339 or Unix timestamp, default: now)' },
        step:   { type: 'string', description: 'Resolution step (e.g. 15s, 1m, 5m, default: 60s)' },
      },
      required: ['query'],
    },
    async execute(args: Record<string, unknown>) {
      const vmUrl = process.env.VICTORIA_METRICS_URL
      if (!vmUrl) return 'VICTORIA_METRICS_URL environment variable not configured'
      const query = String(args.query)
      const params = new URLSearchParams({ query })
      if (args.start) params.set('start', String(args.start))
      if (args.end)   params.set('end', String(args.end))
      params.set('step', String(args.step ?? '60s'))
      const url = `${vmUrl.replace(/\/+$/, '')}/api/v1/query_range?${params.toString()}`
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `VictoriaMetrics error HTTP ${res.status}: ${await res.text()}`
      const data = JSON.parse(await res.text())
      return jsonStr(data)
    },
  },
] as const).map(t => ({ ...t, category: 'security' as const }))

// ── Write tools (action-oriented) ──────────────────────────────────────────────

const writeToolDefs = ([
  // ── 11. crowdsec_decision_create (ban IP) ────────────────────────────────

  {
    name: 'crowdsec_decision_create',
    description: 'Add a ban/block to CrowdSec threat intelligence (create a decision)',
    inputSchema: {
      type: 'object',
      properties: {
        ip:       { type: 'string', description: 'IP address to ban' },
        scope:    { type: 'string', description: 'Scope to ban (e.g. "ip", "os", "fqdn"). Defaults to "ip".' },
        duration: { type: 'string', description: 'Ban duration (e.g. "24h", "7d", "infinite"). Defaults to "24h".' },
        reason:   { type: 'string', description: 'Human-readable reason for the ban' },
      },
      required: ['ip'],
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.CROWDSEC_API
      if (!api) return 'CROWDSEC_API environment variable not configured'
      const key = process.env.CROWDSEC_API_KEY ?? ''
      const ipRaw = args.ip
      const scope = String(args.scope ?? 'ip')
      const duration = String(args.duration ?? '24h')
      const reason = String(args.reason ?? 'blocked by security tool')

      // ── Input validation (structured error, no HTTP call) ──────────────
      if (typeof ipRaw !== 'string' || ipRaw.length === 0) {
        return jsonStr({ error: 'validation: ip must be a non-empty string' })
      }
      const ip = ipRaw
      if (!VALID_CROWDSEC_SCOPES.has(scope)) {
        return jsonStr({ error: `validation: scope must be one of ${[...VALID_CROWDSEC_SCOPES].join(', ')}` })
      }
      if (scope === 'ip') {
        if (!isIp(ip)) return jsonStr({ error: 'validation: ip must be a valid IPv4 or IPv6 address' })
        if (isUnsafeBanTarget(ip)) return jsonStr({ error: `validation: refusing to ban unsafe address '${ip}'` })
      } else if (scope === 'range') {
        const c = validateCidr(ip)
        if (!c.ok) return jsonStr({ error: `validation: ${c.error}` })
      } else if (scope === 'country') {
        if (!COUNTRY_RE.test(ip)) return jsonStr({ error: 'validation: country scope expects 2-letter uppercase ISO code' })
      } else if (scope === 'as') {
        if (!AS_RE.test(ip)) return jsonStr({ error: 'validation: as scope expects AS number (e.g. "AS12345" or "12345")' })
      }

      const url = `${api.replace(/\/+$/, '')}/api/v1/decisions`
      const body = { scope, value: ip, duration, reason }
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'X-Api-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `CrowdSec error HTTP ${res.status}: ${sanitizeUpstream(await res.text())}`
      return jsonStr({ success: true, ip, scope, duration, reason })
    },
  },

  // ── 12. crowdsec_decision_delete (unban IP) ─────────────────────────────

  {
    name: 'crowdsec_decision_delete',
    description: 'Remove a ban/block from CrowdSec threat intelligence (delete a decision)',
    inputSchema: {
      type: 'object',
      properties: {
        ip:    { type: 'string', description: 'IP address to unban' },
        scope: { type: 'string', description: 'Scope to remove (e.g. "ip"). Defaults to "ip".' },
      },
      required: ['ip'],
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.CROWDSEC_API
      if (!api) return 'CROWDSEC_API environment variable not configured'
      const key = process.env.CROWDSEC_API_KEY ?? ''
      const ip = String(args.ip)
      const scope = String(args.scope ?? 'ip')
      const url = `${api.replace(/\/+$/, '')}/api/v1/decisions?type=${scope}&value=${encodeURIComponent(ip)}`
      const res = await fetch(url.toString(), {
        method: 'DELETE',
        headers: {
          'X-Api-Key': key,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `CrowdSec error HTTP ${res.status}: ${sanitizeUpstream(await res.text())}`
      return jsonStr({ success: true, ip, scope, action: 'deleted' })
    },
  },

  // ── 13. wazuh_active_response ────────────────────────────────────────────

  {
    name: 'wazuh_active_response',
    description: 'Send an active response command to a Wazuh agent (e.g. block IP, restart agent)',
    inputSchema: {
      type: 'object',
      properties: {
        agent:    { type: 'string', description: 'Wazuh agent ID or name' },
        command:  { type: 'string', description: 'Command to execute (e.g. "firewall-drop", "host-deny", "restart-wazuh")' },
        args:     { type: 'object', description: 'Command arguments as key-value pairs' },
      },
      required: ['agent', 'command'],
    },
    async execute(args: Record<string, unknown>) {
      const api = process.env.WAZUH_API
      if (!api) return 'WAZUH_API environment variable not configured'
      const user = process.env.WAZUH_USERNAME ?? ''
      const pass = process.env.WAZUH_PASSWORD ?? ''
      const agentRaw = args.agent
      const commandRaw = args.command
      const wazuhArgs = args.args ?? {}

      // ── Input validation (structured error, no HTTP call) ──────────────
      if (typeof agentRaw !== 'string' || agentRaw.length === 0) {
        return jsonStr({ error: 'validation: agent must be a non-empty string' })
      }
      if (!AGENT_RE.test(agentRaw)) {
        return jsonStr({ error: 'validation: agent must match [a-zA-Z0-9_-]+' })
      }
      if (typeof commandRaw !== 'string' || commandRaw.length === 0) {
        return jsonStr({ error: 'validation: command must be a non-empty string' })
      }
      const agent = agentRaw
      const command = commandRaw

      const url = `${api.replace(/\/+$/, '')}/active-response/run`
      const body: Record<string, unknown> = {
        cmd: command,
        agent_id: agent,
      }
      if (typeof wazuhArgs === 'object' && wazuhArgs !== null) {
        body.arguments = wazuhArgs
      }
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `Wazuh error HTTP ${res.status}: ${sanitizeUpstream(await res.text())}`
      return jsonStr({ success: true, agent, command })
    },
  },

  // ── 14. firewall_block (stub) ────────────────────────────────────────────

  {
    name: 'firewall_block',
    description: 'Block a CIDR range via the firewall API (behind feature flag — stub for now)',
    inputSchema: {
      type: 'object',
      properties: {
        cidr:   { type: 'string', description: 'CIDR notation to block (e.g. "10.0.0.0/24")' },
        reason: { type: 'string', description: 'Reason for the block' },
      },
      required: ['cidr'],
    },
    async execute(args: Record<string, unknown>) {
      const fwApi = process.env.FIREWALL_API
      if (!fwApi) return 'FIREWALL_API environment variable not configured — firewall_block is not configured'
      const fwKey = process.env.FIREWALL_API_KEY ?? ''
      const cidrRaw = args.cidr
      const reason = String(args.reason ?? 'blocked by security tool')

      // ── Input validation (structured error, no HTTP call) ──────────────
      if (typeof cidrRaw !== 'string' || cidrRaw.length === 0) {
        return jsonStr({ error: 'validation: cidr must be a non-empty string' })
      }
      const c = validateCidr(cidrRaw)
      if (!c.ok) return jsonStr({ error: `validation: ${c.error}` })
      const cidr = cidrRaw

      const url = `${fwApi.replace(/\/+$/, '')}/blocks`
      const body = { cidr, reason }
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fwKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return `Firewall API error HTTP ${res.status}: ${sanitizeUpstream(await res.text())}`
      return jsonStr({ success: true, cidr, reason })
    },
  },
] as const).map(t => ({ ...t, category: 'security' as const }))

// ── Combined export ──────────────────────────────────────────────────────────

export const securityTools = [...readToolDefs, ...writeToolDefs]
