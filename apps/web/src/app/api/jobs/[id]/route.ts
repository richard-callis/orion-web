import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError } from '@/lib/validate'
import { z } from 'zod'

const PatchJobSchema = z.object({ archived: z.boolean().optional() })

async function guard() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const deny = await guard(); if (deny) return deny
  const job = await prisma.backgroundJob.findUnique({ where: { id: (await params).id } })
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(job)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const deny = await guard(); if (deny) return deny
  const parsed = await parseBodyOrError(req, PatchJobSchema)
  if ('error' in parsed) return parsed.error
  const { archived } = parsed.data
  const job = await prisma.backgroundJob.update({
    where: { id: (await params).id },
    data: {
      archivedAt: archived ? new Date() : null,
      updatedAt: new Date(),
    },
  })
  return NextResponse.json(job)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const deny = await guard(); if (deny) return deny
  await prisma.backgroundJob.delete({ where: { id: (await params).id } })
  return new NextResponse(null, { status: 204 })
}
