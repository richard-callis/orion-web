/**
 * Regression tests: {{ resolveSecret <name> <key> }} → real secret value, end-to-end.
 *
 * renderProviderConfig() rewrites `{{ resolveSecret authentik-postgresql password }}`
 * into an opaque intermediate token `__RS_<index>__` (no `{{ }}`), and records the
 * {name, key} it refers to in the returned config's `resolveSecretRefs` map, keyed
 * by that token. syncOverlaySecret() is then supposed to find the token, look up
 * name/key from resolveSecretRefs, and substitute in the real secret value fetched
 * from the cluster.
 *
 * History:
 * - Originally, syncOverlaySecret's placeholderRe still searched for the *original*
 *   `{{ resolveSecret ... }}` template (already gone by then), so resolveTargets was
 *   always empty, and the manifest ended up with the literal placeholder string
 *   instead of the real password — silently breaking auth for anything using
 *   resolveSecret (e.g. Authentik's DB password). (Fixed in PR #722.)
 * - PR #722's delimiter-based token `__RS_<name>_<key>__` was itself ambiguous:
 *   if `key` contains a literal "__" (e.g. AUTHENTIK_POSTGRESQL__PASSWORD), the
 *   non-greedy regex `__RS_(.+?)_(.+?)__` mis-splits name/key. Switching to an
 *   opaque index-based token + side-channel resolveSecretRefs map removes the
 *   ambiguity entirely, since nothing is parsed out of the token string.
 * - Also, an unresolved placeholder (secret lookup fails or returns no value) used
 *   to be silently skipped, shipping the literal placeholder into the applied
 *   Kubernetes Secret. It now throws instead.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ prisma: {} }))
vi.mock('@/lib/auth', () => ({ requireAdmin: vi.fn() }))

import { renderProviderConfig, type ProviderConfig } from '@/lib/provider-engine'
import { syncOverlaySecret } from './route'

describe('resolveSecret placeholder resolution (renderProviderConfig -> syncOverlaySecret)', () => {
  it('resolves {{ resolveSecret <name> <key> }} to the real secret value in the final overlay Secret', async () => {
    const pcRaw: ProviderConfig = {
      name: 'authentik',
      displayName: 'Authentik',
      description: 'test',
      overlaySecret: {
        name: 'authentik-secret-fix',
        entries: [
          { key: 'AUTHENTIK_POSTGRESQL__PASSWORD', value: '{{ resolveSecret authentik-postgresql password }}' },
          { key: 'AUTHENTIK_BOOTSTRAP_PASSWORD', value: '{{ adminPassword }}' },
        ],
      },
      deployments: [],
    }

    // Step 1: render — this is where {{ resolveSecret ... }} becomes an opaque token
    const pc = renderProviderConfig(pcRaw, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'super-secret-admin-pw',
      provider: 'authentik',
      genSecrets: {},
    })

    // Sanity check on the intermediate form: opaque, index-based, not name/key encoded.
    const token = pc.overlaySecret!.entries[0].value
    expect(token).toMatch(/^__RS_\d+__$/)
    expect(pc.resolveSecretRefs?.[token]).toEqual({ name: 'authentik-postgresql', key: 'password' })

    // Step 2: sync — fake `gx` stands in for the gateway/kubectl client and returns
    // the real DB password for the `authentik-postgresql` secret's `password` key.
    const REAL_PASSWORD = 'actual-db-password-123'
    const appliedManifests: string[] = []
    const gx = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'kubectl_get') {
        expect(args.resource).toBe('secret')
        expect(args.name).toBe('authentik-postgresql')
        expect(args.namespace).toBe('sso')
        return JSON.stringify({ data: { password: Buffer.from(REAL_PASSWORD).toString('base64') } })
      }
      if (tool === 'kubectl_apply_manifest') {
        appliedManifests.push(args.manifest as string)
        return ''
      }
      throw new Error(`unexpected tool: ${tool}`)
    })
    const log = vi.fn(async () => {})

    await syncOverlaySecret(gx, log as never, pc.overlaySecret!, pc, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'super-secret-admin-pw',
      provider: 'authentik',
    })

    expect(appliedManifests).toHaveLength(1)
    const manifest = appliedManifests[0]

    // The real fix: the applied Secret manifest must contain the actual resolved
    // password, and must NOT contain the broken literal placeholder string.
    expect(manifest).toContain(REAL_PASSWORD)
    expect(manifest).not.toContain('__RS_')
    expect(manifest).toContain('super-secret-admin-pw')
  })

  it('resolves correctly even when the secret KEY itself contains a literal "__"', async () => {
    // This is exactly the case that was ambiguous under the old delimiter-based
    // `__RS_<name>_<key>__` encoding: the non-greedy regex couldn't tell where
    // "the __ inside the key" ended and "the __ that terminates the token" began.
    const pcRaw: ProviderConfig = {
      name: 'authentik',
      displayName: 'Authentik',
      description: 'test',
      overlaySecret: {
        name: 'authentik-secret-fix',
        entries: [
          { key: 'AUTHENTIK_POSTGRESQL__PASSWORD', value: '{{ resolveSecret pg AUTHENTIK_POSTGRESQL__PASSWORD }}' },
        ],
      },
      deployments: [],
    }

    const pc = renderProviderConfig(pcRaw, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'admin-pw',
      provider: 'authentik',
      genSecrets: {},
    })

    const token = pc.overlaySecret!.entries[0].value
    // The name/key must be recovered exactly, including the "__" inside the key.
    expect(pc.resolveSecretRefs?.[token]).toEqual({ name: 'pg', key: 'AUTHENTIK_POSTGRESQL__PASSWORD' })

    const REAL_PASSWORD = 'db-password-with-dunder-key'
    const appliedManifests: string[] = []
    const gx = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'kubectl_get') {
        expect(args.name).toBe('pg')
        return JSON.stringify({ data: { AUTHENTIK_POSTGRESQL__PASSWORD: Buffer.from(REAL_PASSWORD).toString('base64') } })
      }
      if (tool === 'kubectl_apply_manifest') {
        appliedManifests.push(args.manifest as string)
        return ''
      }
      throw new Error(`unexpected tool: ${tool}`)
    })
    const log = vi.fn(async () => {})

    await syncOverlaySecret(gx, log as never, pc.overlaySecret!, pc, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'admin-pw',
      provider: 'authentik',
    })

    const manifest = appliedManifests[0]
    expect(manifest).toContain(REAL_PASSWORD)
    expect(manifest).not.toContain('__RS_')
  })

  it('resolves multiple distinct resolveSecret placeholders in a single config', async () => {
    const pcRaw: ProviderConfig = {
      name: 'authentik',
      displayName: 'Authentik',
      description: 'test',
      overlaySecret: {
        name: 'authentik-secret-fix',
        entries: [
          { key: 'DB_PASSWORD', value: '{{ resolveSecret authentik-postgresql password }}' },
          { key: 'REDIS_PASSWORD', value: '{{ resolveSecret authentik-redis password }}' },
          {
            key: 'COMBINED',
            value: '{{ resolveSecret authentik-postgresql password }}:{{ resolveSecret authentik-redis password }}',
          },
        ],
      },
      deployments: [],
    }

    const pc = renderProviderConfig(pcRaw, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'admin-pw',
      provider: 'authentik',
      genSecrets: {},
    })

    // Each occurrence gets a distinct token, even for the same name/key repeated.
    const tokens = [
      pc.overlaySecret!.entries[0].value,
      pc.overlaySecret!.entries[1].value,
      ...pc.overlaySecret!.entries[2].value.split(':'),
    ]
    expect(new Set(tokens).size).toBe(4)

    const DB_PW = 'db-pw-value'
    const REDIS_PW = 'redis-pw-value'
    const appliedManifests: string[] = []
    const gx = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'kubectl_get') {
        const name = args.name as string
        const value = name === 'authentik-postgresql' ? DB_PW : REDIS_PW
        const key = name === 'authentik-postgresql' ? 'password' : 'password'
        return JSON.stringify({ data: { [key]: Buffer.from(value).toString('base64') } })
      }
      if (tool === 'kubectl_apply_manifest') {
        appliedManifests.push(args.manifest as string)
        return ''
      }
      throw new Error(`unexpected tool: ${tool}`)
    })
    const log = vi.fn(async () => {})

    await syncOverlaySecret(gx, log as never, pc.overlaySecret!, pc, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'admin-pw',
      provider: 'authentik',
    })

    const manifest = appliedManifests[0]
    expect(manifest).toContain(DB_PW)
    expect(manifest).toContain(REDIS_PW)
    expect(manifest).toContain(`${DB_PW}:${REDIS_PW}`)
    expect(manifest).not.toContain('__RS_')
  })

  it('throws instead of silently shipping a literal placeholder when a secret cannot be resolved', async () => {
    const pcRaw: ProviderConfig = {
      name: 'authentik',
      displayName: 'Authentik',
      description: 'test',
      overlaySecret: {
        name: 'authentik-secret-fix',
        entries: [
          { key: 'DB_PASSWORD', value: '{{ resolveSecret missing-secret password }}' },
        ],
      },
      deployments: [],
    }

    const pc = renderProviderConfig(pcRaw, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'admin-pw',
      provider: 'authentik',
      genSecrets: {},
    })

    const appliedManifests: string[] = []
    // Secret lookup "succeeds" but returns no data for the requested key —
    // simulating a misconfigured/missing secret reference.
    const gx = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'kubectl_get') {
        return JSON.stringify({ data: {} })
      }
      if (tool === 'kubectl_apply_manifest') {
        appliedManifests.push(args.manifest as string)
        return ''
      }
      throw new Error(`unexpected tool: ${tool}`)
    })
    const log = vi.fn(async () => {})

    await expect(
      syncOverlaySecret(gx, log as never, pc.overlaySecret!, pc, {
        hostname: 'auth.example.com',
        namespace: 'sso',
        clusterIssuer: 'letsencrypt',
        adminPassword: 'admin-pw',
        provider: 'authentik',
      })
    ).rejects.toThrow(/missing-secret\/password/)

    // No manifest should ever be applied when resolution fails.
    expect(appliedManifests).toHaveLength(0)
  })
})
