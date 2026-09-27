

export interface EnvironmentRef {
  id: string
  name: string
  type: string
  gitOwner: string | null
  gitRepo: string | null
}

export interface GitOpsPR {
  id: string
  prNumber: number
  title: string
  operation: string
  decision: 'auto' | 'review'
  status: 'open' | 'merged' | 'closed'
  prUrl: string
  branch: string
  reasoning: string | null
  createdAt: string
  mergedAt: string | null
  environmentId: string
  environment: EnvironmentRef
}

export interface ArgoCDApp {
  name: string
  syncStatus: string
  healthStatus: string
  revision: string
  message: string
  reconciledAt: string | null
}

export interface ArgoCDState {
  applications: ArgoCDApp[]
  reportedAt: string
  overallHealth: string
}

export interface Environment {
  id: string
  name: string
  type: string
  status: string | null
  gitOwner: string | null
  gitRepo: string | null
  argoCdUrl: string | null
  /** Credentials are never returned by the API — only whether one is stored. */
  hasKubeconfig?: boolean
  gitOpsPRs?: GitOpsPR[]
  metadata?: {
    argocd?: ArgoCDState
  } | null
}

export interface BootstrapEvent {
  type: 'step' | 'log' | 'error' | 'done'
  message: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
