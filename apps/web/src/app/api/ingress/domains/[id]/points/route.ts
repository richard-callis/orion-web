import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }
  const body = await req.json()
  const point = await prisma.ingressPoint.create({
    data: {
      domainId:      (await params).id,
      environmentId: body.environmentId ?? null,
      name:          body.name.trim(),
      type:          body.type          ?? 'traefik',
      ip:            body.ip            ?? null,
      port:          body.port          ?? 443,
      certManager:   body.certManager   ?? true,
      clusterIssuer: body.clusterIssuer ?? null,
      status:        'pending',
      comment:       body.comment       ?? null,
    },
    include: {
      environment: { select: { id: true, name: true } },
      routes: true,
    },
  })
  return NextResponse.json(point, { status: 201 })
}
