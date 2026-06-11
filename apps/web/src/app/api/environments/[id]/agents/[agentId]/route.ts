import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

/** DELETE /api/environments/:id/agents/:agentId — unlink an agent from this environment */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string; agentId: string } }) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await prisma.agentEnvironment.deleteMany({
    where: { agentId: params.agentId, environmentId: params.id },
  })
  return new NextResponse(null, { status: 204 })
}
