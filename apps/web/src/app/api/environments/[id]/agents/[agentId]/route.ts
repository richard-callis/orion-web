import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/** DELETE /api/environments/:id/agents/:agentId — unlink an agent from this environment */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string; agentId: string } }) {
  await prisma.agentEnvironment.deleteMany({
    where: { agentId: params.agentId, environmentId: params.id },
  })
  return new NextResponse(null, { status: 204 })
}
