import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error plain ESM installer script (deploy/), no type declarations
import * as installer from '../../../../../deploy/authentik-oidc.mjs'

type Obj = Record<string, unknown> & { pk: string | number }
const { AuthentikApi, provisionAuthentik, storeInVault, providerPayload, EMAIL_MAPPING_NAME, readToken, main, vaultRequester } = installer

/** In-memory Authentik that ignores query filters (like the real /core/applications/?slug=). */
function fakeAuthentik(seed: Record<string, Obj[]> = {}) {
  const db: Record<string, Obj[]> = {
    '/flows/instances/': [{ pk: 'f-auth', slug: 'default-provider-authorization-explicit-consent' }, { pk: 'f-inv', slug: 'default-provider-invalidation-flow' }],
    '/crypto/certificatekeypairs/': [{ pk: 'cert-1', name: 'authentik Self-signed Certificate' }],
    '/core/groups/': [{ pk: 'g-admins', name: 'authentik Admins' }, { pk: 'g-other', name: 'other' }],
    '/propertymappings/provider/scope/': [
      { pk: 'm-openid', managed: 'goauthentik.io/providers/oauth2/scope-openid', scope_name: 'openid' },
      { pk: 'm-profile', managed: 'goauthentik.io/providers/oauth2/scope-profile', scope_name: 'profile' },
      { pk: 'm-email', managed: 'goauthentik.io/providers/oauth2/scope-email', scope_name: 'email' },
    ],
    '/providers/oauth2/': [], '/core/applications/': [], '/policies/bindings/': [], ...seed,
  }
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = []
  let seq = 0
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v3', '')
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const res = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s })
    if (method === 'GET' && db[path]) return res(200, { pagination: { next: 0 }, results: db[path] })
    const detail = path.match(/^(.*\/)([^/]+)\/$/)
    if (method === 'GET' && detail && db[detail[1]]) {
      const o = db[detail[1]].find((x) => String(x.pk) === detail[2])
      return o ? res(200, { ...o, client_id: 'cid', client_secret: 'csecret' }) : res(404, {})
    }
    if (method === 'POST' && db[path]) { const o = { pk: ++seq, ...body } as Obj; db[path].push(o); return res(201, o) }
    if (method === 'PATCH' && detail && db[detail[1]]) {
      const o = db[detail[1]].find((x) => String(x.pk) === detail[2] || x.slug === detail[2])!
      Object.assign(o, body); return res(200, o)
    }
    return res(404, { detail: 'nope' })
  })
  return { api: new AuthentikApi('https://sso.example.com/', 'tok-s3cr3t', fetchImpl), db, calls, fetchImpl }
}

const opts = { orionHost: 'orion.example.com' }

describe('Authentik provisioning payloads', () => {
  it('creates a confidential provider with explicit grant types, strict redirect URI and mappings', async () => {
    const { api, calls } = fakeAuthentik()
    const creds = await provisionAuthentik(api, opts)
    const provider = calls.find((c) => c.method === 'POST' && c.path === '/providers/oauth2/')!.body!
    expect(provider).toMatchObject({
      client_type: 'confidential',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [{ matching_mode: 'strict', url: 'https://orion.example.com/api/auth/callback/authentik' }],
      sub_mode: 'hashed_user_id', signing_key: 'cert-1', authorization_flow: 'f-auth', invalidation_flow: 'f-inv',
    })
    const mappingPost = calls.find((c) => c.method === 'POST' && c.path === '/propertymappings/provider/scope/')!.body!
    expect(mappingPost).toMatchObject({ name: EMAIL_MAPPING_NAME, scope_name: 'email' })
    expect(mappingPost.expression).toContain('"email_verified": True')
    expect(provider.property_mappings).toEqual(['m-openid', 'm-profile', 1])
    expect(creds).toEqual({ issuer: 'https://sso.example.com/application/o/orion/', client_id: 'cid', client_secret: 'csecret' })
  })

  it('creates the application and binds it to the admin group only', async () => {
    const { api, calls, db } = fakeAuthentik()
    await provisionAuthentik(api, { ...opts, slug: 'orion', group: 'authentik Admins' })
    expect(calls.find((c) => c.path === '/core/applications/' && c.method === 'POST')!.body).toMatchObject({ slug: 'orion', provider: db['/providers/oauth2/'][0].pk })
    expect(calls.find((c) => c.path === '/policies/bindings/' && c.method === 'POST')!.body).toMatchObject({ group: 'g-admins', target: db['/core/applications/'][0].pk })
  })

  it('fails clearly when the group does not exist', async () => {
    const { api } = fakeAuthentik({ '/core/groups/': [] })
    await expect(provisionAuthentik(api, opts)).rejects.toThrow(/group "authentik Admins" not found/)
  })

  it('sends the token only in the Authorization header, on every request', async () => {
    const { api, fetchImpl } = fakeAuthentik()
    await provisionAuthentik(api, opts)
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(5)
    for (const [url, init] of fetchImpl.mock.calls) {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-s3cr3t')
      expect(url).not.toContain('tok-s3cr3t')
      expect(String(init.body ?? '')).not.toContain('tok-s3cr3t')
    }
  })

  it('prefers the managed profile mapping over an unmanaged one listed first, and writes nothing if openid is missing', async () => {
    const scope = fakeAuthentik().db['/propertymappings/provider/scope/']
    const { api, calls } = fakeAuthentik({ '/propertymappings/provider/scope/': [{ pk: 'custom-profile', managed: null, scope_name: 'profile' }, ...scope] })
    await provisionAuthentik(api, opts)
    expect(calls.find((c) => c.path === '/providers/oauth2/' && c.method === 'POST')!.body!.property_mappings).toContain('m-profile')
    const none = fakeAuthentik({ '/propertymappings/provider/scope/': [] })
    await expect(provisionAuthentik(none.api, opts)).rejects.toThrow(/openid scope mapping not found/)
    expect(none.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('providerPayload builds the redirect URI from the host', () => {
    expect(providerPayload({ name: 'n', orionHost: 'h.example.com', authorizationFlow: 'a', invalidationFlow: 'i', signingKey: 'k', mappings: [] }).redirect_uris[0].url)
      .toBe('https://h.example.com/api/auth/callback/authentik')
  })
})

describe('idempotent re-run', () => {
  it('matches the existing app by slug client-side and updates instead of duplicating', async () => {
    const { api, calls, db } = fakeAuthentik()
    await provisionAuthentik(api, opts)
    // Another app listed first proves the (ignored) ?slug= filter is not relied on.
    db['/core/applications/'].unshift({ pk: 'other', slug: 'something-else', provider: 99 })
    calls.length = 0
    await provisionAuthentik(api, opts)
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(db['/providers/oauth2/']).toHaveLength(1)
    expect(db['/core/applications/']).toHaveLength(2)
    expect(db['/policies/bindings/']).toHaveLength(1)
    expect(db['/propertymappings/provider/scope/'].filter((m) => m.name === EMAIL_MAPPING_NAME)).toHaveLength(1)
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/core/applications/orion/')).toBe(true)
    expect(calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/providers/oauth2/'))).toBe(true)
  })

  it('repairs a provider created earlier with empty grant_types', async () => {
    const { api, db } = fakeAuthentik({
      '/providers/oauth2/': [{ pk: 7, name: 'orion-oidc', grant_types: [] }],
      '/core/applications/': [{ pk: 'a1', slug: 'orion', provider: 7 }],
    })
    await provisionAuthentik(api, opts)
    expect(db['/providers/oauth2/']).toHaveLength(1)
    expect(db['/providers/oauth2/'][0].grant_types).toEqual(['authorization_code', 'refresh_token'])
  })
})

describe('re-run keeps operator changes', () => {
  it('merges property mappings, drops only the default email mapping, and keeps names', async () => {
    const { api, db, calls } = fakeAuthentik({
      '/providers/oauth2/': [{ pk: 7, name: 'my-provider', grant_types: [], property_mappings: ['m-openid', 'm-email', 'm-groups'] }],
      '/core/applications/': [{ pk: 'a1', slug: 'orion', name: 'My Orion', provider: 7 }],
    })
    await provisionAuthentik(api, opts)
    const p = db['/providers/oauth2/'][0]
    expect(p.name).toBe('my-provider')
    expect(p.property_mappings).toEqual(expect.arrayContaining(['m-openid', 'm-profile', 'm-groups']))
    expect(p.property_mappings).not.toContain('m-email')
    expect(p.property_mappings).toHaveLength(4)
    expect(db['/core/applications/'][0].name).toBe('My Orion')
    expect(calls.find((c) => c.method === 'PATCH' && c.path === '/core/applications/orion/')!.body).toEqual({ provider: 7, slug: 'orion' })
  })

  it('refuses an application that uses a non-OAuth2 provider', async () => {
    const { api, calls } = fakeAuthentik({ '/core/applications/': [{ pk: 'a1', slug: 'orion', provider: 55 }] })
    await expect(provisionAuthentik(api, opts)).rejects.toThrow(/non-OAuth2 provider/)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
})

describe('Vault storage', () => {
  const data = { issuer: 'https://sso.example.com/application/o/orion/', client_id: 'cid', client_secret: 'csecret' }
  const vaultWith = (cur: { status: number; json?: unknown }) => {
    const calls: Array<[string, string, unknown]> = []
    const v = vi.fn(async (m: string, p: string, b?: unknown) => { calls.push([m, p, b]); return m === 'GET' ? cur : { status: 200, json: {} } })
    return { v, calls }
  }

  it('writes issuer/client_id/client_secret to the fixed KV v2 path', async () => {
    const { v, calls } = vaultWith({ status: 404 })
    await expect(storeInVault(v, 'secret/orion/authentik-oidc', data)).resolves.toBe(true)
    expect(calls[1]).toEqual(['POST', 'secret/data/orion/authentik-oidc', { data }])
  })

  it('skips the write when Vault already holds the same values', async () => {
    const { v, calls } = vaultWith({ status: 200, json: { data: { data } } })
    await expect(storeInVault(v, 'orion/authentik-oidc', data)).resolves.toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('surfaces Vault errors', async () => {
    await expect(storeInVault(vaultWith({ status: 503 }).v, 'p', data)).rejects.toThrow(/503/)
  })
})

describe('CLI', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('readToken trims and rejects empty input', () => {
    expect(readToken(undefined, () => '  tok\n')).toBe('tok')
    expect(() => readToken(undefined, () => ' \n')).toThrow(/No Authentik API token/)
  })

  it('vaultRequester sends the token in X-Vault-Token', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    await vaultRequester({ VAULT_ADDR: 'http://vault:8200', VAULT_TOKEN: 'vt' }, f)('GET', 'secret/data/x')
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-Vault-Token': 'vt' })
  })

  function setup() {
    const ak = fakeAuthentik()
    const kv: Record<string, unknown> = {}
    const seen: Array<[string, RequestInit]> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      seen.push([url, init])
      if (url.startsWith('http://vault:8200/')) {
        const p = url.slice('http://vault:8200/v1/'.length)
        if (init.method === 'POST') { kv[p] = JSON.parse(String(init.body)); return new Response('{}', { status: 200 }) }
        return kv[p] ? new Response(JSON.stringify({ data: kv[p] }), { status: 200 }) : new Response('{}', { status: 404 })
      }
      return ak.fetchImpl(url, init)
    }))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akt-'))
    const tokenFile = path.join(dir, 'token')
    fs.writeFileSync(tokenFile, 'tok-s3cr3t\n')
    const env = { AUTHENTIK_URL: 'https://sso.example.com', ORION_HOST: 'orion.example.com', AUTHENTIK_TOKEN_FILE: tokenFile, VAULT_ADDR: 'http://vault:8200', VAULT_TOKEN: 'vt' }
    return { env, kv, seen, dir }
  }

  it('main returns 0 when it writes Vault, 3 on an unchanged re-run, and never leaks the token', async () => {
    const { env, kv, seen, dir } = setup()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect(main(env)).resolves.toBe(0)
      expect(Object.keys(kv)).toEqual(['secret/data/orion/authentik-oidc'])
      await expect(main(env)).resolves.toBe(3)
      for (const [url, init] of seen) {
        if (url.startsWith('http://vault:8200/')) continue
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-s3cr3t')
        expect(url + String(init.body ?? '')).not.toContain('tok-s3cr3t')
      }
    } finally { fs.rmSync(dir, { recursive: true }) }
  })

  it('main rejects an http:// Authentik URL, missing inputs and a missing VAULT_TOKEN before any request', async () => {
    const { env, seen, dir } = setup()
    try {
      await expect(main({ ...env, AUTHENTIK_URL: 'http://sso.example.com' })).rejects.toThrow(/https/)
      await expect(main({ ...env, ORION_HOST: '' })).rejects.toThrow(/required/)
      await expect(main({ ...env, VAULT_TOKEN: '' })).rejects.toThrow(/VAULT_TOKEN/)
      expect(seen).toEqual([])
    } finally { fs.rmSync(dir, { recursive: true }) }
  })
})
