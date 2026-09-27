/**
 * ArgoCD Bootstrap
 *
 * Runs at cluster gateway startup. Installs ArgoCD into the cluster if not
 * already present, then registers the git repo configured in Orion.
 *
 * Designed to be idempotent — safe to call on every restart.
 */

import { run } from './lib/run.js'

/**
 * ArgoCD release to install. Defaults to the moving `stable` manifest for
 * backward compatibility; set ARGOCD_VERSION (e.g. "v2.14.11") to pin it so
 * installs are reproducible.
 */
const ARGOCD_VERSION = process.env.ARGOCD_VERSION ?? 'stable'
const ARGOCD_INSTALL_URL = `https://raw.githubusercontent.com/argoproj/argo-cd/${ARGOCD_VERSION}/manifests/install.yaml`

export interface GitProviderInfo {
  type: 'gitea-bundled' | 'gitea' | 'github' | 'gitlab'
  /** Repo clone URL — already adjusted for cluster reachability by the Orion API.
   *  May be empty string if git provider is not fully configured; treat empty as "skip". */
  url: string
  token: string   // legacy: password for `url` (older ORION returned the org-wide token here)
  org: string     // default org/user namespace
  /** M2: read-only credential scoped to this environment's repo (newer ORION). */
  credential?: {
    kind: 'https-token' | 'ssh-key'
    repoUrl: string
    username: string
    password?: string
    sshPrivateKey?: string
    orgTokenFallback?: boolean
  }
}

/**
 * Build the ArgoCD Secret for the credential ORION issued.
 *
 * Both shapes use a `repo-creds` credential template, which ArgoCD matches by
 * URL prefix. For a scoped credential the prefix is the env repo itself (minus
 * any `.git`), so Applications match whether their repoURL has the suffix or
 * not; the credential only grants access to that one repo anyway. Older ORION
 * versions only return { url, token } (the org-wide token, prefix = provider
 * base URL). Either way the Secret is named `orion-git-repo`, so applying it
 * replaces an older org-token Secret in place.
 */
export function buildRepoSecretYaml(gitConfig: GitProviderInfo): { yaml: string; repoUrl: string } {
  // B1 fix: YAML injection — JSON-encode every value. YAML is a JSON superset, so
  // JSON strings are valid YAML scalars with all special characters escaped.
  const q = (v: string) => JSON.stringify(v)
  const cred = gitConfig.credential

  if (cred) {
    const prefix = cred.repoUrl.replace(/\.git$/, '')
    const secretFields = cred.kind === 'ssh-key'
      ? [`  sshPrivateKey: ${q(cred.sshPrivateKey ?? '')}`]
      : [`  username: ${q(cred.username)}`, `  password: ${q(cred.password ?? '')}`]
    return {
      repoUrl: cred.repoUrl,
      yaml: [
        'apiVersion: v1',
        'kind: Secret',
        'metadata:',
        '  name: orion-git-repo',
        '  namespace: argocd',
        '  labels:',
        '    argocd.argoproj.io/secret-type: repo-creds',
        'stringData:',
        '  type: git',
        `  url: ${q(prefix)}`,
        ...secretFields,
      ].join('\n'),
    }
  }

  // Legacy: repo-creds is a credential template — ArgoCD matches it by URL prefix.
  const username = gitConfig.type === 'github' ? 'x-access-token' : 'orion'
  return {
    repoUrl: gitConfig.url,
    yaml: [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      '  name: orion-git-repo',
      '  namespace: argocd',
      '  labels:',
      '    argocd.argoproj.io/secret-type: repo-creds',
      'stringData:',
      '  type: git',
      `  url: ${q(gitConfig.url)}`,
      `  password: ${q(gitConfig.token)}`,
      `  username: ${q(username)}`,
    ].join('\n'),
  }
}


export async function bootstrapArgoCD(
  orionUrl: string,
  environmentId: string,
  gatewayToken: string,
): Promise<void> {
  // Step 1: Check if ArgoCD namespace exists
  let argocdInstalled = false
  try {
    await run('kubectl', ['get', 'namespace', 'argocd'], { timeoutMs: 10_000 })
    argocdInstalled = true
    console.log('[argocd-bootstrap] ArgoCD already installed, skipping install')
  } catch {
    // ArgoCD not installed — proceed with install
  }

  if (!argocdInstalled) {
    try {
      console.log('[argocd-bootstrap] Installing ArgoCD into cluster...')

      // Step 2: Create namespace and apply ArgoCD manifests
      await run('kubectl', ['create', 'namespace', 'argocd'], { timeoutMs: 10_000 })
      console.log('[argocd-bootstrap] Namespace argocd created')

      await run('kubectl', ['apply', '-n', 'argocd', '-f', ARGOCD_INSTALL_URL], { timeoutMs: 120_000 })
      console.log(`[argocd-bootstrap] ArgoCD manifests applied (${ARGOCD_VERSION})`)

      // Step 3: Wait for ArgoCD server to be ready
      await run('kubectl', [
        'wait', '--for=condition=available', 'deployment/argocd-server', '-n', 'argocd', '--timeout=120s',
      ], { timeoutMs: 130_000 })
      console.log('[argocd-bootstrap] ArgoCD server is ready')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[argocd-bootstrap] Failed to install ArgoCD (non-fatal): ${msg}`)
      // Don't prevent gateway from starting if ArgoCD bootstrap fails
    }
  }

  // Step 4: Fetch the git credential from Orion
  try {
    const res = await fetch(
      `${orionUrl.replace(/\/$/, '')}/api/environments/${environmentId}/git-provider`,
      {
        headers: { Authorization: `Bearer ${gatewayToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      // 409: ORION refused to issue a repo-scoped credential and the org-token
      // fallback is off — the body says why.
      const detail = await res.json().then((b: { error?: string }) => b?.error ?? '').catch(() => '')
      console.warn(`[argocd-bootstrap] Git provider config returned ${res.status}${detail ? `: ${detail}` : ''} — skipping repo registration`)
      return
    }
    const gitConfig: GitProviderInfo = await res.json()
    if (!gitConfig.url && !gitConfig.credential?.repoUrl) {
      console.warn('[argocd-bootstrap] Git provider URL is empty — skipping repo registration')
      return
    }
    if (gitConfig.credential?.orgTokenFallback) {
      console.warn('[argocd-bootstrap] ORION issued the org-wide git token (fallback enabled) — not repo-scoped')
    }

    // Step 5: Register (or refresh) the repo Secret. Always applied — kubectl apply
    // is idempotent, and a rotated credential must replace the previous one.
    try {
      const { yaml, repoUrl } = buildRepoSecretYaml(gitConfig)
      // Pipe the Secret through stdin — never touches disk, no shell involved.
      await run('kubectl', ['apply', '-f', '-', '-n', 'argocd'], { timeoutMs: 15_000, input: yaml })
      console.log(`[argocd-bootstrap] Registered git repo ${repoUrl} in ArgoCD (${gitConfig.credential?.kind ?? 'legacy token'})`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[argocd-bootstrap] Failed to register git repo in ArgoCD (non-fatal): ${msg}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[argocd-bootstrap] Failed to fetch git provider config (non-fatal): ${msg}`)
  }
}
