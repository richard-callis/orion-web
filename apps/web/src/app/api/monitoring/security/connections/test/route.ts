import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Maps each SecuritySettings key to the cheapest gateway read tool for that source.
// Tests via gateway so the probe runs from inside the cluster network (correct DNS/auth).
// Note: elk_flow_search parses its query arg as JSON, so we omit it to get match_all.
const SOURCE_PROBE: Record<string, { tool: string; args: Record<string, unknown> }> = {
  CROWDSEC_API:         { tool: 'crowdsec_blocks',    args: { limit: 1 } },
  NTOPNG_API:           { tool: 'ntopng_threats',     args: { limit: 1 } },
  ELASTICSEARCH_URL:    { tool: 'elk_flow_search',    args: { size: 1 } },
  WAZUH_API:            { tool: 'wazuh_alerts',       args: { limit: 1 } },
  VICTORIA_METRICS_URL: { tool: 'prometheus_query',   args: { query: 'up', time: new Date().toISOString() } },
}

// Gateway tools return error strings (not HTTP errors) when a source is down.
// These prefixes/substrings appear in the result string on failure.
const ERROR_INDICATORS = [
  'environment variable not configured',
  'error http',
  'connection refused',
  'failed to connect',
  'econnrefused',
  'timeout',
  'unauthorized',
]

function isErrorResult(result: unknown): boolean {
  if (typeof result !== 'string') return false
  const lower = result.toLowerCase()
  return ERROR_INDICATORS.some(s => lower.includes(s))
}

export async function GET(request: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const key = request.nextUrl.searchParams.get('key')

  if (!key || !SOURCE_PROBE[key]) {
    return NextResponse.json(
      { ok: false, error: `Unknown source key: ${key}` },
      { status: 400 }
    )
  }

  const env = await prisma.environment.findFirst({
    where: { status: 'connected', gatewayUrl: { not: null } },
    select: { gatewayUrl: true, gatewayToken: true },
  })

  if (!env?.gatewayUrl) {
    return NextResponse.json(
      { ok: false, error: 'No connected gateway — cannot test source connectivity' },
      { status: 503 }
    )
  }

  const { tool, args } = SOURCE_PROBE[key]

  try {
    const res = await fetch(`${env.gatewayUrl}/tools/execute`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.gatewayToken ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: tool, arguments: args }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ ok: false, error: `Gateway returned ${res.status}: ${text}` })
    }

    // Gateway returns { result: "<tool output string>" } with HTTP 200 even on source errors.
    // Inspect the result body for known error indicators.
    const data = await res.json() as { result?: unknown }
    const result = data?.result

    if (isErrorResult(result)) {
      return NextResponse.json({ ok: false, error: String(result) })
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg })
  }
}
