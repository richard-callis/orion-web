/**
 * GitOps tools: browse the repo, validate manifests, propose changes, manage PRs, deployment templates.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { prisma } from '@/lib/db'
import { DEPLOYMENT_TEMPLATES, getTemplate } from '@/lib/deployment-templates'
import { auditLog, parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

const MergePRArgs = z.object({
  environment_id: z.string().nullish(),
  pr_number: z.unknown(),
  merge_message: z.string().nullish(),
})

async function handleMergePR(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const raw = parseToolArgs(MergePRArgs, args)
  const { environment_id, merge_message } = raw
  const pr_number = Number(raw.pr_number)
  if (!environment_id) return 'Error: environment_id is required'
  if (!Number.isInteger(pr_number) || pr_number <= 0) return 'Error: pr_number must be a positive integer'

  const env = await ctx.prisma.environment.findFirst({
    where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
  })
  if (!env) return `Error: environment "${environment_id}" not found`
  if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo'

  const { mergePR } = await import('../gitea')
  await mergePR({ owner: env.gitOwner, repo: env.gitRepo, index: pr_number, message: merge_message ?? undefined, style: 'merge' })

  await ctx.prisma.gitOpsPR.updateMany({
    where: { environmentId: env.id, prNumber: pr_number },
    data: { status: 'merged' },
  }).catch((e) => console.error(`[gitea_merge_pr] DB update failed for PR #${pr_number}:`, e))

  const msg = `✅ Merged PR #${pr_number} in ${env.gitOwner}/${env.gitRepo}${merge_message ? ` — ${merge_message}` : ''}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Merged PR #${pr_number} in ${env.gitOwner}/${env.gitRepo}.`
}

const ClosePRArgs = z.object({
  environment_id: z.string().nullish(),
  pr_number: z.unknown(),
  reason: z.string().nullish(),
})

async function handleClosePR(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const raw = parseToolArgs(ClosePRArgs, args)
  const { environment_id, reason } = raw
  const pr_number = Number(raw.pr_number)
  if (!environment_id) return 'Error: environment_id is required'
  if (!Number.isInteger(pr_number) || pr_number <= 0) return 'Error: pr_number must be a positive integer'

  const env = await ctx.prisma.environment.findFirst({
    where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
  })
  if (!env) return `Error: environment "${environment_id}" not found`
  if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo'

  const { closePR } = await import('../gitea')
  await closePR(env.gitOwner, env.gitRepo, pr_number)

  // Update DB record if it exists
  await ctx.prisma.gitOpsPR.updateMany({
    where: { environmentId: env.id, prNumber: pr_number },
    data: { status: 'closed' },
  }).catch((e) => console.error(`[gitea_close_pr] DB update failed for PR #${pr_number}:`, e))

  const msg = `🚫 Closed PR #${pr_number} in ${env.gitOwner}/${env.gitRepo}${reason ? ` — ${reason}` : ''}`
  await auditLog(ctx.agentId ?? ctx.userId, msg)
  return `Closed PR #${pr_number}${reason ? ` — ${reason}` : ''}`
}

export const gitopsLsTool: ToolDefinition = {
  name: 'gitops_ls',
  description: 'List files and directories in the GitOps repo for an environment. Call this BEFORE gitops_propose to check what paths already exist so you place new files consistently with the existing structure. Defaults to the environment\'s watched directory (e.g. "deployments/") — pass a sub-path to drill in (e.g. "deployments/tailscale").',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID or name' },
      path:           { type: 'string', description: 'Directory path to list. Omit to list the watched directory root (e.g. "deployments/"). Pass a sub-path to drill in, e.g. "deployments/tailscale".' },
    },
    required: ['environment_id'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args, ctx) => {
    const { environment_id, path: listPath } = args as { environment_id?: string; path?: string }
    if (!environment_id) return 'Error: environment_id is required'

    const env = await ctx.prisma.environment.findFirst({
      where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
    })
    if (!env) return `Error: environment "${environment_id}" not found`
    if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo configured'

    // Live ArgoCD path discovery — prefer cluster truth over DB
    let liveWatchedPath: string | undefined
    try {
      const { customApi } = await import('../k8s')
      const apps = await customApi.listClusterCustomObject({ group: 'argoproj.io', version: 'v1alpha1', plural: 'applications' })
      const items: any[] = apps?.items ?? []
      const matchingApp = items.find((app: any) => {
        const repoUrl: string = app?.spec?.source?.repoURL ?? ''
        return repoUrl.includes(env.gitRepo!) || repoUrl.endsWith(`/${env.gitRepo}`)
      })
      if (matchingApp?.spec?.source?.path) {
        liveWatchedPath = (matchingApp.spec.source.path as string).replace(/\/$/, '')
      }
    } catch { /* cluster unreachable — fall through */ }

    const repoPath = liveWatchedPath ?? ((env as Record<string, unknown>).repoPath as string | undefined)
    // Default to the watched directory so agents never accidentally browse the repo root
    const effectivePath = listPath || repoPath || ''

    const { listDir } = await import('../gitea')
    const entries = await listDir(env.gitOwner, env.gitRepo, effectivePath)
    if (entries.length === 0) return `No files found at "${effectivePath}"`

    const lines = entries.map(e => `  ${e.type === 'dir' ? '📁' : '📄'} ${e.path}`)
    const source = liveWatchedPath ? ' (live ArgoCD watched path)' : ''
    const header = `Contents of "${effectivePath}"${source} — all manifests must live under this directory:`
    return [header, ...lines].join('\n')
  },
}

async function handleGetClusterApiResources(): Promise<string> {
  try {
    const { customApi } = await import('../k8s')

    const builtins = `Built-in Kubernetes resources (always available):
  v1: ConfigMap, Endpoints, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret, Service, ServiceAccount
  apps/v1: DaemonSet, Deployment, ReplicaSet, StatefulSet
  batch/v1: CronJob, Job
  networking.k8s.io/v1: Ingress, IngressClass, NetworkPolicy
  rbac.authorization.k8s.io/v1: ClusterRole, ClusterRoleBinding, Role, RoleBinding
  storage.k8s.io/v1: StorageClass`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crdRes: any = await customApi.listClusterCustomObject({ group: 'apiextensions.k8s.io', version: 'v1', plural: 'customresourcedefinitions' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const crds: any[] = crdRes?.items ?? []

    // Group CRDs by API group+version
    const groupMap = new Map<string, string[]>()
    for (const crd of crds) {
      const group = crd.spec?.group ?? ''
      const kinds: string[] = []
      for (const v of (crd.spec?.versions ?? [])) {
        if (v.served) {
          const key = `${group}/${v.name}`
          if (!groupMap.has(key)) groupMap.set(key, [])
          groupMap.get(key)!.push(crd.spec?.names?.kind ?? '')
        }
      }
      void kinds
    }

    let crdLines = ''
    if (groupMap.size === 0) {
      crdLines = '  (none found or cluster unreachable)'
    } else {
      for (const [groupVersion, kinds] of Array.from(groupMap.entries()).sort()) {
        crdLines += `  ${groupVersion}: ${kinds.sort().join(', ')}\n`
      }
      crdLines = crdLines.trimEnd()
    }

    return `Cluster API Resources:\n\n${builtins}\n\nCustom CRDs installed in this cluster:\n${crdLines}\n\nIMPORTANT: Only use apiVersions listed above. Any other apiVersion does not exist and will cause ArgoCD sync failures.`
  } catch (e) {
    return `Error fetching cluster API resources: ${e instanceof Error ? e.message : String(e)}`
  }
}

const ValidateManifestArgs = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).nullish(),
})

async function handleValidateManifest(args: unknown): Promise<string> {
  const { files } = parseToolArgs(ValidateManifestArgs, args)

  if (!files?.length) return 'Error: files array is required'

  try {
    const { customApi } = await import('../k8s')

    // Fetch installed CRD groups from the cluster
    const installedCrdGroups = new Set<string>()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crdRes: any = await customApi.listClusterCustomObject({ group: 'apiextensions.k8s.io', version: 'v1', plural: 'customresourcedefinitions' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const crds: any[] = crdRes?.items ?? []
      for (const crd of crds) {
        const group = crd.spec?.group ?? ''
        if (group) installedCrdGroups.add(group)
      }
    } catch {
      // Cluster unreachable — we'll still check built-ins
    }

    const builtinGroups = new Set([
      '', 'apps', 'batch', 'networking.k8s.io', 'rbac.authorization.k8s.io',
      'storage.k8s.io', 'policy', 'autoscaling', 'apiextensions.k8s.io',
      'admissionregistration.k8s.io', 'coordination.k8s.io',
    ])

    interface ParsedDoc {
      filePath: string
      apiVersion: string
      kind: string
      group: string
    }

    const docs: ParsedDoc[] = []
    for (const file of files) {
      // Split on YAML document separator
      const parts = file.content.split(/^---\s*$/m).filter(p => p.trim())
      for (const part of parts) {
        const avMatch = part.match(/^apiVersion:\s*(.+)$/m)
        const kindMatch = part.match(/^kind:\s*(.+)$/m)
        if (!avMatch || !kindMatch) continue
        const apiVersion = avMatch[1].trim()
        const kind = kindMatch[1].trim()
        // Extract group from apiVersion (e.g. "apps/v1" → "apps", "v1" → "")
        const slashIdx = apiVersion.lastIndexOf('/')
        const group = slashIdx >= 0 ? apiVersion.slice(0, slashIdx) : ''
        docs.push({ filePath: file.path, apiVersion, kind, group })
      }
    }

    if (docs.length === 0) {
      return 'No parseable Kubernetes documents found in the provided files (missing apiVersion or kind).'
    }

    let passed = 0
    let failed = 0
    const lines: string[] = [`Manifest validation results (${files.length} files, ${docs.length} documents):\n`]

    for (const doc of docs) {
      const isBuiltin = builtinGroups.has(doc.group)
      const isCrd = installedCrdGroups.has(doc.group)
      if (isBuiltin || isCrd) {
        lines.push(`✅ ${doc.apiVersion}/${doc.kind} — ${doc.filePath}`)
        passed++
      } else {
        lines.push(`❌ ${doc.apiVersion}/${doc.kind} — ${doc.filePath}`)
        lines.push(`   CRD group "${doc.group}" is not installed in this cluster.`)
        lines.push(`   Install the required operator first or check the correct apiVersion.`)
        failed++
      }
    }

    lines.push('')
    if (failed === 0) {
      return `✅ All ${passed} documents validated successfully against cluster API resources.\nSafe to call gitops_propose.`
    }

    lines.push(`Summary: ${passed} passed, ${failed} failed`)
    lines.push('❌ DO NOT call gitops_propose until all failures are resolved.')
    return lines.join('\n')
  } catch (e) {
    return `Error validating manifests: ${e instanceof Error ? e.message : String(e)}`
  }
}

// orion_propose_gitops removed — use gitops_propose (the canonical tool with path normalization and guard)

export const getClusterApiResourcesTool: ToolDefinition = {
  name: 'get_cluster_api_resources',
  description: 'List all API resources available in the cluster — built-in Kubernetes resource types plus all installed CRDs. Use this before writing manifests to verify that the apiVersions and kinds you plan to use actually exist. Prevents ArgoCD sync failures caused by referencing non-existent CRDs.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: () => handleGetClusterApiResources(),
}

export const validateManifestTool: ToolDefinition = {
  name: 'validate_manifest',
  description: 'Validate Kubernetes manifest files against the cluster\'s actual API resources. Checks each document\'s apiVersion/kind against built-in Kubernetes resources and installed CRDs. Returns a pass/fail report. Call this before gitops_propose whenever manifests use non-standard apiVersions.',
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Array of manifest files to validate.',
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'File path (for display in the report)' },
            content: { type: 'string', description: 'Full YAML content of the file' },
          },
          required: ['path', 'content'],
        },
      },
    },
    required: ['files'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: handleValidateManifest,
}

// ── gitops_propose ────────────────────────────────────────────────────────────

export const gitopsProposeTool: ToolDefinition = {
  name: 'gitops_propose',
  description: `Propose a GitOps change. Creates a branch, commits files, opens a PR in the environment's git repo, and auto-merges if policy allows. Use this for ALL cluster/infrastructure changes — never apply kubectl manifests directly.

BEFORE proposing: call gitops_ls to check what paths already exist so you match the existing structure exactly.

Path conventions: pass service-relative paths (e.g. "tailscale/deployment.yaml") — the tool automatically prepends the correct watched directory (e.g. "deployments/"). Paths that escape the watched directory are REJECTED.

To delete files: set delete: true on the change item and omit content. You can mix deletions and upserts in a single PR (e.g. remove an old service and add a replacement atomically).

For Kubernetes manifests: always include namespace, use pinned image tags, include CrowdSec + Authentik middleware on all public ingresses.
For Docker Compose: use self-contained services (no host bind mounts for config files).`,
  inputSchema: {
    type: 'object',
    properties: {
      environment_id:        { type: 'string', description: 'Environment ID or name (e.g. "Talos Cluster", "localhost")' },
      title:                 { type: 'string', description: 'Short PR title, e.g. "feat: deploy Tailscale Operator"' },
      reasoning:             { type: 'string', description: 'Why this change is needed' },
      operation_description: { type: 'string', description: 'Plain-language summary: e.g. "add new service", "update image tag", "remove service"' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'Service-relative file path — do NOT include the watched directory prefix. E.g. "tailscale/deployment.yaml", not "deployments/tailscale/deployment.yaml". The tool places it under the correct directory automatically.' },
            content: { type: 'string', description: 'Full file content. Required unless delete is true.' },
            delete:  { type: 'boolean', description: 'Set to true to delete this file from the repo. Omit content when deleting.' },
          },
          required: ['path'],
        },
      },
    },
    required: ['environment_id', 'title', 'reasoning', 'operation_description', 'changes'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args, ctx) => {
    const { environment_id, title, reasoning, operation_description, changes } =
      args as { environment_id?: string; title?: string; reasoning?: string; operation_description?: string; changes?: Array<{ path: string; content?: string; delete?: boolean }> }

    if (!environment_id || !title || !reasoning || !operation_description || !changes?.length) {
      return 'Error: environment_id, title, reasoning, operation_description, and changes are all required'
    }
    const invalid = changes.filter(c => !c.delete && !c.content)
    if (invalid.length > 0) {
      return `Error: the following changes are missing content (set delete: true to delete a file, or provide content to upsert):\n${invalid.map(c => `  - ${c.path}`).join('\n')}`
    }
    try {
      const { proposeChange } = await import('@/lib/gitops')
      const env = await prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      if (!env.gitOwner || !env.gitRepo) return 'Error: environment has no git repo configured — run bootstrap first'

      // Enforce repoPath convention — prepend if agent passed service-relative paths
      const repoPath = (env as Record<string, unknown>).repoPath as string | undefined
      const normalizedChanges = repoPath
        ? changes.map(c => ({
            ...c,
            path: c.path.startsWith(`${repoPath}/`) ? c.path : `${repoPath}/${c.path}`,
          }))
        : changes as Array<{ path: string; content?: string; delete?: boolean }>

      if (repoPath) {
        const escaping = normalizedChanges.filter(c => !c.path.startsWith(`${repoPath}/`))
        if (escaping.length > 0) {
          return `Error: the following paths fall outside the watched directory "${repoPath}/". Pass service-relative paths only (e.g. "tailscale/deployment.yaml"):\n${escaping.map(c => `  - ${c.path}`).join('\n')}\n\nCall gitops_ls first to check existing structure.`
        }
      }

      const policy = (env.policyConfig ?? {}) as import('@/lib/gitops-policy').PolicyConfig
      const result = await proposeChange({
        owner: env.gitOwner,
        repo: env.gitRepo,
        title,
        reasoning,
        operationDescription: operation_description,
        changes: normalizedChanges,
        policy,
      })

      await prisma.gitOpsPR.create({
        data: {
          environmentId: env.id,
          prNumber:  result.prNumber,
          title,
          operation: result.classification.operation,
          decision:  result.classification.decision,
          status:    result.merged ? 'merged' : 'open',
          prUrl:     result.prUrl,
          reasoning,
          branch:    result.branch,
          mergedAt:  result.merged ? new Date() : null,
        },
      })

      const action = result.merged
        ? `auto-merged (${result.classification.reason})`
        : `opened for review — ${result.classification.reason}`
      await auditLog(ctx.agentId ?? ctx.userId, `📦 GitOps PR #${result.prNumber} ${action} in ${env.gitOwner}/${env.gitRepo}: "${title}"`)
      return `PR #${result.prNumber} ${action}. URL: ${result.prUrl}`
    } catch (e) {
      return `Error proposing GitOps change: ${e instanceof Error ? e.message : String(e)}`
    }
  },
}

// ── gitea_merge_pr ────────────────────────────────────────────────────────────

export const giteaMergePrTool: ToolDefinition = {
  name: 'gitea_merge_pr',
  description: 'Merge an open Gitea pull request into its target branch. The PR must be in a mergeable state.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID or name (e.g. "Talos Cluster")' },
      pr_number:      { type: 'number', description: 'The PR number to merge' },
      merge_message:  { type: 'string', description: 'Optional commit message for the merge commit' },
    },
    required: ['environment_id', 'pr_number'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'gitops',
  handler: handleMergePR,
}

// ── gitea_close_pr ────────────────────────────────────────────────────────────

export const giteaClosePrTool: ToolDefinition = {
  name: 'gitea_close_pr',
  description: 'Close an open Gitea pull request without merging it. Use this to clean up duplicate, superseded, or unwanted PRs.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID or name (e.g. "Talos Cluster")' },
      pr_number:      { type: 'number', description: 'The PR number to close' },
      reason:         { type: 'string', description: 'Short reason for closing (e.g. "superseded by PR #95")' },
    },
    required: ['environment_id', 'pr_number'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'gitops',
  handler: handleClosePR,
}

// ── Deployment templates ───────────────────────────────────────────────────────

export const listDeploymentTemplatesTool: ToolDefinition = {
  name: 'list_deployment_templates',
  description: 'List all available deployment templates (Kubernetes and Docker Compose). Each template is a generic YAML starting point with {{ PLACEHOLDER }} fields the agent fills in before proposing to Gitea via gitops_propose.',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['core', 'workload', 'networking', 'storage', 'secrets', 'gitops', 'docker'],
        description: 'Filter by category (optional). Omit to list all templates. Use "docker" for Docker Compose templates.',
      },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args) => {
    const a        = args as { category?: string }
    const filtered = a.category
      ? DEPLOYMENT_TEMPLATES.filter(t => t.category === a.category)
      : DEPLOYMENT_TEMPLATES

    if (filtered.length === 0) return `No templates found${a.category ? ` for category "${a.category}"` : ''}.`

    const grouped: Record<string, typeof filtered> = {}
    for (const t of filtered) {
      ;(grouped[t.category] ??= []).push(t)
    }

    return Object.entries(grouped)
      .map(([cat, templates]) =>
        `**${cat}**\n` +
        templates.map(t => `  • ${t.name} — ${t.description}`).join('\n')
      )
      .join('\n\n')
  },
}

export const getDeploymentTemplateTool: ToolDefinition = {
  name: 'get_deployment_template',
  description: 'Get the full YAML content of a deployment template by name. Fill in all {{ PLACEHOLDER }} fields, remove commented-out sections you do not need, then use gitops_propose to open a PR.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Template name (from list_deployment_templates). e.g. "deployment", "ingress-public", "externalsecret".',
      },
    },
    required: ['name'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'gitops',
  handler: async (args) => {
    const { name } = args as { name: string }
    const tmpl = getTemplate(name)
    if (!tmpl) {
      const names = DEPLOYMENT_TEMPLATES.map(t => t.name).join(', ')
      return `Template "${name}" not found. Available templates: ${names}`
    }
    return [
      `# Template: ${tmpl.name} [${tmpl.category}]`,
      `# ${tmpl.description}`,
      `#`,
      `# Fill in every {{ PLACEHOLDER }} field before applying.`,
      `# Remove or uncomment optional sections as needed.`,
      `# Use gitops_propose to open a Gitea PR when ready.`,
      ``,
      tmpl.yaml,
    ].join('\n')
  },
}
