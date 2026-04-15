import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const middleware = await prisma.ingressMiddleware.update({
    where: { id: params.id },
    data: {
      ...(body.name    !== undefined && { name:    body.name.trim() }),
      ...(body.type    !== undefined && { type:    body.type }),
      ...(body.config  !== undefined && { config:  body.config }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
    },
  })
  return NextResponse.json(middleware)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await prisma.ingressMiddleware.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
