/**
 * GET /api/gitops/prs
 *
 * Returns GitOps PRs across all environments for the dashboard.
 *
 * Query params:
 *   ?status=open|merged|closed   (default: all)
 *   ?environmentId=<id>          (filter to one environment)
 *   ?limit=<n>                   (default 50)
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const status        = searchParams.get('status')        ?? undefined
  const environmentId = searchParams.get('environmentId') ?? undefined
  const limit         = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200)

  const prs = await prisma.gitOpsPR.findMany({
    where: {
      ...(status        ? { status }        : {}),
      ...(environmentId ? { environmentId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      environment: { select: { id: true, name: true, type: true, gitOwner: true, gitRepo: true } },
    },
  })

  return NextResponse.json(prs)
}
