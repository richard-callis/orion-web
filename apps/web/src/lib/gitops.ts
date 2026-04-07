/**
 * GitOps Loop Orchestrator
 *
 * High-level API consumed by ORION's AI agents.
 * Given a set of manifest changes, this module:
 *   1. Creates a feature branch in the environment's Gitea repo
 *   2. Commits the changed files
 *   3. Evaluates the auto-merge policy
 *   4. Opens a PR (with AI reasoning as the description)
 *   5. Auto-merges or leaves for human review
 *   6. Cleans up the branch after merge
 *
 * The environment's Gitea repo is the source of truth.
 * ArgoCD (K8s) or Gitea Actions runner (Docker) picks up the merged commit.
 */

import {
  commitFiles,
  createBranch,
  createPR,
  mergePR,
  deleteBranch,
  ensureRepo,
  ensureWebhook,
  type GiteaPR,
  type CreateRepoOptions,
} from './gitea'
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
  /** Gitea owner (user or org) */
  owner: string
  /** Gitea repo name */
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
  pr: GiteaPR
  classification: ChangeClassification
  merged: boolean
  branch: string
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Propose and (possibly) apply a GitOps change.
 *
 * Returns the PR and whether it was auto-merged.
 * If `merged === false` the PR is open in Gitea waiting for human approval.
 */
export async function proposeChange(opts: GitOpsChangeOptions): Promise<GitOpsChangeResult> {
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
  await createBranch(opts.owner, opts.repo, branch, 'main')

  // 2. Commit all changed files in one atomic commit
  await commitFiles({
    owner: opts.owner,
    repo: opts.repo,
    branch,
    files: opts.changes,
    message: opts.title,
  })

  // 3. Build PR body with AI reasoning + policy verdict
  const prBody = buildPRBody(opts.reasoning, classification)

  // 4. Open the PR
  const pr = await createPR({
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
    await mergePR({
      owner: opts.owner,
      repo: opts.repo,
      index: pr.number,
      message: `Auto-merged by ORION: ${opts.title}`,
    })
    merged = true

    // 6. Clean up branch after merge
    try {
      await deleteBranch(opts.owner, opts.repo, branch)
    } catch {
      // Non-fatal — branch cleanup is best-effort
    }
  }

  return { pr, classification, merged, branch }
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
 * Ensures the Gitea repo exists and sets up the webhook.
 *
 * If `opts.envType` is provided, a full scaffold is committed:
 *   - 'cluster' → README + argocd/appproject.yaml + argocd/root-application.yaml
 *   - 'docker'  → README + .gitea/workflows/deploy.yml
 *
 * Placeholder tokens in YAML templates:
 *   <ENV_NAME>        → opts.repoName
 *   <GITEA_REPO_URL>  → filled in by cluster-bootstrap.ts after creation
 */
export async function bootstrapEnvironmentRepo(opts: BootstrapRepoOptions) {
  const repoOpts: CreateRepoOptions = {
    owner: opts.owner,
    name: opts.repoName,
    description: opts.description ?? `ORION-managed environment: ${opts.repoName}`,
    private: true,
  }

  const repo = await ensureRepo(repoOpts)

  const files: { path: string; content: string }[] = buildScaffoldFiles(opts)

  try {
    await commitFiles({
      owner: opts.owner,
      repo: opts.repoName,
      branch: 'main',
      files,
      message: 'chore: initial scaffold by ORION',
    })
  } catch {
    // Repo may already have a README from auto_init — non-fatal
  }

  // Register ORION webhook so PR merges can trigger status updates
  if (opts.webhookUrl && opts.webhookSecret) {
    await ensureWebhook(opts.owner, opts.repoName, opts.webhookUrl, opts.webhookSecret)
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
    - '<GITEA_REPO_URL>'
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
    repoURL: '<GITEA_REPO_URL>'
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
    const readme = `# ${envName}\n\nThis repo is managed by ORION. Changes are applied via Gitea Actions runner.\n\n## Directory Layout\n\n\`\`\`\nservices/\n├── <service-name>/\n│   ├── docker-compose.yml\n│   ├── .env.example\n│   └── README.md\n└── ...\n\n.gitea/\n└── workflows/\n    └── deploy.yml\n\`\`\`\n\nSee [ORION env-scaffold docs](https://github.com/richard-callis/orion-web) for details.\n`

    const deployWorkflow = `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - name: Deploy changed services
        run: |
          # Find changed service directories
          CHANGED=$(git diff --name-only HEAD~1 HEAD | grep '^services/' | cut -d/ -f1-2 | sort -u)

          for SERVICE_DIR in $CHANGED; do
            if [ -f "$SERVICE_DIR/docker-compose.yml" ]; then
              echo "Deploying $SERVICE_DIR..."
              cd "$SERVICE_DIR"
              docker compose pull
              docker compose up -d --remove-orphans
              cd -
            fi
          done

      - name: Report status to ORION
        if: always()
        run: |
          curl -s -X POST "$ORION_URL/api/webhooks/gitea" \\
            -H "Content-Type: application/json" \\
            -d '{"action":"deploy_complete","status":"\\${{ job.status }}"}'
        env:
          ORION_URL: \${{ secrets.ORION_URL }}
`

    return [
      { path: 'README.md', content: readme },
      { path: '.gitea/workflows/deploy.yml', content: deployWorkflow },
    ]
  }

  // Default: minimal README only (backwards-compatible)
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
