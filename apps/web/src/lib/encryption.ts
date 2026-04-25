/**
 * AES-256-GCM encryption for sensitive SystemSetting values.
 *
 * Key: ORION_ENCRYPTION_KEY env var — 32 bytes, base64-encoded.
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Stored format: enc:v1:<base64(12-byte IV + 16-byte auth tag + ciphertext)>
 * Plaintext values (no prefix) are returned as-is — transparent backward compat.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES   = 12   // 96-bit IV — GCM standard
const TAG_BYTES  = 16
const PREFIX     = 'enc:v1:'

function getKey(): Buffer {
  const raw = process.env.ORION_ENCRYPTION_KEY
  if (!raw) throw new Error('ORION_ENCRYPTION_KEY is not set — cannot encrypt/decrypt settings')
  const key = Buffer.from(raw, 'base64')
  if (key.byteLength !== 32) throw new Error(`ORION_ENCRYPTION_KEY must be 32 bytes (got ${key.byteLength})`)
  return key
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv  = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag  = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, body]).toString('base64')
}

export function decrypt(value: string): string {
  if (!value.startsWith(PREFIX)) return value   // plaintext passthrough (legacy values)
  const key    = getKey()
  const packed = Buffer.from(value.slice(PREFIX.length), 'base64')
  const iv         = packed.subarray(0, IV_BYTES)
  const tag        = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8')
}

/** Encrypt a JSON-serialisable value. Returns an encrypted string. */
export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value))
}

/** Decrypt a value that was encrypted with encryptJson, or return the raw object for legacy plaintext. */
export function decryptJson<T>(value: unknown): T {
  if (typeof value === 'string' && value.startsWith(PREFIX)) {
    return JSON.parse(decrypt(value)) as T
  }
  return value as T   // legacy: value is already the parsed object
}

/**
 * Encrypt with a custom key (for key rotation).
 * keyBase64: 32-byte key in base64 format
 */
export function encryptWithKey(plaintext: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.byteLength !== 32) throw new Error(`Key must be 32 bytes (got ${key.byteLength})`)
  const iv  = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag  = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, body]).toString('base64')
}

/**
 * Decrypt with a custom key (for key rotation).
 * keyBase64: 32-byte key in base64 format
 */
export function decryptWithKey(value: string, keyBase64: string): string {
  if (!value.startsWith(PREFIX)) return value   // plaintext passthrough
  const key = Buffer.from(keyBase64, 'base64')
  if (key.byteLength !== 32) throw new Error(`Key must be 32 bytes (got ${key.byteLength})`)
  const packed = Buffer.from(value.slice(PREFIX.length), 'base64')
  const iv         = packed.subarray(0, IV_BYTES)
  const tag        = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8')
}
