import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100'

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { searchParams } = new URL(req.url)
  const lokiParams = new URLSearchParams()
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  if (start) lokiParams.set('start', start)
  if (end) lokiParams.set('end', end)

  try {
    const res = await fetch(`${LOKI_URL}/loki/api/v1/labels?${lokiParams}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: 'Loki unreachable', detail: String(err) }, { status: 502 })
  }
}
