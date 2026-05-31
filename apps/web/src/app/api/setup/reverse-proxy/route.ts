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

  // Validate publicUrl format and reject internal addresses.
  // We do NOT make a server-side reachability fetch — that would be an SSRF
  // vector regardless of hostname validation. The UI should prompt the operator
  // to verify reachability after saving (same as the 'docker' type).
  if ((type === 'external' || type === 'docker') && publicUrl) {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(publicUrl)
    } catch {
      return NextResponse.json({ error: 'publicUrl is not a valid URL' }, { status: 400 })
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return NextResponse.json({ error: 'publicUrl must use http or https' }, { status: 400 })
    }
    if (isPrivateHost(parsedUrl.hostname)) {
      return NextResponse.json({ error: 'publicUrl must be a public hostname, not an internal IP' }, { status: 400 })
    }
  }

  await upsert('reverse-proxy.type', type)
  if (publicUrl) await upsert('reverse-proxy.public-url', publicUrl.replace(/\/$/, ''))

  return NextResponse.json({ ok: true, type, publicUrl: publicUrl ?? null })
}

function isPrivateHost(hostname: string): boolean {
  // Reject loopback, private RFC1918, link-local, and cloud metadata ranges.
  if (hostname === 'localhost') return true
  const privatePatterns = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^169\.254\./,   // link-local / AWS metadata
    /^::1$/,         // IPv6 loopback
    /^fc00:/i,       // IPv6 ULA
    /^fe80:/i,       // IPv6 link-local
  ]
  return privatePatterns.some(p => p.test(hostname))
}

async function upsert(key: string, value: string) {
  await prisma.systemSetting.upsert({
    where: { key }, update: { value }, create: { key, value },
  })
}
