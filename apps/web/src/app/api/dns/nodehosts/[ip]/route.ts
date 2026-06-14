import { NextRequest, NextResponse } from 'next/server'
import { upsertNodeHost, deleteNodeHost } from '@/lib/dns'
import { requireAdmin } from '@/lib/auth'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ ip: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const body = await req.json()
  if (!Array.isArray(body.hostnames) || body.hostnames.length === 0)
    return NextResponse.json({ error: 'hostnames required' }, { status: 400 })
  try {
    await upsertNodeHost((await params).ip, body.hostnames)
    return NextResponse.json({ ip: (await params).ip, hostnames: body.hostnames })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ ip: string }> }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  try {
    const deleted = await deleteNodeHost((await params).ip)
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
