import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'
import { parseBodyOrError, CreateFeatureSchema } from '@/lib/validate'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const { searchParams } = new URL(req.url)
  const epicId = searchParams.get('epicId')
  const features = await prisma.feature.findMany({
    where: epicId ? { epicId } : undefined,
    orderBy: { createdAt: 'asc' },
    include: { epic: true, _count: { select: { tasks: true } } },
  })
  return NextResponse.json(features)
}

export async function POST(req: NextRequest) {
  const caller = await requireServiceAuth(req)
  const isService = caller === null

  // SOC2 [INPUT-001]: Validate request body with Zod schema
  const result = await parseBodyOrError(req, CreateFeatureSchema)
  if ('error' in result) return result.error

  const { data } = result

  const feature = await prisma.feature.create({
    data: {
      title: data.title,
      description: data.description ?? null,
      ...(data.epicId && { epicId: data.epicId }),
      status: data.status,
      createdBy: caller?.id ?? 'gateway',
    },
    include: { _count: { select: { tasks: true } } },
  })
  return NextResponse.json(feature, { status: 201 })
}
