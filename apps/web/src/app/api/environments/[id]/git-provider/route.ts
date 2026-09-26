/**
 * GET /api/environments/:id/git-provider
 *
 * Returns the git credential a cluster gateway uses to register this
 * environment's repo with ArgoCD.
 *
 * Auth: Bearer gatewayToken (same as heartbeat/sync-status).
 *
 * M2: the credential is read-only and scoped to this environment's repo
 * (lib/environment-git-credentials.ts) — a compromised gateway can no longer
 * write to every repo in the org. The org-wide token is only returned under the
 * explicit, opt-in fallback, and is flagged as such.
 *
 * Air-gap design: returns cluster-reachable URLs only (management IP / internal
 * hostnames). Never returns public/Cloudflare URLs — those are browser-only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { constantTimeCompare } from '@/lib/security/webhook-auth'
import { getGitProviderConfig } from '@/lib/git-provider'
import { getGatewayGitCredential, GitCredentialUnavailableError } from '@/lib/environment-git-credentials'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Verify gateway token
  const auth = req.headers.get('authorization')
  const env = await prisma.environment.findUnique({ where: { id: (await params).id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expectedToken = env.gatewayToken
  // SOC2 [M2]: constant-time comparison (was `!==`, a timing oracle on the token)
  if (!expectedToken || !constantTimeCompare(auth ?? '', `Bearer ${expectedToken}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = await getGitProviderConfig()
  if (!config) {
    return NextResponse.json({ error: 'Git provider not configured' }, { status: 404 })
  }

  let credential
  try {
    credential = await getGatewayGitCredential(env)
  } catch (err) {
    if (err instanceof GitCredentialUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[git-provider] could not issue git credential for "${env.name}": ${msg}`)
    return NextResponse.json({ error: 'Could not issue a git credential for this environment' }, { status: 502 })
  }

  return NextResponse.json({
    type: config.type,
    org: config.org,
    // Legacy fields for gateways that predate `credential`: they register a
    // repo-creds Secret using `url` as the URL prefix and `token` as the password.
    // Pointing `url` at the exact repo keeps that prefix to this one repo.
    url: credential.repoUrl,
    token: credential.kind === 'https-token' ? credential.secret : '',
    credential: {
      kind: credential.kind,
      repoUrl: credential.repoUrl,
      username: credential.username,
      ...(credential.kind === 'ssh-key'
        ? { sshPrivateKey: credential.secret }
        : { password: credential.secret }),
      orgTokenFallback: credential.orgTokenFallback,
    },
  })
}
