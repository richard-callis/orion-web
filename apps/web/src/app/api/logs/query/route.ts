import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100'

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { searchParams } = new URL(req.url)
  const query = searchParams.get('query')
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  const lokiParams = new URLSearchParams({ query })
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  const limit = String(Math.min(parseInt(searchParams.get('limit') || '500', 10) || 500, 1000))
  const direction = searchParams.get('direction') || 'backward'
  if (start) lokiParams.set('start', start)
  if (end) lokiParams.set('end', end)
  lokiParams.set('limit', limit)
  lokiParams.set('direction', direction)

  try {
    const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${lokiParams}`, {
      signal: AbortSignal.timeout(30_000),
    })
    const ct = res.headers.get('content-type') ?? ''
    const data = ct.includes('application/json') ? await res.json() : { error: await res.text() }
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: 'Loki unreachable', detail: String(err) }, { status: 502 })
  }
}
