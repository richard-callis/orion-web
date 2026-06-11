import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

async function guard() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const deny = await guard(); if (deny) return deny
  const job = await prisma.backgroundJob.findUnique({ where: { id: params.id } })
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(job)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const deny = await guard(); if (deny) return deny
  const body = (await req.json()) as { archived?: boolean }
  const job = await prisma.backgroundJob.update({
    where: { id: params.id },
    data: {
      archivedAt: body.archived ? new Date() : null,
      updatedAt: new Date(),
    },
  })
  return NextResponse.json(job)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const deny = await guard(); if (deny) return deny
  await prisma.backgroundJob.delete({ where: { id: params.id } })
  return new NextResponse(null, { status: 204 })
}
