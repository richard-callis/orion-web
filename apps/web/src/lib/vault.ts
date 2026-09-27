/**
 * Shared Vault KV v2 write helper.
 * Used by both the secrets API routes and the agent tool executor.
 */

import https from 'node:https'
import fs from 'node:fs'
import { prisma } from './db'
import { decrypt, PREFIX } from './encryption'

export const VAULT_ADDR = process.env.VAULT_ADDR ?? 'http://vault:8200'

// ── mTLS agent ────────────────────────────────────────────────────────────────
// When VAULT_CACERT / VAULT_CLIENT_CERT / VAULT_CLIENT_KEY are set, all Vault
// calls go through the Envoy proxy with mutual TLS. Falls back to plain fetch
// when the env vars are absent (e.g. local dev pointing directly at Vault HTTP).

let _agent: https.Agent | undefined | null = null   // null = not yet initialised

function getVaultAgent(): https.Agent | undefined {
  if (_agent !== null) return _agent
  const caPath   = process.env.VAULT_CACERT
  const certPath = process.env.VAULT_CLIENT_CERT
  const keyPath  = process.env.VAULT_CLIENT_KEY
  if (!caPath && !certPath) {
    // No cert configuration — only allow if VAULT_ADDR is HTTP (dev/local).
    // In production, VAULT_ADDR should be HTTPS and certs must be configured.
    const addr = process.env.VAULT_ADDR ?? ''
    if (addr.startsWith('https://') && process.env.NODE_ENV === 'production') {
      throw new Error(
        'Vault mTLS not configured: VAULT_CACERT must be set when VAULT_ADDR uses HTTPS in production. ' +
        'Refusing to connect without cert verification.'
      )
    }
    _agent = undefined
    return undefined
  }
  _agent = new https.Agent({
    ca:   caPath   ? fs.readFileSync(caPath)   : undefined,
    cert: certPath ? fs.readFileSync(certPath) : undefined,
    key:  keyPath  ? fs.readFileSync(keyPath)  : undefined,
    // Always verify the server cert — never silently downgrade.
    rejectUnauthorized: true,
  })
  return _agent
}

/**
 * Drop-in replacement for `fetch()` that adds mTLS when Vault certs are
 * configured. Returns a standard `Response` so callers need no changes.
 */
export function vaultFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const agent = getVaultAgent()
  if (!agent) return fetch(url, options)

  // Native fetch() in Node.js doesn't accept an https.Agent directly.
  // Use node:https.request and wrap the result in a Response.
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const body   = options.body ? String(options.body) : undefined
    const reqOpts: https.RequestOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   (options.method ?? 'GET').toUpperCase(),
      headers:  options.headers as Record<string, string> | undefined,
      agent,
      timeout:  10_000,
    }

    const req = https.request(reqOpts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const text   = buffer.toString('utf8')
        const status = res.statusCode ?? 500
        // Construct a Response-compatible object
        resolve(new Response(text, {
          status,
          headers: res.headers as Record<string, string>,
        }))
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Vault request timed out')) })

    if (body) req.write(body)
    req.end()
  })
}

// ── Admin token resolution ──────────────────────────────────────────────────────

/**
 * Resolve the Vault token to use for admin writes.
 *
 * Prefers the wizard-configured 'vault.adminToken' SystemSetting — minted with
 * a scoped orion-admin policy as part of the in-app Vault init flow (root is
 * generated once and immediately revoked, never persisted; note this setting
 * is deliberately not named 'vault.rootToken').
 *
 * Falls back to VAULT_TOKEN from the environment, but only when
 * VAULT_ALLOW_ENV_TOKEN=1 is explicitly set — this covers instances where
 * Vault was bootstrapped outside the wizard (e.g. via deploy/bootstrap.sh +
 * a vault-unsealer sidecar) and the wizard's token-minting step never ran.
 * Deliberately opt-in rather than automatic: VAULT_TOKEN is frequently the
 * break-glass root/admin token handed back by bootstrap.sh (see
 * deploy/.env.example), not the scoped orion-admin policy the wizard mints.
 * writeVaultSecret() is agent-reachable (agents can call the write_secret
 * tool), so silently falling back would let agent-initiated writes run as
 * root with no visible distinction from a properly scoped call, and Vault's
 * own audit log would attribute them to root instead of the orion-admin
 * identity. Requiring the explicit flag keeps that a deliberate operator
 * choice instead of an invisible default.
 */
async function resolveVaultAdminToken(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'vault.adminToken' } })
  if (setting?.value) {
    const rawValue = String(setting.value)
    if (!rawValue.startsWith(PREFIX)) {
      console.error('[vault] admin token is not encrypted — refusing to use plaintext token (possible substitution attack)')
      throw new Error('Vault admin token must be encrypted')
    }
    return decrypt(rawValue)
  }

  if (process.env.VAULT_ALLOW_ENV_TOKEN === '1' && process.env.VAULT_TOKEN) {
    console.warn(
      "[vault] 'vault.adminToken' SystemSetting not configured — falling back to VAULT_TOKEN from the environment " +
      '(VAULT_ALLOW_ENV_TOKEN=1). This is likely a root/break-glass token, not the wizard-minted scoped policy — ' +
      "run the Vault setup wizard's admin-token step to stop relying on this fallback.",
    )
    return process.env.VAULT_TOKEN
  }

  throw new Error(
    "Vault admin token not configured — has the Vault setup wizard been completed? " +
    (process.env.VAULT_TOKEN
      ? "A VAULT_TOKEN environment variable is present but VAULT_ALLOW_ENV_TOKEN=1 was not set, so it was not used " +
        '(it is typically a root token and this app refuses to fall back to it silently).'
      : "(No 'vault.adminToken' SystemSetting and no VAULT_TOKEN environment variable.)")
  )
}

// ── Secret writer ─────────────────────────────────────────────────────────────

/**
 * Write key/value pairs to Vault KV v2 at the given path.
 * The path may be "foo/bar" or with the full prefix "secret/data/foo/bar" —
 * either form is normalised before calling the API.
 * Values are NEVER stored in the database.
 */
export async function writeVaultSecret(
  kvPath: string,
  data: Record<string, string>,
): Promise<void> {
  const token = await resolveVaultAdminToken()

  // Normalise: strip "secret/data/" prefix if the caller included it
  const normalised = kvPath.replace(/^secret\/data\//, '')

  const res = await vaultFetch(`${VAULT_ADDR}/v1/secret/data/${normalised}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': token,
    },
    body: JSON.stringify({ data }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { errors?: string[] }
    throw new Error(`Vault responded ${res.status}: ${body.errors?.join(', ') ?? 'unknown error'}`)
  }
}

/**
 * Merge-update a Vault KV v2 secret: set/overwrite the keys in `set`, delete the
 * keys in `remove`, and leave every other existing key untouched.
 *
 * KV v2 writes replace the whole secret, so this reads the current version and
 * writes back with check-and-set (cas) — a concurrent writer causes a retry
 * instead of a lost update. A missing secret is treated as empty (cas=0).
 * Returns the keys present after the update.
 */
export async function updateVaultSecret(
  kvPath: string,
  set: Record<string, string>,
  remove: string[] = [],
  opts: { onlyMissing?: boolean } = {},
): Promise<string[]> {
  const token = await resolveVaultAdminToken()
  const normalised = kvPath.replace(/^secret\/data\//, '')
  const url = `${VAULT_ADDR}/v1/secret/data/${normalised}`

  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await vaultFetch(url, { headers: { 'X-Vault-Token': token } })
    let existing: Record<string, string> = {}
    let version = 0
    if (cur.ok) {
      const body = await cur.json() as { data?: { data?: Record<string, string> | null; metadata?: { version?: number } } }
      existing = body.data?.data ?? {}
      version = body.data?.metadata?.version ?? 0
    } else if (cur.status !== 404) {
      const body = await cur.json().catch(() => ({})) as { errors?: string[] }
      throw new Error(`Vault read responded ${cur.status}: ${body.errors?.join(', ') ?? 'unknown error'}`)
    }

    // onlyMissing: never overwrite a key that already has a value (placeholders)
    const merged: Record<string, string> = opts.onlyMissing ? { ...set, ...existing } : { ...existing, ...set }
    for (const k of remove) delete merged[k]

    const res = await vaultFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Token': token },
      body: JSON.stringify({ options: { cas: version }, data: merged }),
    })
    if (res.ok) return Object.keys(merged)

    const body = await res.json().catch(() => ({})) as { errors?: string[] }
    const msg = body.errors?.join(', ') ?? 'unknown error'
    // cas mismatch → someone wrote in between; re-read and retry
    if (res.status === 400 && /check-and-set/i.test(msg)) continue
    throw new Error(`Vault responded ${res.status}: ${msg}`)
  }
  throw new Error('Vault secret changed concurrently; update aborted after 3 attempts')
}
