import { NextRequest, NextResponse } from 'next/server'
import * as net from 'net'
import { upsertCustomRecord, deleteCustomRecord } from '@/lib/dns'
import { requireAdmin } from '@/lib/auth'

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/

function isValidIp(ip: string): boolean {
  return net.isIP(ip) !== 0
}

function isValidHostname(h: string): boolean {
  return HOSTNAME_RE.test(h)
}

export async function PUT(req: NextRequest, { params }: { params: { ip: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  if (!isValidIp(params.ip)) {
    return NextResponse.json({ error: 'Invalid IP address' }, { status: 400 })
  }

  const { ip, hostnames } = await req.json()

  if (!Array.isArray(hostnames) || !hostnames.every((h: unknown) => typeof h === 'string' && isValidHostname(h))) {
    return NextResponse.json({ error: 'Invalid hostname(s)' }, { status: 400 })
  }

  try {
    await upsertCustomRecord(params.ip, hostnames)
    return NextResponse.json({ ip, hostnames })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { ip: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  if (!isValidIp(params.ip)) {
    return NextResponse.json({ error: 'Invalid IP address' }, { status: 400 })
  }

  try {
    const deleted = await deleteCustomRecord(params.ip)
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
