import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

interface FlowRow {
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  protocol: string
  bytes: number
  packets: number
  duration: number
  timestamp: string
}

function normalizeFlows(raw: unknown): FlowRow[] {
  // Gateway /tools/execute wraps the tool result in { result: <string> }.
  // elk_flow_search serialises the ES _search response with JSON.stringify,
  // so we need to unwrap the envelope then parse the inner string.
  let parsed: unknown = raw
  if (parsed && typeof parsed === 'object' && 'result' in (parsed as object)) {
    parsed = (parsed as { result: unknown }).result
  }
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return [] }
  }

  if (!parsed || typeof parsed !== 'object') return []

  // ES _search response shape: { hits: { hits: [{ _source: {...} }] } }
  const hits = (parsed as any)?.hits?.hits
  if (Array.isArray(hits)) {
    return hits.map((h: any) => {
      const s = h._source ?? h
      return {
        src_ip:    String(s.src_ip ?? s.src_addr ?? s['source.ip'] ?? ''),
        dst_ip:    String(s.dst_ip ?? s.dst_addr ?? s['destination.ip'] ?? ''),
        src_port:  Number(s.src_port ?? s['source.port'] ?? 0),
        dst_port:  Number(s.dst_port ?? s['destination.port'] ?? 0),
        protocol:  String(s.protocol ?? s.transport ?? ''),
        bytes:     Number(s.bytes ?? s.in_bytes ?? s['network.bytes'] ?? 0),
        packets:   Number(s.packets ?? s.in_pkts ?? s['network.packets'] ?? 0),
        duration:  Number(s.duration ?? s.last_switched ?? 0),
        timestamp: String(s['@timestamp'] ?? s.timestamp ?? s.first_switched ?? new Date().toISOString()),
      }
    })
  }

  // Fallback: if the result is already a flat array of flow objects
  if (Array.isArray(parsed)) {
    return (parsed as any[]).map(s => ({
      src_ip:    String(s.src_ip ?? ''),
      dst_ip:    String(s.dst_ip ?? ''),
      src_port:  Number(s.src_port ?? 0),
      dst_port:  Number(s.dst_port ?? 0),
      protocol:  String(s.protocol ?? ''),
      bytes:     Number(s.bytes ?? 0),
      packets:   Number(s.packets ?? 0),
      duration:  Number(s.duration ?? 0),
      timestamp: String(s.timestamp ?? s['@timestamp'] ?? new Date().toISOString()),
    }))
  }

  return []
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const query = searchParams.get('q') || '*'
  const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50

  const env = await prisma.environment.findFirst({
    where: { status: 'connected', gatewayUrl: { not: null } },
    select: { gatewayUrl: true, gatewayToken: true },
  })

  if (!env?.gatewayUrl) {
    return NextResponse.json(
      { error: 'No connected environment with a gateway configured', code: 'NO_GATEWAY' },
      { status: 503 }
    )
  }

  const res = await fetch(`${env.gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.gatewayToken ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'elk_flow_search',
      arguments: { query, limit },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    return NextResponse.json({ error: text, code: 'GATEWAY_ERROR' }, { status: res.status })
  }

  const raw = await res.json()
  const flows = normalizeFlows(raw)
  return NextResponse.json({ flows })
}
