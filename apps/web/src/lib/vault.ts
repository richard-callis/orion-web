/**
 * Shared Vault KV v2 write helper.
 * Used by both the secrets API routes and the agent tool executor.
 */

import { prisma } from './db'
import { decrypt } from './encryption'

const VAULT_ADDR = process.env.VAULT_ADDR ?? 'http://vault:8200'

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
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'vault.adminToken' } })
  if (!setting?.value) throw new Error('Vault admin token not configured — has the Vault setup wizard been completed?')
  const token = decrypt(String(setting.value))

  // Normalise: strip "secret/data/" prefix if the caller included it
  const normalised = kvPath.replace(/^secret\/data\//, '')

  const res = await fetch(`${VAULT_ADDR}/v1/secret/data/${normalised}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': token,
    },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { errors?: string[] }
    throw new Error(`Vault responded ${res.status}: ${body.errors?.join(', ') ?? 'unknown error'}`)
  }
}
