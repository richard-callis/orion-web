import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { buildContentManifests } from '@/lib/content-nova'
import { proposeChange } from '@/lib/gitops'
import type { PolicyConfig } from '@/lib/gitops-policy'
import type { Nova } from '@/lib/nebula'

/**
 * POST /api/novas/[id]/import — Import a Nova
 *
 * For agent-type Novas: Creates a new Agent record in the database.
 * For service-type Novas: Would create a HelmRelease or manifests (future).
 * For content-type Novas: opens a GitOps PR provisioning a PVC + sync
 *   CronJob and mounting them into the target environment's Deployment.
 *
 * Body: { environmentId?, agentName?, agentRole?, systemPrompt? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await req.json()
  const nova = await prisma.nova.findUnique({
    where: { id: (await params).id },
  })

  if (!nova) {
    return NextResponse.json({ error: 'Nova not found' }, { status: 404 })
  }

  const config = nova.config as any
  const novaType = config?.type || 'service'

  if (novaType === 'agent') {
    // Create a new Agent record from the Nova definition
    const agentName = body.agentName || nova.displayName || nova.name

    // Check if an agent with this name already exists
    const existingAgent = await prisma.agent.findUnique({
      where: { name: agentName },
    })

    if (existingAgent) {
      return NextResponse.json(
        { error: `Agent "${agentName}" already exists` },
        { status: 409 }
      )
    }

    const agent = await prisma.agent.create({
      data: {
        name: agentName,
        type: 'claude', // Default to claude; can be overridden via config
        role: body.agentRole || config.contextConfig?.role || null,
        description: nova.description || nova.displayName,
        metadata: {
          systemPrompt: body.systemPrompt || config.systemPrompt || '',
          contextConfig: config.contextConfig || {},
        } as any,
        novaId: nova.id,
      },
    })

    // Create NovaDeployment record
    await prisma.novaDeployment.create({
      data: {
        novaId: nova.id,
        agentId: agent.id,
        status: 'deployed',
        version: nova.version,
        metadata: { importedAt: new Date().toISOString() },
      },
    })

    return NextResponse.json({
      agentId: agent.id,
      message: `Agent "${agentName}" created from Nova "${nova.name}"`,
    })
  }

  if (novaType === 'service') {
    // For service-type Novas, we would:
    // 1. Generate manifests from the Nova config
    // 2. Create a GitOps PR with the changes
    // 3. Return job ID for tracking
    // This is implemented in a future step.

    return NextResponse.json({
      message: `Service Nova "${nova.name}" ready for deployment (GitOps integration pending)`,
      novaName: nova.name,
      version: nova.version,
    })
  }

  if (novaType === 'content') {
    if (!body.environmentId) {
      return NextResponse.json({ error: 'environmentId is required for content Novas' }, { status: 400 })
    }

    const env = await prisma.environment.findUnique({ where: { id: body.environmentId } })
    if (!env) {
      return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
    }
    if (!env.gitOwner || !env.gitRepo) {
      return NextResponse.json(
        { error: 'Environment has no git repo configured. Run bootstrap first.' },
        { status: 422 },
      )
    }

    const changes = await buildContentManifests(
      { id: nova.id, name: nova.name, config } as Nova,
      { gitOwner: env.gitOwner, gitRepo: env.gitRepo, repoPath: env.repoPath ?? undefined },
    )

    const policy = (env.policyConfig ?? {}) as PolicyConfig
    const result = await proposeChange({
      owner: env.gitOwner,
      repo: env.gitRepo,
      title: `Install content Nova "${nova.name}"`,
      reasoning: `Provisions a PVC + sync CronJob for content Nova "${nova.name}" (source: ${config.contentSource?.gitUrl}#${config.contentSource?.path}) and mounts it into the ${config.contentTarget?.deployment} Deployment at ${config.contentTarget?.mountPath}.`,
      operationDescription: `Add a PVC, a CronJob, and a volume mount for content sync — no destructive changes to existing resources`,
      changes,
      policy,
    })

    await prisma.gitOpsPR.create({
      data: {
        environmentId: body.environmentId,
        prNumber: result.prNumber,
        title: `Install content Nova "${nova.name}"`,
        operation: result.classification.operation,
        decision: result.classification.decision,
        status: result.merged ? 'merged' : 'open',
        prUrl: result.prUrl,
        reasoning: `Content Nova import: ${nova.name}`,
        branch: result.branch,
        mergedAt: result.merged ? new Date() : null,
      },
    })

    await prisma.novaDeployment.upsert({
      where: { novaId_environmentId: { novaId: nova.id, environmentId: body.environmentId } },
      create: {
        novaId: nova.id,
        environmentId: body.environmentId,
        status: result.merged ? 'deployed' : 'pending-review',
        version: nova.version,
        metadata: { prUrl: result.prUrl, importedAt: new Date().toISOString() },
      },
      update: {
        status: result.merged ? 'deployed' : 'pending-review',
        version: nova.version,
        metadata: { prUrl: result.prUrl, importedAt: new Date().toISOString() },
      },
    })

    return NextResponse.json({
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      merged: result.merged,
      message: result.merged
        ? `Content Nova "${nova.name}" installed — PR #${result.prNumber} auto-merged.`
        : `Content Nova "${nova.name}" proposed as PR #${result.prNumber}, awaiting review.`,
    })
  }

  return NextResponse.json(
    { error: `Unknown Nova type: ${novaType}` },
    { status: 400 }
  )
}
