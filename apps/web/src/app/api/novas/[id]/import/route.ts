import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * POST /api/novas/[id]/import — Import a Nova
 *
 * For agent-type Novas: Creates a new Agent record in the database.
 * For service-type Novas: Would create a HelmRelease or manifests (future).
 *
 * Body: { environmentId?, agentName?, agentRole?, systemPrompt? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await req.json()
  const nova = await prisma.nova.findUnique({
    where: { id: params.id },
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
        },
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

  return NextResponse.json(
    { error: `Unknown Nova type: ${novaType}` },
    { status: 400 }
  )
}
