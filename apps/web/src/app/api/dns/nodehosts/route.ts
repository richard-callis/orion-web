import { NextRequest, NextResponse } from 'next/server'
import { getNodeHosts, upsertNodeHost } from '@/lib/dns'
import { requireAdmin } from '@/lib/auth'

export async function GET() {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  try {
    return NextResponse.json(await getNodeHosts())
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }

  const { ip, hostnames } = await req.json()
  if (!ip || !Array.isArray(hostnames) || hostnames.length === 0)
    return NextResponse.json({ error: 'ip and hostnames required' }, { status: 400 })
  try {
    await upsertNodeHost(ip, hostnames)
    return NextResponse.json({ ip, hostnames }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
