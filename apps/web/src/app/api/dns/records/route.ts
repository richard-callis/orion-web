import { NextRequest, NextResponse } from 'next/server'
import { getCustomRecords, upsertCustomRecord } from '@/lib/dns'

export async function GET() {
  try {
    return NextResponse.json(await getCustomRecords())
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const { ip, hostnames } = await req.json()
  if (!ip || !Array.isArray(hostnames) || hostnames.length === 0)
    return NextResponse.json({ error: 'ip and hostnames required' }, { status: 400 })
  try {
    await upsertCustomRecord(ip, hostnames)
    return NextResponse.json({ ip, hostnames }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
