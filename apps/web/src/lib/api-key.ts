/**
 * API Key Authentication
 *
 * Admin users can generate API keys via POST /api/api-keys.
 * Keys are used via `x-api-key: orion_ak_xxxxxx...` header.
 * Only admins can create API keys.
 */

import { randomBytes, pbkdf2Sync, timingSafeEqual, createHash } from 'crypto'
import { prisma } from './db'

export type ApiKeyRow = {
  id: string
  hashPrefix: string
  hash: string
  name: string
  active: boolean
  expiresAt: Date | null
  lastUsedAt: Date | null
  createdAt: Date
  userId: string
}

export type ApiKeyInfo = {
  id: string
  hashPrefix: string
  name: string
  active: boolean
  expiresAt: Date | null
  lastUsedAt: Date | null | undefined
  createdAt: Date
}

function mapRow(r: ApiKeyRow): ApiKeyInfo {
  return {
    id: r.id,
    hashPrefix: r.hashPrefix,
    name: r.name,
    active: r.active,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  }
}

// Raw SQL queries for the api_keys table (managed by Prisma schema)
// Column names are camelCase (Prisma default), table name is api_keys (via @@map)
// PostgreSQL lowercases unquoted identifiers, so we use double-quoted mixed-case names
const sql = {
  findByHash: `SELECT "id", "hashPrefix", name, active, "expiresAt", "lastUsedAt", "createdAt" FROM api_keys WHERE "hashPrefix" = $1 AND hash = $2`,
  listByUser: `SELECT "id", "hashPrefix", name, active, "expiresAt", "lastUsedAt", "createdAt" FROM api_keys WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
  verifyByHash: `SELECT "id", "userId", "expiresAt", "lastUsedAt", active FROM api_keys WHERE "hashPrefix" = $1 AND hash = $2`,
  updateLastUsed: (hash: string) => `UPDATE api_keys SET "lastUsedAt" = now() WHERE hash = '${hash.replace(/'/g, "''")}'`,
  deleteByKey: (keyId: string, userId: string) =>
    `DELETE FROM api_keys WHERE id = '${keyId.replace(/'/g, "''")}' AND "userId" = '${userId.replace(/'/g, "''")}'`,
} as const

/**
 * Generate a new API key.
 * Returns the plaintext key (shown once) and metadata.
 */
const API_KEY_KDF_ALGO = 'pbkdf2_sha256'
const API_KEY_KDF_ITERATIONS = 210000
const API_KEY_KDF_KEYLEN = 32
const API_KEY_KDF_DIGEST = 'sha256'

function hashPrefixFromStoredHash(storedHash: string): string {
  return createHash('sha256').update(storedHash).digest('hex').slice(0, 6)
}

function hashApiKey(rawKey: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = pbkdf2Sync(rawKey, salt, API_KEY_KDF_ITERATIONS, API_KEY_KDF_KEYLEN, API_KEY_KDF_DIGEST).toString('hex')
  return `${API_KEY_KDF_ALGO}$${API_KEY_KDF_ITERATIONS}$${salt}$${derived}`
}

function verifyApiKeyHash(rawKey: string, storedHash: string): boolean {
  const parts = storedHash.split('$')
  if (parts.length !== 4) return false
  const [algo, iterStr, salt, expectedHex] = parts
  if (algo !== API_KEY_KDF_ALGO) return false

  const iterations = Number(iterStr)
  if (!Number.isInteger(iterations) || iterations <= 0) return false

  const actual = pbkdf2Sync(rawKey, salt, iterations, API_KEY_KDF_KEYLEN, API_KEY_KDF_DIGEST)
  const expected = Buffer.from(expectedHex, 'hex')
  if (expected.length !== actual.length) return false

  return timingSafeEqual(actual, expected)
}

export async function createApiKey(
  userId: string,
  name: string,
  expiresInDays?: number,
): Promise<{ key: string; info: ApiKeyInfo }> {
  const raw = `orion_ak_${randomBytes(18).toString('hex')}`
  const hash = hashApiKey(raw)
  const prefix = hashPrefixFromStoredHash(hash)
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null

  await prisma.$executeRawUnsafe(
    `INSERT INTO api_keys ("userId", "hashPrefix", hash, name, "expiresAt") VALUES ($1, $2, $3, $4, $5)`,
    userId, prefix, hash, name, expiresAt,
  )

  const rows = await prisma.$queryRawUnsafe<ApiKeyRow[]>(sql.findByHash, prefix, hash)
  return { key: raw, info: mapRow(rows[0]) }
}

/**
 * List all API keys for a user.
 */
export async function listUserKeys(userId: string): Promise<ApiKeyInfo[]> {
  const rows = await prisma.$queryRawUnsafe<ApiKeyRow[]>(sql.listByUser, userId)
  return rows.map(mapRow)
}

/**
 * Verify an API key.
 * Returns the user ID if valid, null otherwise.
 */
export async function verifyApiKey(key: string): Promise<string | null> {
  if (!key.startsWith('orion_ak_')) return null
  if (key.length < 18) return null // minimum length check

  const prefix = hashPrefixFromStoredHash(hashApiKey(key))

  const rows = await prisma.$queryRawUnsafe<ApiKeyRow[]>(sql.verifyByHash, prefix, '')

  if (!rows || rows.length === 0) return null

  const r = rows.find(row => verifyApiKeyHash(key, row.hash))
  if (!r) return null

  // Check active
  if (!r.active) return null

  // Check expiry
  if (r.expiresAt && new Date(r.expiresAt) < new Date()) return null

  // Update lastUsedAt
  await prisma.$executeRawUnsafe(sql.updateLastUsed(r.hash))

  return r.userId
}

/**
 * Revoke an API key (delete it from the database).
 * Only the owning user or an admin can revoke.
 */
export async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
  const count = await prisma.$executeRawUnsafe(sql.deleteByKey(keyId, userId))
  return count > 0
}
