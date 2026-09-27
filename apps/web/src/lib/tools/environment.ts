/**
 * Environment tools: read, patch and bootstrap cluster environments.
 *
 * Tool definitions only — registered (in the canonical order) by ./index.ts.
 */

import { z } from 'zod'
import { parseToolArgs } from './shared'
import type { ToolDefinition } from './registry'

const OrionGetEnvironmentArgs = z.object({
  environment_id: z.string().nullish(),
})

export const orionGetEnvironmentTool: ToolDefinition = {
  name: 'orion_get_environment',
  description: 'Get the configuration and status of an ORION environment, including whether kubeconfig is stored.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
    },
    required: ['environment_id'],
  },
  tier: 'read',
  parallelSafe: true,
  availableIn: 'chat',
  category: 'environment',
  handler: async (args, ctx) => {
    try {
      const { environment_id } = parseToolArgs(OrionGetEnvironmentArgs, args)
      if (!environment_id) return 'Error: environment_id is required'
      const env = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      const e = env as Record<string, unknown>
      return JSON.stringify({
        id:               env.id,
        name:             env.name,
        type:             env.type,
        status:           env.status,
        gatewayUrl:       env.gatewayUrl,
        kubeconfig:       env.kubeconfig ? '••••' : null,
        gitOwner:         env.gitOwner,
        gitRepo:          env.gitRepo,
        repoPath:         e.repoPath        ?? null,
        vaultPathPrefix:  e.vaultPathPrefix ?? null,
        _conventions: {
          manifests:    e.repoPath        ? `Files go in: ${e.repoPath}/<service>/` : 'not set — ask a human',
          vaultSecrets: e.vaultPathPrefix ? `Secrets go at: secret/${e.vaultPathPrefix}/<service>` : 'not set — ask a human',
        },
      }, null, 2)
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
}

const OrionPatchEnvironmentArgs = z.object({
  environment_id: z.string().nullish(),
  body: z.record(z.string(), z.unknown()).nullish(),
})

export const orionPatchEnvironmentTool: ToolDefinition = {
  name: 'orion_patch_environment',
  description: 'Update fields on an ORION environment (e.g. save kubeconfig, update gatewayUrl). Requires a ToolExecutionGrant because kubeconfig writes grant cluster admin to whoever controls the kubeconfig.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
      body:           { type: 'object', description: 'Fields to update, e.g. {"kubeconfig": "<base64>"}' },
    },
    required: ['environment_id', 'body'],
  },
  // Upgraded from 'write' to 'destructive': kubeconfig is in the allowed fields
  // and writing cluster credentials is equivalent to gaining cluster admin. Any
  // agent calling this must have a one-time ToolExecutionGrant from an operator.
  tier: 'destructive',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'environment',
  handler: async (args, ctx) => {
    try {
      const { environment_id, body } = parseToolArgs(OrionPatchEnvironmentArgs, args)
      if (!environment_id) return 'Error: environment_id is required'
      if (!body || typeof body !== 'object') return 'Error: body must be an object'

      const ALLOWED = ['kubeconfig', 'gatewayUrl', 'gitOwner', 'gitRepo', 'description', 'repoPath', 'vaultPathPrefix']
      const update: Record<string, unknown> = {}
      for (const key of ALLOWED) {
        if (key in body) update[key] = body[key]
      }
      if (!Object.keys(update).length) return 'Error: no patchable fields provided'

      const target = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!target) return `Error: environment "${environment_id}" not found`
      await ctx.prisma.environment.update({ where: { id: target.id }, data: update })
      return `Environment "${target.name}" updated: ${Object.keys(update).join(', ')}`
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
}

const OrionBootstrapEnvironmentArgs = z.object({
  environment_id: z.string().nullish(),
})

export const orionBootstrapEnvironmentTool: ToolDefinition = {
  name: 'orion_bootstrap_environment',
  description: 'Trigger the bootstrap process for a Kubernetes cluster environment. Deploys ArgoCD and ORION Gateway into the cluster.',
  inputSchema: {
    type: 'object',
    properties: {
      environment_id: { type: 'string', description: 'Environment ID' },
    },
    required: ['environment_id'],
  },
  tier: 'destructive',
  parallelSafe: false,
  availableIn: 'chat',
  category: 'environment',
  handler: async (args, ctx) => {
    try {
      const { environment_id } = parseToolArgs(OrionBootstrapEnvironmentArgs, args)
      if (!environment_id) return 'Error: environment_id is required'

      const env = await ctx.prisma.environment.findFirst({
        where: { OR: [{ id: environment_id }, { name: { equals: environment_id, mode: 'insensitive' } }] },
      })
      if (!env) return `Error: environment "${environment_id}" not found`
      if (!env.kubeconfig) return 'Error: no kubeconfig stored for this environment. Patch it first using orion_patch_environment.'
      if (env.status === 'connected') return `Environment "${env.name}" is already connected (status: connected). Bootstrapping again would re-deploy the gateway unnecessarily. To force re-bootstrap, first set status to 'pending' via orion_patch_environment.`

      // Check for an already-running or queued bootstrap job (idempotency guard)
      const existingJob = await ctx.prisma.backgroundJob.findFirst({
        where: {
          type: 'cluster-bootstrap',
          metadata: { path: ['environmentId'], equals: env.id },
          status: { in: ['queued', 'running'] },
        },
        select: { id: true, status: true },
      })
      if (existingJob) {
        return `Error: a bootstrap job is already ${existingJob.status} for environment "${env.name}" (job: ${existingJob.id}). Wait for it to complete before starting another.`
      }

      // x-internal-call header was never checked in middleware — the bootstrap
      // self-call always failed because /api/environments is a BEARER_PATH that
      // requires Authorization: Bearer. Use ORION_GATEWAY_TOKEN or ORION_MCP_TOKEN.
      const serviceToken = process.env.ORION_GATEWAY_TOKEN ?? process.env.ORION_MCP_TOKEN ?? ''
      if (!serviceToken) return 'Error: no service token configured (ORION_GATEWAY_TOKEN or ORION_MCP_TOKEN required)'
      const baseUrl = process.env.ORION_CALLBACK_URL ?? `http://localhost:${process.env.PORT ?? 3000}`
      const res = await fetch(`${baseUrl}/api/environments/${env.id}/bootstrap`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceToken}`,
        },
      })
      if (!res.ok) return `Bootstrap request failed: HTTP ${res.status}`

      const reader = res.body?.getReader()
      if (!reader) return 'Bootstrap started (no stream output)'
      const decoder = new TextDecoder()
      const lines: string[] = []
      let done = false
      while (!done) {
        const { value, done: d } = await reader.read()
        done = d
        if (value) {
          const chunk = decoder.decode(value, { stream: true })
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const evt = JSON.parse(line.slice(6)) as { type: string; message?: string }
              if (evt.message) lines.push(`[${evt.type}] ${evt.message}`)
            } catch { /* skip */ }
          }
        }
      }
      return lines.length ? lines.join('\n') : 'Bootstrap completed (no output captured)'
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
}
