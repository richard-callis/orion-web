import { readFile } from 'fs/promises'
import { ARGOCD_SERVER, ARGOCD_PASSWORD } from './config'

export async function argocdLogin(): Promise<string> {
  if (!ARGOCD_PASSWORD) return ''
  const res = await fetch(`${ARGOCD_SERVER}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: ARGOCD_PASSWORD }),
  })
  if (!res.ok) {
    console.warn(`[bootstrap] ArgoCD login failed: ${res.status} ${res.statusText}`)
    return ''
  }
  const data = await res.json()
  return data.token ?? ''
}

async function argocdPut(token: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${ARGOCD_SERVER}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[bootstrap] ArgoCD PUT ${path} failed: ${res.status} ${body.slice(0, 200)}`)
  }
}

/** Extract API server URL from kubeconfig YAML string. */
export function extractKubeconfigServer(kubeconfig: string): string | null {
  const match = kubeconfig.match(/clusters:\s*\n\s*-+[^-]*?server:\s*(https?:\/\/[^\s]+)/s)
  return match?.[1]?.trim() ?? null
}

/** Register the Talos cluster with the local ArgoCD server. */
export async function argocdRegisterCluster(token: string, envName: string): Promise<void> {
  if (!token) return
  // Read the Talos kubeconfig
  const kubeconfig = await readFile('/root/.kube/config', 'utf-8').catch(() => '')
  if (!kubeconfig) {
    console.warn('[bootstrap] No kubeconfig found — skipping cluster registration')
    return
  }

  const clusterServer = extractKubeconfigServer(kubeconfig)
  if (!clusterServer) {
    console.warn('[bootstrap] Could not parse API server URL from kubeconfig — skipping cluster registration')
    return
  }

  const slug = envName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const clusterName = `${slug}-cluster`

  // Create cluster via ArgoCD API (cluster resource stored as a secret)
  await argocdPut(token, '/api/v1/clusters', {
    secretType: 'kubernetes',
    metadata: {
      name: clusterName,
      namespace: 'argocd',
      labels: { 'argocd.argoproj.io/secret-type': 'cluster' },
    },
    stringData: {
      name: clusterName,
      server: clusterServer,
      config: kubeconfig,
    },
  })
  console.log(`[bootstrap] Registered cluster "${clusterName}" (API: ${clusterServer})`)
}

/** Create the root Application and AppProject in ArgoCD. */
export async function argocdConfigureApp(token: string, envName: string, repoUrl: string, clusterServer: string): Promise<void> {
  if (!token) return
  const slug = envName.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  // AppProject
  await argocdPut(token, `/api/v1/appprojects/${slug}`, {
    metadata: {
      name: slug,
      namespace: 'argocd',
    },
    spec: {
      description: `ORION-managed cluster: ${envName}`,
      sourceRepos: [repoUrl],
      destinations: [{ namespace: '*', server: clusterServer }],
      clusterResourceWhitelist: [{ group: '*', kind: '*' }],
    },
  })

  // Application
  await argocdPut(token, `/api/v1/applications/${slug}`, {
    metadata: {
      name: slug,
      namespace: 'argocd',
      annotations: {
        'argocd.argoproj.io/sync-wave': '0',
      },
    },
    spec: {
      project: slug,
      source: {
        repoURL: repoUrl,
        targetRevision: 'main',
        path: 'deployments',
        directory: { recurse: true },
      },
      destination: {
        server: clusterServer,
        namespace: 'default',
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ['CreateNamespace=true'],
      },
    },
  })
  console.log(`[bootstrap] Configured ArgoCD app "${slug}" → ${repoUrl}/deployments`)
}
