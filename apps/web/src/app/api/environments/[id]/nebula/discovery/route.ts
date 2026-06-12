import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/environments/[id]/nebula/discovery
 * Full catalog: default definitions + installed entries for the environment.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => { throw Object.assign(new Error('Unauthorized'), {status:401}) })

  const defaults = await prisma.novaDefinition.findMany({
    orderBy: { name: 'asc' },
  })
  const installed = await prisma.nebulaInstance.findMany({
    where: { environmentId: params.id },
    include: { novaDefinition: true },
    orderBy: { name: 'asc' },
  })
  // Active = installed entries that are enabled
  const active = installed.filter((e) => e.isInstalled)
  return NextResponse.json({ defaults, installed, active })
}
