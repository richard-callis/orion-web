import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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
