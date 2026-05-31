/**
 * GET /api/environments/:id/git-provider
 *
 * Returns the git provider config for a cluster gateway to use when
 * bootstrapping ArgoCD repo registration.
 *
 * Auth: Bearer gatewayToken (same as heartbeat/sync-status).
 *
 * Air-gap design: returns cluster-reachable URLs only (management IP / internal
 * hostnames). Never returns public/Cloudflare URLs — those are browser-only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getGitProviderConfig } from '@/lib/git-provider'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  // Verify gateway token
  const auth = req.headers.get('authorization')
  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const expectedToken = env.gatewayToken
  if (!expectedToken || auth !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const config = await getGitProviderConfig()
  if (!config) {
    return NextResponse.json({ error: 'Git provider not configured' }, { status: 404 })
  }

  // Resolve the cluster-reachable URL for the git provider.
  // For gitea-bundled: use http://<MANAGEMENT_IP>:3002 so traffic stays on the
  // private network and works in air-gapped deployments. This mirrors how
  // ORION_CALLBACK_URL uses http://<MANAGEMENT_IP>:3000 for gateway→Orion traffic.
  // Port 3002 is the host-exposed port for the bundled Gitea container (docker-compose.yml).
  let url: string
  if (config.type === 'gitea-bundled') {
    const managementIp = process.env.MANAGEMENT_IP
    if (!managementIp) {
      return NextResponse.json(
        { error: 'MANAGEMENT_IP not set — cannot derive cluster-reachable Gitea URL' },
        { status: 500 },
      )
    }
    url = `http://${managementIp}:3002`
  } else {
    // External providers: the user supplied a URL during wizard setup.
    // config.url is optional for github (uses api.github.com implicitly) but the
    // bootstrap only needs the base clone URL, not the API URL — use the org pattern.
    url = config.url ?? (config.type === 'github' ? 'https://github.com' : '')
  }

  if (!url) {
    return NextResponse.json(
      { error: 'No cluster-reachable git URL available' },
      { status: 404 },
    )
  }

  return NextResponse.json({
    type: config.type,
    url,
    token: config.token,
    org: config.org,
  })
}
