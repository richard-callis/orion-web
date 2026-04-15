import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const route = await prisma.ingressRoute.create({
    data: {
      ingressPointId: params.id,
      host:           body.host.trim().toLowerCase(),
      paths:          body.paths   ?? [],
      tls:            body.tls         ?? true,
      middlewares:    body.middlewares ?? [],
      comment:        body.comment     ?? null,
      enabled:        true,
    },
  })
  return NextResponse.json(route, { status: 201 })
}
