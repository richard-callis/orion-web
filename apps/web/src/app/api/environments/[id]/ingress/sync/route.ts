/**
 * POST /api/environments/:id/ingress/sync
 *
 * Called by the Gateway's IngressWatcher with a snapshot of all K8s Ingress resources.
 * Upserts Domain / IngressPoint / IngressRoute records without clobbering user edits
 * (comments, enabled/disabled state are preserved on existing rows).
 *
 * Auth: Bearer gatewayToken (same token used for heartbeats).
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export interface K8sIngressRule {
  host: string
  paths: string[]   // e.g. ["/", "/api"]
  tls: boolean
  namespace: string
  ingressName: string
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Verify gateway token
  const auth = req.headers.get('authorization')
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expectedToken = env.gatewayToken
  if (expectedToken && auth !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { ingresses } = (await req.json()) as { ingresses: K8sIngressRule[] }
  if (!Array.isArray(ingresses)) {
    return NextResponse.json({ error: 'ingresses must be an array' }, { status: 400 })
  }

  // Load known domain names from system settings for matching
  const domainSettings = await prisma.systemSetting.findMany({
    where: { key: { in: ['domain.internal', 'domain.public'] } },
  })
  const knownDomains = domainSettings.map(s => ({
    name: (s.value as string).toLowerCase(),
    type: s.key === 'domain.public' ? 'public' : 'internal',
  }))

  // Find or create the IngressPoint for this environment (one per environment, type=traefik)
  let ingressPoint = await prisma.ingressPoint.findFirst({
    where: { environmentId: params.id, type: 'traefik' },
  })

  if (!ingressPoint) {
    // Determine the domain for this environment's ingress point
    // Default to the first known domain or create one from system settings
    let domainRecord = await prisma.domain.findFirst({ orderBy: { createdAt: 'asc' } })
    if (!domainRecord && knownDomains.length > 0) {
      domainRecord = await prisma.domain.create({
        data: { name: knownDomains[0].name, type: knownDomains[0].type },
      })
    }
    if (!domainRecord) {
      return NextResponse.json({ error: 'No domain configured — complete the setup wizard first' }, { status: 422 })
    }

    ingressPoint = await prisma.ingressPoint.create({
      data: {
        domainId:      domainRecord.id,
        environmentId: params.id,
        name:          env.name,
        type:          'traefik',
        certManager:   true,
        status:        'active',
      },
    })
  }

  let created = 0
  let skipped = 0

  for (const rule of ingresses) {
    const host = rule.host.trim().toLowerCase()
    if (!host) continue

    // Upsert: create only if host doesn't already exist under this ingress point
    const existing = await prisma.ingressRoute.findFirst({
      where: { ingressPointId: ingressPoint.id, host },
    })

    if (existing) {
      // Preserve user edits — only update paths if they changed
      const newPaths = JSON.stringify(rule.paths ?? [])
      const oldPaths = JSON.stringify(existing.paths)
      if (newPaths !== oldPaths) {
        await prisma.ingressRoute.update({
          where: { id: existing.id },
          data: { paths: rule.paths ?? [] },
        })
      }
      skipped++
    } else {
      await prisma.ingressRoute.create({
        data: {
          ingressPointId: ingressPoint.id,
          host,
          paths:   rule.paths ?? [],
          tls:     rule.tls ?? true,
          comment: `${rule.namespace}/${rule.ingressName}`,
          enabled: true,
        },
      })
      created++
    }
  }

  return NextResponse.json({ ok: true, created, skipped, total: ingresses.length })
}
