/**
 * ArgoCD Bootstrap
 *
 * Runs at cluster gateway startup. Installs ArgoCD into the cluster if not
 * already present, then registers the git repo configured in Orion.
 *
 * Designed to be idempotent — safe to call on every restart.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const execAsync = promisify(exec)

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
    await execAsync('kubectl get namespace argocd 2>/dev/null', { timeout: 10_000 })
    argocdInstalled = true
    console.log('[argocd-bootstrap] ArgoCD already installed, skipping install')
  } catch {
    // ArgoCD not installed — proceed with install
  }

  if (!argocdInstalled) {
    try {
      console.log('[argocd-bootstrap] Installing ArgoCD into cluster...')

      // Step 2: Create namespace and apply ArgoCD manifests
      await execAsync('kubectl create namespace argocd 2>/dev/null', { timeout: 10_000 })
      console.log('[argocd-bootstrap] Namespace argocd created')

      await execAsync(
        'kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml',
        { timeout: 120_000 },
      )
      console.log('[argocd-bootstrap] ArgoCD manifests applied')

      // Step 3: Wait for ArgoCD server to be ready
      await execAsync(
        'kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=120s',
        { timeout: 130_000 },
      )
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
      const secretsResult = await execAsync(
        'kubectl get secret -n argocd -l argocd.argoproj.io/secret-type=repository -o json 2>/dev/null',
        { timeout: 15_000 },
      )
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
      const repoUrl = `${gitConfig.url}/${gitConfig.org}`
      const username = gitConfig.type === 'github' ? 'x-access-token' : 'orion'

      const safeRepoUrl  = repoUrl.replace(/[\r\n]/g, '')
      const safeToken    = gitConfig.token.replace(/[\r\n]/g, '')
      const safeUsername = username.replace(/[\r\n]/g, '')

      const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: orion-git-repo
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  type: git
  url: ${safeRepoUrl}
  password: ${safeToken}
  username: ${safeUsername}`

      // Write to a temp file and apply — avoids stdin piping issues with exec
      const tmpDir = mkdtempSync(tmpdir() + '/argocd-bootstrap-')
      const tmpFile = `${tmpDir}/repo-secret.yaml`
      writeFileSync(tmpFile, secretYaml, { mode: 0o600 })
      try {
        await execAsync(`kubectl apply -f ${tmpFile} -n argocd 2>/dev/null`, {
          timeout: 15_000,
        })
        console.log(`[argocd-bootstrap] Registered git repo ${repoUrl} in ArgoCD`)
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[argocd-bootstrap] Failed to register git repo in ArgoCD (non-fatal): ${msg}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[argocd-bootstrap] Failed to fetch git provider config (non-fatal): ${msg}`)
  }
}
