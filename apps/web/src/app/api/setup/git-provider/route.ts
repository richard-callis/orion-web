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
import { randomBytes } from 'crypto'

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

  // ── Bundled Gitea: bootstrap admin token via basic auth ───────────────────

  let token = rawToken ?? ''

  if (type === 'gitea-bundled') {
    if (!adminUser || !adminPassword) {
      return NextResponse.json(
        { error: 'adminUser and adminPassword are required for bundled Gitea' },
        { status: 400 },
      )
    }

    const giteaProvider = new GiteaGitProvider({
      url: 'http://gitea:3000',
      token: '',
    })

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
    if (!token) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }
    if ((type === 'gitea' || type === 'gitlab') && !url) {
      return NextResponse.json({ error: 'url is required for this provider type' }, { status: 400 })
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: { value: config as any },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: { key: 'git.provider.config', value: config as any },
  })

  // Invalidate the in-process provider cache so the new config is picked up immediately
  invalidateGitProviderCache()

  return NextResponse.json({ ok: true })
}
