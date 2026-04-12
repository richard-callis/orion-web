/**
 * POST /api/gitops/propose
 *
 * AI agents call this to propose a GitOps change.
 * Runs the full loop: branch → commit → policy → PR → auto-merge or label for review.
 *
 * Body:
 * {
 *   environmentId: string
 *   title: string
 *   reasoning: string        // AI explanation of why this change is needed
 *   operationDescription: string  // plain-language summary for policy classification
 *   changes: Array<{ path: string; content: string }>
 * }
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { proposeChange } from '@/lib/gitops'
import type { PolicyConfig } from '@/lib/gitops-policy'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { environmentId, title, reasoning, operationDescription, changes } = body

  if (!environmentId || !title || !reasoning || !operationDescription || !changes?.length) {
    return NextResponse.json(
      { error: 'environmentId, title, reasoning, operationDescription, and changes are required' },
      { status: 400 },
    )
  }

  const env = await prisma.environment.findUnique({ where: { id: environmentId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (!env.gitOwner || !env.gitRepo) {
    return NextResponse.json(
      { error: 'Environment has no git repo configured. Run bootstrap first.' },
      { status: 422 },
    )
  }

  const policy = (env.policyConfig ?? {}) as PolicyConfig

  const result = await proposeChange({
    owner: env.gitOwner,
    repo: env.gitRepo,
    title,
    reasoning,
    operationDescription,
    changes,
    policy,
  })

  // Record the PR in our DB for the dashboard
  await prisma.gitOpsPR.create({
    data: {
      environmentId,
      prNumber:  result.prNumber,
      title,
      operation: result.classification.operation,
      decision:  result.classification.decision,
      status:    result.merged ? 'merged' : 'open',
      prUrl:     result.prUrl,
      reasoning,
      branch:    result.branch,
      mergedAt:  result.merged ? new Date() : null,
    },
  })

  return NextResponse.json({
    prNumber:   result.prNumber,
    prUrl:      result.prUrl,
    merged:     result.merged,
    decision:   result.classification.decision,
    operation:  result.classification.operation,
    reason:     result.classification.reason,
  })
}
