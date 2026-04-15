/**
 * GitOps Loop Orchestrator
 *
 * High-level API consumed by ORION's AI agents.
 * Given a set of manifest changes, this module:
 *   1. Creates a feature branch in the environment's git repo
 *   2. Commits the changed files
 *   3. Evaluates the auto-merge policy
 *   4. Opens a PR (with AI reasoning as the description)
 *   5. Auto-merges or leaves for human review
 *   6. Cleans up the branch after merge
 *
 * The environment's git repo is the source of truth.
 * ArgoCD (K8s) or a CI runner (Docker) picks up the merged commit.
 *
 * Provider-agnostic: Gitea / GitHub / GitLab all work transparently
 * via the GitProvider interface in lib/git-provider/.
 */

import { getGitProvider, type GitProvider } from './git-provider'
import {
  classifyAndEvaluate,
  type PolicyConfig,
  type ChangeClassification,
} from './gitops-policy'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ManifestChange {
  /** Repo-relative path, e.g. 'deployments/nginx/deployment.yaml' */
  path: string
  content: string
}

export interface GitOpsChangeOptions {
  /** Repo owner (user or org) */
  owner: string
  /** Repo name */
  repo: string
  /** Human-readable title for the PR */
  title: string
  /**
   * AI reasoning — shown as the PR body so every cluster change has
   * a full audit trail explaining *why* the change was made.
   */
  reasoning: string
  /** Files to create/update */
  changes: ManifestChange[]
  /** One-line description of the operation (used for policy classification) */
  operationDescription: string
  /** Policy config for this environment */
  policy?: PolicyConfig
  /** Branch prefix — default 'orion/auto' */
  branchPrefix?: string
}

export interface GitOpsChangeResult {
  prNumber: number
  prUrl: string
  classification: ChangeClassification
  merged: boolean
  branch: string
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Propose and (possibly) apply a GitOps change.
 *
 * Returns the PR info and whether it was auto-merged.
 * If `merged === false` the PR is open waiting for human approval.
 */
export async function proposeChange(opts: GitOpsChangeOptions): Promise<GitOpsChangeResult> {
  const provider = await getGitProvider()
  return proposeChangeWithProvider(provider, opts)
}

export async function proposeChangeWithProvider(
  provider: GitProvider,
  opts: GitOpsChangeOptions,
): Promise<GitOpsChangeResult> {
  const classification = classifyAndEvaluate(
    opts.operationDescription,
    opts.policy,
    'description',
  )

  // Unique branch name: orion/auto/scale-nginx-1713000000000
  const slug = opts.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
  const branch = `${opts.branchPrefix ?? 'orion/auto'}/${slug}-${Date.now()}`

  // 1. Create branch from main
  await provider.createBranch(opts.owner, opts.repo, branch, 'main')

  // 2. Commit all changed files in one atomic commit
  await provider.commitFiles({
    owner: opts.owner,
    repo: opts.repo,
    branch,
    files: opts.changes,
    message: opts.title,
  })

  // 3. Build PR body with AI reasoning + policy verdict
  const prBody = buildPRBody(opts.reasoning, classification)

  // 4. Open the PR
  const pr = await provider.createPR({
    owner: opts.owner,
    repo: opts.repo,
    title: opts.title,
    body: prBody,
    head: branch,
    base: 'main',
    labels: [classification.label],
  })

  // 5. Auto-merge if policy allows
  let merged = false
  if (classification.decision === 'auto') {
    await provider.mergePR(opts.owner, opts.repo, pr.number, `Auto-merged by ORION: ${opts.title}`)
    merged = true

    // 6. Clean up branch after merge
    try {
      await provider.deleteBranch(opts.owner, opts.repo, branch)
    } catch {
      // Non-fatal — branch cleanup is best-effort
    }
  }

  return {
    prNumber: pr.number,
    prUrl: pr.htmlUrl,
    classification,
    merged,
    branch,
  }
}

// ── Environment repo bootstrap ────────────────────────────────────────────────

export interface BootstrapRepoOptions {
  owner: string
  repoName: string
  description?: string
  /** ORION webhook URL for PR status callbacks */
  webhookUrl?: string
  webhookSecret?: string
  /** Environment type — determines which scaffold files are committed */
  envType?: 'cluster' | 'docker'
}

/**
 * Called when a new environment is registered in ORION.
 * Ensures the git repo exists and sets up the webhook.
 */
export async function bootstrapEnvironmentRepo(opts: BootstrapRepoOptions) {
  const provider = await getGitProvider()
  return bootstrapEnvironmentRepoWithProvider(provider, opts)
}

export async function bootstrapEnvironmentRepoWithProvider(
  provider: GitProvider,
  opts: BootstrapRepoOptions,
) {
  const repo = await provider.ensureRepo({
    owner: opts.owner,
    name: opts.repoName,
    description: opts.description ?? `ORION-managed environment: ${opts.repoName}`,
    private: true,
  })

  // Use the actual owner returned by the provider (may differ from opts.owner
  // when the provider resolves the authenticated user's login)
  const actualOwner = repo.fullName.split('/')[0]

  const files = buildScaffoldFiles(opts)

  try {
    await provider.commitFiles({
      owner: actualOwner,
      repo: opts.repoName,
      branch: 'main',
      files,
      message: 'chore: initial scaffold by ORION',
    })
  } catch {
    // Repo may already have a README from auto_init — non-fatal
  }

  if (opts.webhookUrl && opts.webhookSecret) {
    await provider.ensureWebhook(actualOwner, opts.repoName, opts.webhookUrl, opts.webhookSecret)
  }

  return repo
}

/** Build the scaffold file list based on environment type. */
function buildScaffoldFiles(opts: BootstrapRepoOptions): { path: string; content: string }[] {
  const envName = opts.repoName

  if (opts.envType === 'cluster') {
    const readme = `# ${envName}\n\nThis repo is managed by ORION. Do not edit manifests directly — propose changes via ORION.\n\n## Directory Layout\n\n\`\`\`\nclusters/<cluster-name>/\n├── namespaces/\n│   └── <namespace>.yaml\n├── deployments/\n│   └── <namespace>/\n│       └── <service>/\n│           ├── deployment.yaml\n│           ├── service.yaml\n│           ├── ingress.yaml\n│           └── pvc.yaml\n├── configs/\n│   └── <namespace>/\n│       └── <name>-configmap.yaml\n├── rbac/\n│   └── <name>-clusterrole.yaml\n├── network-policies/\n│   └── <namespace>-netpol.yaml\n└── argocd/\n    ├── appproject.yaml\n    └── root-application.yaml\n\`\`\`\n\nSee [ORION env-scaffold docs](https://github.com/richard-callis/orion-web) for the full auto-merge policy.\n`

    const appProject = `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: ${envName}
  namespace: argocd
spec:
  description: "ORION-managed cluster: ${envName}"
  sourceRepos:
    - '<GIT_REPO_URL>'
  destinations:
    - namespace: '*'
      server: https://kubernetes.default.svc
  clusterResourceWhitelist:
    - group: '*'
      kind: '*'
  namespaceResourceWhitelist:
    - group: '*'
      kind: '*'
`

    const rootApplication = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${envName}-root
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: ${envName}
  source:
    repoURL: '<GIT_REPO_URL>'
    targetRevision: main
    path: .
    directory:
      recurse: true
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
`

    return [
      { path: 'README.md', content: readme },
      { path: 'argocd/appproject.yaml', content: appProject },
      { path: 'argocd/root-application.yaml', content: rootApplication },
    ]
  }

  if (opts.envType === 'docker') {
    const readme = `# ${envName}\n\nThis repo is managed by ORION. Changes are applied via CI runner.\n\n## Directory Layout\n\n\`\`\`\nservices/\n├── <service-name>/\n│   ├── docker-compose.yml\n│   ├── .env.example\n│   └── README.md\n└── ...\n\`\`\`\n\nSee [ORION env-scaffold docs](https://github.com/richard-callis/orion-web) for details.\n`

    return [
      { path: 'README.md', content: readme },
    ]
  }

  return [
    {
      path: 'README.md',
      content: `# ${envName}\n\nManaged by [ORION](https://github.com/richard-callis/orion-web). Do not edit manually — changes are proposed via PR.\n`,
    },
  ]
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildPRBody(reasoning: string, classification: ChangeClassification): string {
  const verdict = classification.decision === 'auto'
    ? `✅ **Auto-merge** — ${classification.reason}`
    : `👤 **Human review required** — ${classification.reason}`

  return `## AI Reasoning\n\n${reasoning}\n\n---\n\n## Policy Verdict\n\n${verdict}\n\n*Operation type: \`${classification.operation}\`*\n\n*Proposed by [ORION](https://github.com/richard-callis/orion-web)*`
}
