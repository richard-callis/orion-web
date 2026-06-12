/**
 * POST /api/setup/git-provider
 *
 * Wizard step 3 — configure the git provider.
 *
 * Accepted body shapes:
 *
 * Bundled Gitea (deployed alongside ORION):
 *   { type: 'gitea-bundled', adminUser: string, adminPassword: string, org: string }
 *   → ORION calls Gitea API with basic auth to create an admin token, stores it.
 *
 * External Gitea / GitHub / GitLab:
 *   { type: 'gitea' | 'github' | 'gitlab', url?: string, token: string, org: string }
 *   → Validates connectivity, stores config.
 *
 * Skip:
 *   { skip: true }
 *   → Allowed — GitOps features won't work until configured post-wizard.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'
import { createProvider, invalidateGitProviderCache, type GitProviderConfig, type GitProviderType } from '@/lib/git-provider'
import { GiteaGitProvider } from '@/lib/git-provider/gitea-provider'
import { encryptJson } from '@/lib/encryption'
import { randomBytes } from 'crypto'
import { seedSystemNebula } from '@/lib/seed-system-nebula'
import { logAudit } from '@/lib/audit'

function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  const privatePatterns = [
    /^127\./, /^10\./, /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./,
    /^::1$/, /^fc00:/i, /^fe80:/i,
  ]
  return privatePatterns.some(p => p.test(hostname))
}

export async function POST(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()

  if (body.skip) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  const { type, url, token: rawToken, adminUser, adminPassword, org } = body as {
    type: GitProviderType
    url?: string
    token?: string
    adminUser?: string
    adminPassword?: string
    org: string
  }

  if (!type || !org) {
    return NextResponse.json({ error: 'type and org are required' }, { status: 400 })
  }

  // ── Bundled Gitea: use pre-generated token or bootstrap via basic auth ────

  let token = rawToken ?? ''

  if (type === 'gitea-bundled') {
    if (token) {
      // Pre-generated token from bootstrap.sh — use directly, no basic auth needed
    } else if (adminUser && adminPassword) {
      // Fallback: create token via basic auth
      const giteaProvider = new GiteaGitProvider({ url: 'http://gitea:3000', token: '' })
      try {
        const tokenName = `orion-admin-${Date.now()}`
        token = await giteaProvider.createAdminToken(adminUser, adminPassword, tokenName)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return NextResponse.json(
          { error: `Failed to create Gitea admin token: ${msg}` },
          { status: 502 },
        )
      }
    } else {
      return NextResponse.json(
        { error: 'token or adminUser+adminPassword are required for bundled Gitea' },
        { status: 400 },
      )
    }
  } else {
    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }
    if ((type === 'gitea' || type === 'gitlab') && !url) {
      return NextResponse.json({ error: 'url is required for this provider type' }, { status: 400 })
    }
  }

  // ── SSRF validation — block private/internal hosts ───────────────────────
  // The provider URL is used for a server-side fetch (provider.isHealthy()).
  // Without this check, an operator can point the provider at an internal
  // service (169.254.169.254, 10.x.x.x, localhost) and read the response
  // via error messages. The reverse-proxy endpoint already implements this
  // protection; applying the same check here.
  if (url) {
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return NextResponse.json({ error: 'Provider URL must use http or https' }, { status: 400 })
      }
      if (isPrivateHost(parsed.hostname)) {
        return NextResponse.json(
          { error: 'Provider URL must not point to a private/internal host' },
          { status: 400 }
        )
      }
    } catch {
      return NextResponse.json({ error: 'Invalid provider URL' }, { status: 400 })
    }
  }

  // ── Validate connectivity ─────────────────────────────────────────────────

  const webhookSecret = randomBytes(32).toString('hex')
  const config: GitProviderConfig = { type, url, token, org, webhookSecret }

  try {
    const provider = createProvider(config)
    const healthy = await provider.isHealthy()
    if (!healthy) {
      return NextResponse.json(
        { error: 'Could not connect to git provider. Check the URL and token.' },
        { status: 502 },
      )
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: `Git provider connection failed: ${msg}` },
      { status: 502 },
    )
  }

  // ── Persist config ────────────────────────────────────────────────────────

  await prisma.systemSetting.upsert({
    where:  { key: 'git.provider.config' },
    update: { value: encryptJson(config) },
    create: { key: 'git.provider.config', value: encryptJson(config) },
  })

  // Invalidate the in-process provider cache so the new config is picked up immediately
  invalidateGitProviderCache()

  // Seed system Nebula in background (don't block the response)
  seedSystemNebula().catch(err => console.error('[Nebula] System nebula seed failed:', err))

  void logAudit({
    userId: 'system',
    action: 'admin_action',
    target: 'git_provider_config',
    detail: { source: 'setup_wizard', providerType: type, org },
  })

  return NextResponse.json({ ok: true })
}
