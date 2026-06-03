import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getCustomRecords, upsertCustomRecord } from '@/lib/dns'

export async function GET() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await getCustomRecords())
  } catch {
    return NextResponse.json({ error: 'Failed to read DNS records' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // DNS records control internal name resolution — admin only.
  // Previously had no auth: any authenticated user could write custom DNS records.
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { ip, hostnames } = await req.json()
  if (!ip || !Array.isArray(hostnames) || hostnames.length === 0)
    return NextResponse.json({ error: 'ip and hostnames required' }, { status: 400 })
  try {
    await upsertCustomRecord(ip, hostnames)
    return NextResponse.json({ ip, hostnames }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Failed to write DNS record' }, { status: 500 })
  }
}
