/**
 * POST /api/ingress/points/:id/set-as-orion-proxy
 *
 * Marks a bootstrapped IngressPoint as Orion's reverse proxy.
 * Stores its public URL in SystemSettings so gateway manifests use it.
 *
 * Body:
 *   {}            — set this IngressPoint as the proxy
 *   { clear: true } — remove the proxy config (manifests revert to management IP)
 *
 * Stores:
 *   SystemSetting 'reverse-proxy.public-url'      = https://<domain>
 *   SystemSetting 'reverse-proxy.ingress-point-id' = <id>
 *
 * Clearing deletes both settings.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as { clear?: boolean }

  if (body.clear) {
    await prisma.systemSetting.deleteMany({
      where: { key: { in: ['reverse-proxy.public-url', 'reverse-proxy.ingress-point-id'] } },
    })
    return NextResponse.json({ ok: true, cleared: true })
  }

  const point = await prisma.ingressPoint.findUnique({
    where: { id: (await params).id },
    include: { domain: true },
  })
  if (!point) return NextResponse.json({ error: 'IngressPoint not found' }, { status: 404 })

  // point.domain.name is the apex domain (e.g. "khalisio.com").
  // The actual Orion hostname may be a subdomain (e.g. "orion.khalisio.com") configured
  // in the IngressRoute. For now we use the apex; the user can override publicUrl in .env.
  const publicUrl = `https://${point.domain.name}`

  await upsert('reverse-proxy.public-url', publicUrl)
  await upsert('reverse-proxy.ingress-point-id', (await params).id)

  return NextResponse.json({ ok: true, publicUrl })
}

async function upsert(key: string, value: string) {
  await prisma.systemSetting.upsert({
    where: { key }, update: { value }, create: { key, value },
  })
}
