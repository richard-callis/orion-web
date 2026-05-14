import { promisify } from 'util'
import { execFile } from 'child_process'

const exec = promisify(execFile)

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

export const securityTools = [
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
          Authorization: `Bearer ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
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
          Authorization: `Bearer ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
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
]
