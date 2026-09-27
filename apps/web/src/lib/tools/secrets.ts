/**
 * Managed secret tools: list secrets and generate secret values in Vault.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { updateVaultSecret } from '@/lib/vault'
import { randomBytes } from 'crypto'
import { parseToolArgs } from './shared'
import type { ToolDefinition, ToolExecutionContext } from './registry'

// ── Vault / Managed Secrets ───────────────────────────────────────────────────

const ListSecretsArgs = z.object({
  environment: z.string().nullish(),
  namespace: z.string().nullish(),
  status: z.string().nullish(),
  tag: z.string().nullish(),
})

async function handleListSecrets(args: unknown, ctx: ToolExecutionContext): Promise<string> {
  const { environment, namespace, status, tag } = parseToolArgs(ListSecretsArgs, args)

  let environmentId: string | undefined
  if (environment) {
    const env = await ctx.prisma.environment.findFirst({
      where: { name: { contains: environment, mode: 'insensitive' } },
      select: { id: true },
    })
    if (!env) return `Error: no environment matching "${environment}". Omit to list secrets from all environments.`
    environmentId = env.id
  }

  const secrets = await ctx.prisma.managedSecret.findMany({
    where: {
      ...(environmentId ? { environmentId } : {}),
      ...(namespace     ? { namespace }     : {}),
      ...(status        ? { status }        : {}),
    },
    include: { environment: { select: { name: true } } },
    orderBy: [{ environment: { name: 'asc' } }, { namespace: 'asc' }, { name: 'asc' }],
    take: 100,
  })

  const filtered = tag
    ? secrets.filter((s) => Array.isArray(s.tags) && s.tags.includes(tag))
    : secrets

  if (!filtered.length) return 'No managed secrets found matching the given filters.'

  return JSON.stringify(
    filtered.map((s) => ({
      id:             s.id,
      name:           s.name,                    // ExternalSecret / K8s Secret name
      environment:    s.environment.name,
      namespace:      s.namespace,
      description:    s.description ?? null,
      vaultPath:      s.remoteRef,               // Vault path — e.g. "secret/data/myapp/db"
      targetSecret:   s.targetSecretName ?? s.name,  // K8s Secret name to mount/reference
      // Only the K8s key names — how to reference this secret in pod specs / secretKeyRef.
      // Vault-internal key names are not exposed.
      k8sKeys:        (s.dataKeys as Array<{ secretKey: string }> ?? []).map(k => k.secretKey),
      refreshInterval: s.refreshInterval,
      status:         s.status,                  // "draft" | "applied" | "error"
      statusMessage:  s.status === 'error' ? (s.statusMessage ?? null) : null,
      tags:           s.tags ?? [],
      appliedAt:      s.appliedAt?.toISOString() ?? null,
    })),
    null, 2
  )
}

export const orionListSecretsTool: ToolDefinition = {
  name: 'orion_list_secrets',
  description: 'List Vault secrets registered in ORION as managed ExternalSecrets. Returns metadata only — Vault path, target K8s Secret name, the K8s key names you can reference in pod specs, and sync status. Never returns actual secret values or Vault-internal key names.',
  inputSchema: {
    type: 'object',
    properties: {
      environment: { type: 'string', description: 'Filter by environment name (partial match). Omit for all environments.' },
      namespace:   { type: 'string', description: 'Filter by Kubernetes namespace.' },
      status:      { type: 'string', description: 'Filter by sync status: draft, applied, error.' },
      tag:         { type: 'string', description: 'Filter by a single tag value.' },
    },
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'both',
  category: 'secrets',
  handler: handleListSecrets,
}

export const generateSecretTool: ToolDefinition = {
  name: 'generate_secret',
  description: 'Generate cryptographically secure random values server-side for a draft secret and write them directly to Vault. Use this for secrets whose values should be auto-generated (encryption keys, passwords, tokens) — the values are never returned and never appear in this conversation. Only works on secrets in draft status. Refuses to overwrite already-applied secrets.',
  inputSchema: {
    type: 'object',
    properties: {
      secretId: { type: 'string', description: 'The ORION secret id (from orion_list_secrets). Must be in draft status.' },
      keyNames: { type: 'array', items: { type: 'string' }, description: 'Specific key names to generate values for. If omitted, generates values for all keys in the secret.' },
    },
    required: ['secretId'],
  },
  tier: 'write',
  parallelSafe: false,
  availableIn: 'both',
  category: 'secrets',
  handler: async (args, ctx) => {
    const { secretId, keyNames } = args as { secretId: string; keyNames?: string[] }
    if (!secretId) return 'Error: secretId is required'

    const secret = await ctx.prisma.managedSecret.findUnique({ where: { id: secretId } })
    if (!secret) return `Error: secret "${secretId}" not found. Use orion_list_secrets to find the correct id.`
    if (secret.status === 'applied') {
      return [
        `Error: secret "${secret.name}" (${secretId}) is already applied — refusing to overwrite live credentials.`,
        `If you need to rotate this secret, ask the user to confirm first.`,
      ].join('\n')
    }

    const allKeys = (secret.dataKeys as Array<{ remoteKey: string; secretKey: string }>).map(k => k.remoteKey)
    const keysToGenerate = keyNames && keyNames.length > 0 ? keyNames : allKeys

    const unknown = keysToGenerate.filter(k => !allKeys.includes(k))
    if (unknown.length > 0) {
      return `Error: key(s) not found in this secret: ${unknown.join(', ')}. Valid keys: ${allKeys.join(', ')}`
    }

    const generated: Record<string, string> = {}
    for (const key of keysToGenerate) generated[key] = randomBytes(32).toString('hex')

    try {
      // Merge: generating a subset of keys must not wipe the others
      await updateVaultSecret(secret.remoteRef, generated)
    } catch (e) {
      return `Error: failed to write generated values to Vault: ${e instanceof Error ? e.message : String(e)}`
    }

    await ctx.prisma.managedSecret.update({
      where: { id: secretId },
      data: { status: 'applied', appliedAt: new Date() },
    })

    return [
      `Generated and stored values for secret "${secret.name}" (${secretId}):`,
      `  Keys generated: ${keysToGenerate.join(', ')}`,
      `  Vault path:     secret/data/${secret.remoteRef}`,
      `  Status:         applied`,
      ``,
      `Values were written directly to Vault — they were not returned here and are not in this conversation.`,
    ].join('\n')
  },
}
