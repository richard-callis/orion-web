import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { name: labelName } = await params
  const { searchParams } = new URL(req.url)
  const lokiParams = new URLSearchParams()
  const start = searchParams.get('start')
  const end = searchParams.get('end')
  if (start) lokiParams.set('start', start)
  if (end) lokiParams.set('end', end)

  try {
    const name = encodeURIComponent(labelName)
    const res = await fetch(`${LOKI_URL}/loki/api/v1/label/${name}/values?${lokiParams}`, {
      signal: AbortSignal.timeout(10_000),
    })
    const ct = res.headers.get('content-type') ?? ''
    const data = ct.includes('application/json') ? await res.json() : { error: await res.text() }
    return NextResponse.json(data, { status: res.status })
  } catch (err) {
    return NextResponse.json({ error: 'Loki unreachable', detail: String(err) }, { status: 502 })
  }
}
