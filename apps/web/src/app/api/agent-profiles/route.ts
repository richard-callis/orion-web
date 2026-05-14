/**
 * /api/agent-profiles — List agent profiles for discovery.
 *
 * GET ?environmentId=<id> — returns all AgentProfiles, optionally filtered by
 * active environment. Used by the gateway's find_specialist built-in tool.
 *
 * Response shape matches what discovery.ts expects:
 *   { id, agentId, domain, description, tags, confidence, verifiedAt,
 *     agent: { name, status } }
 */

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try {
    await requireServiceAuth(req)
  } catch {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const environmentId = searchParams.get('environmentId')

  const profiles = await prisma.agentProfile.findMany({
    where: environmentId
      ? { activeEnvironments: { has: environmentId } }
      : undefined,
    select: {
      id:                 true,
      agentId:            true,
      domain:             true,
      description:        true,
      tags:               true,
      confidence:         true,
      verifiedAt:         true,
      activeEnvironments: true,
      agent: {
        select: { name: true, status: true },
      },
    },
    orderBy: { confidence: 'desc' },
  })

  return Response.json(profiles)
}
