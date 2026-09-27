import { randomBytes } from 'crypto'
import { bootstrapEnvironmentRepo } from '../gitops'
import { getGitProvider, getGitProviderConfig } from '../git-provider'
import { ORION_URL, MANAGEMENT_IP } from './config'
import type { BootstrapEvent } from './types'

export interface GitRepoInfo {
  owner: string
  repo: string
  url: string
  healthy: boolean
}

/** Ensure a git repo exists for this environment. Returns repo info or null. */
export async function ensureGitRepo(env: { name: string; gitOwner: string | null; gitRepo: string | null; id: string }, emit: (event: BootstrapEvent) => void): Promise<GitRepoInfo | null> {
  const gitOwner = env.gitOwner ?? 'orion'
  const gitRepo  = env.gitRepo  ?? env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const orionUrl = ORION_URL.replace(/\/$/, '')

  const provider = await getGitProvider()
  const providerHealthy = await provider.isHealthy()

  let resolvedGitOwner = gitOwner
  if (!providerHealthy) {
    emit({ type: 'log', message: 'Git provider not reachable — skipping repo creation (will retry on next bootstrap)' })
    return { owner: resolvedGitOwner, repo: gitRepo, url: '', healthy: false }
  }

  try {
    const createdRepo = await bootstrapEnvironmentRepo({
      owner: gitOwner,
      repoName: gitRepo,
      description: `ORION-managed environment: ${env.name}`,
      webhookUrl: `${orionUrl}/api/webhooks/gitea`,
      webhookSecret: randomBytes(32).toString('hex'),
    })
    resolvedGitOwner = createdRepo.fullName.split('/')[0]
    // Build the cluster-reachable clone URL — must match the base URL registered in
    // the ArgoCD credential Secret by argocd-bootstrap.ts so ArgoCD can find credentials.
    // getPRUrl() uses publicUrl (Cloudflare/HTTPS), which ArgoCD can't match. Use the
    // internal URL instead: management IP for bundled Gitea, config.url for external.
    const gitCfg = await getGitProviderConfig()
    const internalBase = gitCfg?.type === 'gitea-bundled'
      ? `http://${MANAGEMENT_IP}:3002`
      : (gitCfg?.url ?? 'https://github.com')
    const cloneUrl = `${internalBase.replace(/\/$/, '')}/${resolvedGitOwner}/${gitRepo}.git`
    emit({ type: 'log', message: `Git repo ready: ${createdRepo.htmlUrl}` })
    return { owner: resolvedGitOwner, repo: gitRepo, url: cloneUrl, healthy: true }
  } catch (err) {
    console.error(`[bootstrap] Failed to create repo: ${err}`)
    emit({ type: 'log', message: `Failed to create git repo: ${err instanceof Error ? err.message : String(err)}` })
    return null
  }
}
