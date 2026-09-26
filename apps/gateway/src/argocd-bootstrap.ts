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
  /** Repo clone URL base — already adjusted for cluster reachability by the Orion API.
   *  May be empty string if git provider is not fully configured; treat empty as "skip". */
  url: string
  token: string   // API token / PAT
  org: string     // default org/user namespace
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

  // Step 4: Fetch git provider config from Orion
  try {
    const res = await fetch(
      `${orionUrl.replace(/\/$/, '')}/api/environments/${environmentId}/git-provider`,
      {
        headers: { Authorization: `Bearer ${gatewayToken}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      console.warn(`[argocd-bootstrap] Git provider config returned ${res.status} — skipping repo registration`)
      return
    }
    const gitConfig: GitProviderInfo = await res.json()
    if (!gitConfig.url) {
      console.warn('[argocd-bootstrap] Git provider URL is empty — skipping repo registration')
      return
    }
    console.log(`[argocd-bootstrap] Git provider: ${gitConfig.type} (${gitConfig.url})`)

    // Step 5: Check if repo is already registered in ArgoCD
    try {
      const repoUrl = `${gitConfig.url}/${gitConfig.org}`
      const secretsResult = await run('kubectl', [
        'get', 'secret', '-n', 'argocd', '-l', 'argocd.argoproj.io/secret-type=repository', '-o', 'json',
      ], { timeoutMs: 15_000, maxOutput: 0 })
      const secrets = JSON.parse(secretsResult.stdout)
      const items = secrets.items ?? []

      for (const item of items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (item as any).data ?? {}
        if (data.url) {
          const decodedUrl = Buffer.from(data.url, 'base64').toString('utf8')
          if (decodedUrl === repoUrl) {
            console.log(`[argocd-bootstrap] Repo ${repoUrl} already registered in ArgoCD`)
            return
          }
        }
      }
    } catch {
      // If we can't check, proceed with registration (it's idempotent via kubectl apply)
    }

    // Step 6: Register the repo as an ArgoCD repository Secret
    try {
      // repo-creds is a credential template — ArgoCD matches it by URL prefix, so
      // a single Secret covers all repos under gitConfig.url without needing one
      // Secret per repo. "repository" type requires an exact URL match and would
      // never match because the Application repoURL includes the repo path.
      const repoUrl = gitConfig.url
      const username = gitConfig.type === 'github' ? 'x-access-token' : 'orion'

      // B1 fix: YAML injection — the previous code only stripped \r\n but
      // other YAML metacharacters (colons, leading spaces, anchors, etc.) in
      // repoUrl/token/username can corrupt the document or inject extra fields.
      // JSON-encode each value: YAML is a JSON superset so JSON strings are valid
      // YAML scalars and escape all special characters.
      const yamlRepoUrl  = JSON.stringify(repoUrl)
      const yamlToken    = JSON.stringify(gitConfig.token)
      const yamlUsername = JSON.stringify(username)

      const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: orion-git-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repo-creds
stringData:
  type: git
  url: ${yamlRepoUrl}
  password: ${yamlToken}
  username: ${yamlUsername}`

      // Pipe the Secret through stdin — never touches disk, no shell involved.
      await run('kubectl', ['apply', '-f', '-', '-n', 'argocd'], { timeoutMs: 15_000, input: secretYaml })
      console.log(`[argocd-bootstrap] Registered git repo ${repoUrl} in ArgoCD`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[argocd-bootstrap] Failed to register git repo in ArgoCD (non-fatal): ${msg}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[argocd-bootstrap] Failed to fetch git provider config (non-fatal): ${msg}`)
  }
}
