import { prisma } from '@/lib/db'
import { log, err } from './log'

/**
 * Poll Gitea for open PRs across all environments.
 * - Discovers new orion/auto/* PRs not yet tracked in the DB
 * - Updates status of existing tracked PRs that have since been merged or closed
 * Runs every 60s as a fallback for when webhooks don't fire.
 */
export async function syncGitOpsPRs() {
  const { getGitProvider, isNotFound } = await import('@/lib/git-provider')
  let provider: Awaited<ReturnType<typeof getGitProvider>>
  try {
    provider = await getGitProvider()
    if (!(await provider.isHealthy())) return
  } catch {
    return
  }

  // ── 1. Discover open PRs from Gitea and upsert into DB ──────────────────────
  const envs = await prisma.environment.findMany({
    where: { gitOwner: { not: null }, gitRepo: { not: null } },
    select: { id: true, gitOwner: true, gitRepo: true },
  })

  for (const env of envs) {
    if (!env.gitOwner || !env.gitRepo) continue
    try {
      const remotePRs = await provider.listOpenPRs(env.gitOwner, env.gitRepo)
      for (const rpr of remotePRs) {
        if (!rpr.headBranch.startsWith('orion/')) continue
        await prisma.gitOpsPR.upsert({
          where: { environmentId_prNumber: { environmentId: env.id, prNumber: rpr.number } },
          create: {
            environmentId: env.id,
            prNumber:      rpr.number,
            title:         rpr.title,
            operation:     'unknown',
            decision:      'review',
            status:        'open',
            prUrl:         rpr.htmlUrl,
            branch:        rpr.headBranch,
          },
          update: {},
        })
      }
    } catch (e) {
      // BUG 8 fix: this was silently swallowed with zero logging — a Gitea/GitHub
      // auth failure would stop PR discovery for this environment indefinitely
      // with no operator signal. Log with enough context to diagnose.
      err(`[gitops-sync] Failed to list open PRs for ${env.gitOwner}/${env.gitRepo} (env ${env.id}): ${e instanceof Error ? e.message : e}`)
    }
  }

  // ── 2. Update status of tracked open PRs that have since been merged/closed ──
  const openPRs = await prisma.gitOpsPR.findMany({
    where: { status: 'open' },
    include: { environment: { select: { gitOwner: true, gitRepo: true } } },
  })

  for (const pr of openPRs) {
    const { gitOwner, gitRepo } = pr.environment
    if (!gitOwner || !gitRepo) continue

    try {
      const remotePR = await provider.getPR(gitOwner, gitRepo, pr.prNumber)
      const merged = remotePR.merged
      const closed = remotePR.state === 'closed' || remotePR.state === 'merged'

      if (merged || closed) {
        // BUG 8 fix: use the provider's real merge timestamp when available
        // instead of `new Date()` (the poll time, which can lag the actual
        // merge by up to the 60s poll interval or longer if sync was down).
        const mergedAt = merged ? (remotePR.mergedAt ? new Date(remotePR.mergedAt) : new Date()) : undefined
        await prisma.gitOpsPR.update({
          where: { id: pr.id },
          data: {
            status:   merged ? 'merged' : 'closed',
            mergedAt,
          },
        })
        log(`GitOps sync: PR#${pr.prNumber} in ${gitOwner}/${gitRepo} → ${merged ? 'merged' : 'closed'}`)
      }
    } catch (e) {
      // The PR no longer exists upstream (deleted, or the repo was recreated and
      // numbers reset). Stop tracking it — otherwise it's retried and logged as
      // an error every 60s forever.
      if (isNotFound(e)) {
        await prisma.gitOpsPR.update({
          where: { id: pr.id },
          data: {
            status: 'closed',
            reasoning: [pr.reasoning, `Closed by gitops-sync on ${new Date().toISOString()}: PR#${pr.prNumber} no longer exists in ${gitOwner}/${gitRepo} (404).`]
              .filter(Boolean).join('\n\n'),
          },
        })
        log(`GitOps sync: PR#${pr.prNumber} in ${gitOwner}/${gitRepo} not found upstream → closed`)
        continue
      }
      // BUG 8 fix: log with context instead of silently swallowing.
      err(`[gitops-sync] Failed to sync merge status for PR#${pr.prNumber} in ${gitOwner}/${gitRepo} (env ${pr.environmentId}): ${e instanceof Error ? e.message : e}`)
    }
  }
}
