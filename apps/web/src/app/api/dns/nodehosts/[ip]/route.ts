import { NextRequest, NextResponse } from 'next/server'
import { upsertNodeHost, deleteNodeHost } from '@/lib/dns'

export async function PUT(req: NextRequest, { params }: { params: { ip: string } }) {
  const { ip, hostnames } = await req.json()
  try {
    await upsertNodeHost(params.ip, hostnames)
    return NextResponse.json({ ip, hostnames })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { ip: string } }) {
  try {
    const deleted = await deleteNodeHost(params.ip)
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
