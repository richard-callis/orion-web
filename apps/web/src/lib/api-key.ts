/**
 * API Key Authentication
 *
 * Admin users can generate API keys via POST /api/api-keys.
 * Keys are used via `x-api-key: orion_ak_xxxxxx...` header.
 * Only admins can create API keys.
 */

import { randomBytes, createHash } from 'crypto'
import { compare, hash } from 'bcryptjs'

// Deterministic prefix for DB lookup — a SHA-256 hash of the first 8 bytes
// of the raw key's random portion, truncated to 16 hex chars.
// This avoids storing raw key material in the hashPrefix column while still
// enabling deterministic indexed lookup. The bcrypt hash in the `hash` column
// remains the actual security mechanism for verification.
function deterministicPrefix(raw: string): string {
  // Skip the 'orion_ak_' prefix (9 chars) and take the first 8 chars as the key prefix
  const rawPrefix = raw.slice(9, 17)
  return createHash('sha256').update(rawPrefix).digest('hex').slice(0, 16)
}
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
// SOC2: [M-001] findByHash, listByUser, verifyByHash use parameterized queries ($1, $2)
// updateLastUsed and deleteByKey use Prisma ORM instead of raw SQL to prevent SQL injection
const sql = {
  findByHash: `SELECT "id", "hashPrefix", name, active, "expiresAt", "lastUsedAt", "createdAt" FROM api_keys WHERE "hashPrefix" = $1 AND hash = $2`,
  // Lookup by SHA-256 prefix only (hash column still used for bcrypt verification below)
  findByPrefix: `SELECT "id", "userId", "hashPrefix", hash, name, active, "expiresAt", "lastUsedAt", "createdAt" FROM api_keys WHERE "hashPrefix" = $1`,
  listByUser: `SELECT "id", "hashPrefix", name, active, "expiresAt", "lastUsedAt", "createdAt" FROM api_keys WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
  verifyByHash: `SELECT "id", "userId", "expiresAt", "lastUsedAt", active FROM api_keys WHERE "hashPrefix" = $1 AND hash = $2`,
} as const

/**
 * Generate a new API key.
 * Returns the plaintext key (shown once) and metadata.
 */
export async function createApiKey(
  userId: string,
  name: string,
  expiresInDays?: number,
): Promise<{ key: string; info: ApiKeyInfo }> {
  const raw = `orion_ak_${randomBytes(18).toString('hex')}`
  // Use SHA-256 of the raw key for the lookup prefix (deterministic).
  // bcrypt generates a new random salt per call — using it as a lookup key
  // would mean verification always misses (the re-computed hash never matches).
  const prefix = deterministicPrefix(raw)
  // bcryptjs with cost factor 14 (exceeds CodeQL minimum of cost 12)
  const hashValue = await hash(raw, 14)
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400000) : null

  await prisma.$executeRawUnsafe(
    `INSERT INTO api_keys ("userId", "hashPrefix", hash, name, "expiresAt") VALUES ($1, $2, $3, $4, $5)`,
    userId, prefix, hashValue, name, expiresAt,
  )

  const rows = await prisma.$queryRawUnsafe(sql.findByHash, prefix, hashValue) as ApiKeyRow[]
  return { key: raw, info: mapRow(rows[0]) }
}

/**
 * List all API keys for a user.
 */
export async function listUserKeys(userId: string): Promise<ApiKeyInfo[]> {
  const rows = await prisma.$queryRawUnsafe(sql.listByUser, userId) as ApiKeyRow[]
  return rows.map(mapRow)
}

/**
 * Verify an API key.
 * Returns the user ID if valid, null otherwise.
 */
export async function verifyApiKey(key: string): Promise<string | null> {
  if (!key.startsWith('orion_ak_')) return null
  if (key.length < 18) return null // minimum length check

  // Deterministic prefix for lookup — SHA-256 (not bcrypt which is non-deterministic)
  const prefix = deterministicPrefix(key)
  // Look up by SHA-256 prefix; bcrypt compare below does the actual verification
  const rows = await prisma.$queryRawUnsafe(sql.findByPrefix, prefix) as ApiKeyRow[]

  if (!rows || rows.length === 0) return null

  const r = rows[0]

  // Check active
  if (!r.active) return null

  // Check expiry
  if (r.expiresAt && new Date(r.expiresAt) < new Date()) return null

  // Verify the key matches the stored hash
  const match = await compare(key, r.hash)
  if (!match) return null

  // Update lastUsedAt (SOC2: [M-001] use Prisma ORM — not raw SQL)
  await prisma.apiKey.updateMany({ where: { hash: r.hash, userId: r.userId }, data: { lastUsedAt: new Date() } })

  return r.userId
}

/**
 * Revoke an API key (delete it from the database).
 * Only the owning user or an admin can revoke.
 */
export async function revokeApiKey(keyId: string, userId: string): Promise<boolean> {
  // SOC2: [M-001] use Prisma ORM — not raw SQL (prevents SQL injection)
  const result = await prisma.apiKey.deleteMany({ where: { id: keyId, userId } })
  return result.count > 0
}
