import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { syncDomainDns } from '@/lib/dns-sync'

async function getGatewayExec(envId: string) {
  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env?.gatewayUrl || !env?.gatewayToken) return null
  return {
    envType: env.type,
    exec: async (tool: string, args: Record<string, unknown>) => {
      const res = await fetch(`${env.gatewayUrl}/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.gatewayToken}` },
        body: JSON.stringify({ name: tool, arguments: args }),
      })
      if (!res.ok) throw new Error(`Gateway ${tool} failed: ${res.status}`)
      const data = await res.json() as { result?: string; error?: string }
      if (data.error) throw new Error(data.error)
      return data.result ?? ''
    },
  }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const records = await prisma.dnsRecord.findMany({
    where: { domainId: params.id },
    orderBy: { ip: 'asc' },
  })
  return NextResponse.json(records)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  if (!body.ip || !Array.isArray(body.hostnames) || body.hostnames.length === 0) {
    return NextResponse.json({ error: 'ip and hostnames required' }, { status: 400 })
  }

  const record = await prisma.dnsRecord.create({
    data: {
      domainId:  params.id,
      ip:        body.ip.trim(),
      hostnames: body.hostnames.map((h: string) => h.trim().toLowerCase()),
      comment:   body.comment ?? null,
      enabled:   true,
    },
  })

  // Sync to CoreDNS if environment is configured
  const domain = await prisma.domain.findUnique({ where: { id: params.id } })
  if (domain?.coreDnsEnvironmentId && domain.coreDnsStatus === 'bootstrapped') {
    const gw = await getGatewayExec(domain.coreDnsEnvironmentId)
    if (gw) {
      try {
        await syncDomainDns(params.id, gw.exec, gw.envType)
      } catch (err) {
        console.error('[dns-sync] Sync failed after record create:', err)
      }
    }
  }

  return NextResponse.json(record, { status: 201 })
}
