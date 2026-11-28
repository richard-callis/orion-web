// Provisions Authentik for ORION's "Sign in with Authentik" login (docs/AUTHENTIK_OIDC.md).
// Idempotent: finds the app/provider/mappings/binding by slug/name and updates them.
// Stores issuer, client_id and client_secret in Vault KV v2 (default secret/orion/authentik-oidc).
//
// Zero dependencies (Node built-ins only) so it runs inside the orion container; see
// deploy/authentik-oidc-bootstrap.sh. The Authentik API token is read from stdin or a file,
// never from argv, and is never printed.
import fs from 'node:fs'
import https from 'node:https'

export const EMAIL_MAPPING_NAME = 'ORION: email (email_verified true)'
// Trusts Authentik admins to set users' emails: they are reported as verified.
export const EMAIL_MAPPING_EXPRESSION = 'return {"email": request.user.email, "email_verified": True}'
const MANAGED = (s) => `goauthentik.io/providers/oauth2/scope-${s}`
const DEFAULT_CERT = 'authentik Self-signed Certificate'

export function redirectUri(orionHost) {
  return `https://${orionHost}/api/auth/callback/authentik`
}

/** Body for POST/PATCH /providers/oauth2/. Flows/key/mappings are resolved UUIDs. */
export function providerPayload({ name, orionHost, authorizationFlow, invalidationFlow, signingKey, mappings }) {
  return {
    name,
    authorization_flow: authorizationFlow,
    invalidation_flow: invalidationFlow,
    client_type: 'confidential',
    // The API creates the provider with an empty list otherwise, and authorize then fails
    // with "Invalid grant_type for provider".
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [{ matching_mode: 'strict', url: redirectUri(orionHost) }],
    signing_key: signingKey,
    property_mappings: mappings,
    sub_mode: 'hashed_user_id',
    include_claims_in_id_token: true,
  }
}

export class AuthentikApi {
  constructor(baseUrl, token, fetchImpl = fetch) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.token = token
    this.fetch = fetchImpl
  }

  async call(method, path, body) {
    const res = await this.fetch(`${this.base}/api/v3${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Authentik ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  }

  /** All pages of a list endpoint. Query filters are unreliable (e.g. /core/applications/?slug=
   *  is ignored), so callers match client-side. */
  async list(path) {
    const out = []
    for (let page = 1; page <= 100; page++) {
      const r = await this.call('GET', `${path}${path.includes('?') ? '&' : '?'}page_size=100&page=${page}`)
      out.push(...(r.results ?? []))
      if (!r.pagination?.next) break
    }
    return out
  }
}

/** Create-or-update `payload` on the matching existing object. */
async function upsert(api, listPath, match, payload, key = 'pk') {
  const found = (await api.list(listPath)).find(match)
  const base = listPath.split('?')[0]
  return found ? api.call('PATCH', `${base}${found[key]}/`, payload) : api.call('POST', base, payload)
}

function need(items, pred, what) {
  const hit = items.find(pred)
  if (!hit) throw new Error(`Authentik: ${what} not found`)
  return hit
}

export async function provisionAuthentik(api, { orionHost, slug = 'orion', group = 'authentik Admins', authorizationFlowSlug = 'default-provider-authorization-explicit-consent', invalidationFlowSlug = 'default-provider-invalidation-flow' }) {
  const flows = await api.list('/flows/instances/')
  const authorizationFlow = need(flows, (f) => f.slug === authorizationFlowSlug, `flow ${authorizationFlowSlug}`).pk
  const invalidationFlow = need(flows, (f) => f.slug === invalidationFlowSlug, `flow ${invalidationFlowSlug}`).pk
  const signingKey = need(await api.list('/crypto/certificatekeypairs/'), (c) => c.name === DEFAULT_CERT, `certificate "${DEFAULT_CERT}"`).pk
  const groupObj = need(await api.list('/core/groups/'), (g) => g.name === group, `group "${group}"`)

  const scopes = await api.list('/propertymappings/provider/scope/')
  const standard = (s) => need(scopes, (m) => m.managed === MANAGED(s) || (!m.managed && m.scope_name === s), `${s} scope mapping`).pk
  const email = await upsert(api, '/propertymappings/provider/scope/', (m) => m.name === EMAIL_MAPPING_NAME,
    { name: EMAIL_MAPPING_NAME, scope_name: 'email', expression: EMAIL_MAPPING_EXPRESSION })
  const mappings = [standard('openid'), standard('profile'), email.pk]

  const name = `${slug}-oidc`
  // Prefer the provider already bound to the app, then fall back to the provider name.
  const apps = await api.list('/core/applications/')
  const existingApp = apps.find((a) => a.slug === slug)
  const payload = providerPayload({ name, orionHost, authorizationFlow, invalidationFlow, signingKey, mappings })
  const providers = await api.list('/providers/oauth2/')
  const existing = providers.find((p) => existingApp?.provider != null && p.pk === existingApp.provider) ?? providers.find((p) => p.name === name)
  const provider = existing ? await api.call('PATCH', `/providers/oauth2/${existing.pk}/`, payload) : await api.call('POST', '/providers/oauth2/', payload)

  const appBody = { name: 'ORION', slug, provider: provider.pk }
  const app = existingApp ? await api.call('PATCH', `/core/applications/${slug}/`, appBody) : await api.call('POST', '/core/applications/', appBody)

  // Any binding restricts the app to the bound groups/users.
  const bindings = await api.list('/policies/bindings/')
  if (!bindings.some((b) => b.target === app.pk && b.group === groupObj.pk)) {
    await api.call('POST', '/policies/bindings/', { target: app.pk, group: groupObj.pk, order: 0, enabled: true, negate: false, timeout: 30 })
  }

  // The list/create response may omit the secret; the detail view carries it.
  const detail = await api.call('GET', `/providers/oauth2/${provider.pk}/`)
  return { issuer: `${api.base}/application/o/${slug}/`, client_id: detail.client_id, client_secret: detail.client_secret }
}

// ── Vault (KV v2) ───────────────────────────────────────────────────────────────

function vaultAgent(env) {
  if (!env.VAULT_CACERT && !env.VAULT_CLIENT_CERT) return undefined
  const read = (p) => (p ? fs.readFileSync(p) : undefined)
  return new https.Agent({ ca: read(env.VAULT_CACERT), cert: read(env.VAULT_CLIENT_CERT), key: read(env.VAULT_CLIENT_KEY), rejectUnauthorized: true })
}

/** Same transport as apps/web/src/lib/vault.ts: mTLS via the vault-proxy when configured. */
export function vaultRequester(env = process.env, fetchImpl = fetch) {
  const addr = (env.VAULT_ADDR ?? 'http://vault:8200').replace(/\/+$/, '')
  const agent = addr.startsWith('https://') ? vaultAgent(env) : undefined
  return (method, path, body) => {
    const headers = { 'X-Vault-Token': env.VAULT_TOKEN ?? '', 'Content-Type': 'application/json' }
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (!agent) return fetchImpl(`${addr}/v1/${path}`, { method, headers, body: payload }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))
    return new Promise((resolve, reject) => {
      const req = https.request(`${addr}/v1/${path}`, { method, headers, agent, timeout: 10_000 }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => { let json = {}; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* empty body */ } resolve({ status: res.statusCode ?? 500, json }) })
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('Vault request timed out')))
      req.end(payload)
    })
  }
}

/** Writes `data` unless the secret already holds exactly these values. Returns true if written. */
export async function storeInVault(vault, kvPath, data) {
  const p = `secret/data/${kvPath.replace(/^secret\/(data\/)?/, '')}`
  const cur = await vault('GET', p)
  if (cur.status === 200 && Object.entries(data).every(([k, v]) => cur.json?.data?.data?.[k] === v)) return false
  if (cur.status !== 200 && cur.status !== 404) throw new Error(`Vault read ${p} -> ${cur.status}`)
  const res = await vault('POST', p, { data })
  if (res.status >= 300) throw new Error(`Vault write ${p} -> ${res.status}: ${(res.json?.errors ?? []).join(', ')}`)
  return true
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

export function readToken(file, readStdin = () => fs.readFileSync(0, 'utf8')) {
  const token = (file ? fs.readFileSync(file, 'utf8') : readStdin()).trim()
  if (!token) throw new Error('No Authentik API token supplied (stdin or AUTHENTIK_TOKEN_FILE)')
  return token
}

/** Exit codes: 0 = Vault updated (restart orion), 3 = already up to date, 1 = error. */
export async function main(env = process.env) {
  const base = env.AUTHENTIK_URL
  const orionHost = env.ORION_HOST
  if (!base || !orionHost) throw new Error('AUTHENTIK_URL and ORION_HOST are required')
  if (!/^https:\/\//.test(base) && env.AUTHENTIK_ALLOW_HTTP !== '1') throw new Error('AUTHENTIK_URL must be https:// (the API token is sent to it)')
  const api = new AuthentikApi(base, readToken(env.AUTHENTIK_TOKEN_FILE))
  const creds = await provisionAuthentik(api, { orionHost, slug: env.AUTHENTIK_APP_SLUG || 'orion', group: env.AUTHENTIK_ADMIN_GROUP || 'authentik Admins' })
  if (!creds.client_id || !creds.client_secret) throw new Error('Authentik returned no client credentials')
  const changed = await storeInVault(vaultRequester(env), env.AUTHENTIK_VAULT_PATH || 'secret/orion/authentik-oidc', creds)
  console.log(changed ? 'Authentik OIDC provisioned; credentials written to Vault.' : 'Authentik OIDC already up to date.')
  return changed ? 0 : 3
}

if (process.env.ORION_AUTHENTIK_CLI === '1') {
  main().then((code) => process.exit(code), (e) => { console.error(`ERROR: ${e.message}`); process.exit(1) })
}
