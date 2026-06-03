import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return new Response(JSON.stringify({error:'Unauthorized'}),{status:401,headers:{'Content-Type':'application/json'}}) }
  const body = await req.json()
  const middleware = await prisma.ingressMiddleware.create({
    data: {
      ingressPointId: params.id,
      name:           body.name.trim(),
      type:           body.type    ?? 'custom',
      config:         body.config  ?? {},
      enabled:        body.enabled ?? true,
    },
  })
  return NextResponse.json(middleware, { status: 201 })
}
