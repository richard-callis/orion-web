import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { syncDomainDns } from '@/lib/dns-sync'

async function maybeSync(domainId: string) {
  const domain = await prisma.domain.findUnique({ where: { id: domainId } })
  if (!domain?.coreDnsEnvironmentId || domain.coreDnsStatus !== 'bootstrapped') return
  const env = await prisma.environment.findUnique({ where: { id: domain.coreDnsEnvironmentId } })
  if (!env?.gatewayUrl || !env?.gatewayToken) return
  const exec = async (tool: string, args: Record<string, unknown>) => {
    const res = await fetch(`${env.gatewayUrl}/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.gatewayToken}` },
      body: JSON.stringify({ name: tool, arguments: args }),
    })
    if (!res.ok) throw new Error(`Gateway ${tool} failed: ${res.status}`)
    const data = await res.json() as { result?: string; error?: string }
    if (data.error) throw new Error(data.error)
    return data.result ?? ''
  }
  try {
    await syncDomainDns(domainId, exec, env.type)
  } catch (err) {
    console.error('[dns-sync]', err)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; recordId: string } }) {
  const body = await req.json()
  const record = await prisma.dnsRecord.update({
    where: { id: params.recordId },
    data: {
      ...(body.ip        !== undefined && { ip:        body.ip.trim() }),
      ...(body.hostnames !== undefined && { hostnames: body.hostnames.map((h: string) => h.trim().toLowerCase()) }),
      ...(body.enabled   !== undefined && { enabled:   body.enabled }),
      ...(body.comment   !== undefined && { comment:   body.comment }),
    },
  })
  await maybeSync(params.id)
  return NextResponse.json(record)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string; recordId: string } }) {
  await prisma.dnsRecord.delete({ where: { id: params.recordId } })
  await maybeSync(params.id)
  return new NextResponse(null, { status: 204 })
}
