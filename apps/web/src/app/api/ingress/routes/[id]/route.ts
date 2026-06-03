import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }
  const body = await req.json()
  const route = await prisma.ingressRoute.update({
    where: { id: params.id },
    data: {
      ...(body.host    !== undefined && { host:    body.host.trim().toLowerCase() }),
      ...(body.paths   !== undefined && { paths:   body.paths }),
      ...(body.tls     !== undefined && { tls:     body.tls }),
      ...(body.comment     !== undefined && { comment:     body.comment || null }),
      ...(body.middlewares !== undefined && { middlewares: body.middlewares }),
    },
  })
  return NextResponse.json(route)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }
  await prisma.ingressRoute.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
