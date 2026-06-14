import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { parseBodyOrError } from '@/lib/validate'

export const dynamic = 'force-dynamic'

// SOC2 [INPUT-001]: Validate all write inputs
const CreateNebulaInstanceSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-_]*$/),
  category: z.enum(['skill', 'hook']),
  spec: z.string().min(2),
  minimumTier: z.enum(['viewer', 'operator', 'admin']).optional(),
})

/**
 * GET /api/environments/[id]/nebula
 * List installed nebula entries for an environment.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const entries = await prisma.nebulaInstance.findMany({
    where: { environmentId: (await params).id },
    include: { novaDefinition: { select: { title: true, version: true } } },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json(entries)
}

/**
 * POST /api/environments/[id]/nebula
 * Create a custom nebula entry (operator+ or admin).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Require operator or admin tier — check environment-level tier
  const tier = await prisma.environmentUserTier.findUnique({
    where: { userId_environmentId: { userId: user.id, environmentId: (await params).id } },
  })
  const effectiveTier = user.role === 'admin' ? 'admin' : (tier?.tier ?? 'viewer')
  if (!['operator', 'admin'].includes(effectiveTier)) {
    return NextResponse.json(
      { error: 'Operator access required' },
      { status: 403 }
    )
  }
  const result = await parseBodyOrError(req, CreateNebulaInstanceSchema)
  if ('error' in result) return result.error
  const { data: body } = result
  const entry = await prisma.nebulaInstance.create({
    data: { ...body, environmentId: (await params).id, isForked: true },
  })
  return NextResponse.json(entry)
}
