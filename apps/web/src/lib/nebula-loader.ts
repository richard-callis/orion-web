/**
 * Nebula Loader — reads Nova YAML definitions from a git repo.
 *
 * Nova YAML files live in {nebula.path}/ in the configured git repo.
 * Each .yaml file is one Nova definition.
 */

import { parse as parseYaml } from 'yaml'
import { getGitProvider } from './git-provider'
import { prisma } from './db'
import type { NovaConfig } from './nebula'

// ── Nova YAML shape ───────────────────────────────────────────────────────────

export interface NovaYaml {
  name: string
  displayName: string
  description?: string
  tags?: string[]
  category?: string
  type?: 'service' | 'agent'
  icon?: string
  helm?: {
    chart: string
    repo?: string
    namespace: string
    createNamespace?: boolean
    values?: string
  }
  namespaceLabels?: Record<string, Record<string, string>>
  postInstall?: Array<{ manifest: string }>
  setupNote?: string
}

// ── Public functions ──────────────────────────────────────────────────────────

export async function loadNovaeFromNebula(nebula: {
  id: string
  gitUrl: string
  branch: string
  path: string
}): Promise<{ novas: NovaYaml[]; errors: string[] }> {
  const provider = await getGitProvider()
  const { owner, repo } = parseGitUrl(nebula.gitUrl)

  const errors: string[] = []
  const novas: NovaYaml[] = []

  let files: string[] = []
  try {
    files = await provider.listFiles(owner, repo, nebula.path, nebula.branch)
  } catch (err) {
    errors.push(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`)
    return { novas, errors }
  }

  for (const filePath of files) {
    try {
      const content = await provider.readFile(owner, repo, filePath, nebula.branch)
      const nova = parseYaml(content) as NovaYaml
      if (nova?.name) novas.push(nova)
    } catch (err) {
      errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { novas, errors }
}

export async function syncNebula(nebulaId: string): Promise<{ synced: number; errors: string[] }> {
  const nebula = await prisma.nebula.findUnique({ where: { id: nebulaId } })
  if (!nebula) throw new Error('Nebula not found')

  await prisma.nebula.update({ where: { id: nebulaId }, data: { syncStatus: 'syncing' } })

  try {
    const { novas, errors } = await loadNovaeFromNebula(nebula)

    for (const yaml of novas) {
      await prisma.nova.upsert({
        where: { name: yaml.name },
        update: {
          displayName: yaml.displayName,
          description: yaml.description ?? null,
          category: yaml.category ?? 'Middleware',
          tags: yaml.tags ?? [],
          source: 'nebula',
          config: buildNovaConfig(yaml),
          updatedAt: new Date(),
        },
        create: {
          name: yaml.name,
          displayName: yaml.displayName,
          description: yaml.description ?? null,
          category: yaml.category ?? 'Middleware',
          version: '1.0.0',
          source: 'nebula',
          tags: yaml.tags ?? [],
          config: buildNovaConfig(yaml),
        },
      })
    }

    await prisma.nebula.update({
      where: { id: nebulaId },
      data: { syncStatus: 'ok', lastSyncAt: new Date(), syncError: null },
    })

    return { synced: novas.length, errors }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await prisma.nebula.update({
      where: { id: nebulaId },
      data: { syncStatus: 'error', syncError: msg },
    })
    throw err
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseGitUrl(gitUrl: string): { owner: string; repo: string } {
  // Handle https://gitea.example.com/owner/repo.git and similar
  const cleaned = gitUrl.replace(/\.git$/, '')
  const parts = cleaned.split('/')
  const repo = parts[parts.length - 1]
  const owner = parts[parts.length - 2]
  return { owner, repo }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildNovaConfig(yaml: NovaYaml): Record<string, any> {
  return {
    name: yaml.name,
    displayName: yaml.displayName,
    description: yaml.description ?? '',
    type: yaml.type ?? 'service',
    ...(yaml.helm
      ? {
          helm: {
            chart: yaml.helm.chart,
            repo: yaml.helm.repo,
            namespace: yaml.helm.namespace,
            createNamespace: yaml.helm.createNamespace,
            values: yaml.helm.values ? { raw: yaml.helm.values } : undefined,
          },
        }
      : {}),
    manifests: yaml.postInstall?.map(p => p.manifest) ?? [],
    ...(yaml.icon ? { icon: yaml.icon } : {}),
    ...(yaml.namespaceLabels ? { namespaceLabels: yaml.namespaceLabels } : {}),
    ...(yaml.setupNote ? { setupNote: yaml.setupNote } : {}),
  }
}
