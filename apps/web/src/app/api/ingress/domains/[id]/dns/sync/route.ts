import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { syncDomainDns } from '@/lib/dns-sync'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const domain = await prisma.domain.findUnique({ where: { id: params.id } })
  if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
  if (!domain.coreDnsEnvironmentId || domain.coreDnsStatus !== 'bootstrapped') {
    return NextResponse.json({ error: 'CoreDNS not bootstrapped for this domain' }, { status: 422 })
  }

  const env = await prisma.environment.findUnique({ where: { id: domain.coreDnsEnvironmentId } })
  if (!env?.gatewayUrl || !env?.gatewayToken) {
    return NextResponse.json({ error: 'Environment gateway not connected' }, { status: 422 })
  }

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
    await syncDomainDns(params.id, exec, env.type)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
