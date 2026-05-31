/**
 * POST /api/setup/reverse-proxy
 *
 * Wizard step — configure reverse proxy on the management node.
 * Only 'none', 'external', and 'docker' are valid here.
 * 'cluster' (deploy into a managed environment) is a post-wizard action.
 *
 * Body shapes:
 *   { type: 'none' }
 *   { type: 'external', publicUrl: string }   — BYO proxy, validates reachability
 *   { type: 'docker',   publicUrl: string }   — Traefik on Docker host, bootstrap.sh activates --profile proxy
 *   { skip: true }                            — same as 'none'
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as { type?: string; publicUrl?: string; skip?: boolean }

  if (body.skip) {
    await upsert('reverse-proxy.type', 'none')
    return NextResponse.json({ ok: true, skipped: true })
  }

  const { type, publicUrl } = body

  if (!type || !['none', 'external', 'docker'].includes(type)) {
    return NextResponse.json({ error: "type must be 'none', 'external', or 'docker'" }, { status: 400 })
  }

  if (type !== 'none' && !publicUrl) {
    return NextResponse.json({ error: 'publicUrl is required' }, { status: 400 })
  }

  // For 'external': validate the URL is reachable right now (proxy is already running).
  // For 'docker': skip validation — Traefik won't be running until bootstrap.sh restarts
  //   with --profile proxy. The stored publicUrl is unverified until then; the UI should
  //   surface a warning prompting the user to re-verify after bootstrap.sh runs.
  if (type === 'external' && publicUrl) {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(publicUrl)
    } catch {
      return NextResponse.json({ error: 'publicUrl is not a valid URL' }, { status: 400 })
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return NextResponse.json({ error: 'publicUrl must use http or https' }, { status: 400 })
    }
    try {
      const res = await fetch(`${publicUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) {
        return NextResponse.json({ error: `Public URL returned ${res.status} — check the URL and try again` }, { status: 502 })
      }
    } catch {
      return NextResponse.json({ error: 'Could not reach publicUrl — check URL and try again' }, { status: 502 })
    }
  }

  await upsert('reverse-proxy.type', type)
  if (publicUrl) await upsert('reverse-proxy.public-url', publicUrl.replace(/\/$/, ''))

  return NextResponse.json({ ok: true, type, publicUrl: publicUrl ?? null })
}

async function upsert(key: string, value: string) {
  await prisma.systemSetting.upsert({
    where: { key }, update: { value }, create: { key, value },
  })
}
