/**
 * Regression test: {{ resolveSecret <name> <key> }} → real secret value, end-to-end.
 *
 * renderProviderConfig() rewrites `{{ resolveSecret authentik-postgresql password }}`
 * into the bare intermediate token `__RS_authentik-postgresql_password__` (no `{{ }}`).
 * syncOverlaySecret() is then supposed to find that token and substitute in the real
 * secret value fetched from the cluster.
 *
 * Previously, syncOverlaySecret's placeholderRe still searched for the *original*
 * `{{ resolveSecret ... }}` template (already gone by then), so resolveTargets was
 * always empty, and the manifest ended up with the literal string
 * `__RS_authentik-postgresql_password__` instead of the real password — silently
 * breaking auth for anything using resolveSecret (e.g. Authentik's DB password).
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

    // Step 1: render — this is where {{ resolveSecret ... }} becomes __RS_..._...__
    const pc = renderProviderConfig(pcRaw, {
      hostname: 'auth.example.com',
      namespace: 'sso',
      clusterIssuer: 'letsencrypt',
      adminPassword: 'super-secret-admin-pw',
      provider: 'authentik',
      genSecrets: {},
    })

    // Sanity check on the intermediate form, matching the doc comment in provider-engine.ts
    expect(pc.overlaySecret!.entries[0].value).toBe('__RS_authentik-postgresql_password__')

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
})
