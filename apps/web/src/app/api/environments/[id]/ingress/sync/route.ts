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

  // Load all known domains for matching
  const domains = await prisma.domain.findMany({ select: { id: true, name: true, type: true } })
  const domainByName = new Map(domains.map((d: any) => [d.name.toLowerCase(), d]))

  // Build a lookup: suffix (parent domain) -> domain record
  // e.g. "khalisio.com" -> domain record, "khalis.corp" -> domain record
  const parentDomainLookup = new Map<string, { id: string; name: string }>()
  for (const d of domains) {
    const name = d.name.toLowerCase()
    parentDomainLookup.set(name, { id: d.id, name })
    // Also register each label-level suffix for nested subdomains
    const parts = name.split('.')
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('.')
      parentDomainLookup.set(suffix, { id: d.id, name })
    }
  }

  // Create or find an ingress point per domain for this environment
  const ingressPointByDomain = new Map<string, any>()
  for (const [domainSuffix] of parentDomainLookup) {
    let ip = await prisma.ingressPoint.findFirst({
      where: { environmentId: params.id, type: 'traefik', domainId: parentDomainLookup.get(domainSuffix)!.id },
    })
    if (!ip) {
      const d = parentDomainLookup.get(domainSuffix)!
      ip = await prisma.ingressPoint.create({
        data: {
          domainId:      d.id,
          environmentId: params.id,
          name:          `${env.name} (${d.name})`,
          type:          'traefik',
          certManager:   true,
          status:        'active',
        },
      })
    }
    ingressPointByDomain.set(domainSuffix, ip)
  }

  let created = 0
  let skipped = 0

  for (const rule of ingresses) {
    const host = rule.host.trim().toLowerCase()
    if (!host) continue

    // Match host to a parent domain (e.g. "auth.khalisio.com" -> "khalisio.com")
    const parts = host.split('.')
    let matchedDomain: { id: string; name: string } | undefined
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('.')
      if (parentDomainLookup.has(suffix)) {
        matchedDomain = parentDomainLookup.get(suffix)!
        break
      }
    }
    if (!matchedDomain) continue // no matching domain

    const ingressPoint = ingressPointByDomain.get(matchedDomain.name)!

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
