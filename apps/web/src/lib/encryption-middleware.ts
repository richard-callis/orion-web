/**
 * Prisma $use middleware — auto-decrypts Environment and ExternalModel secrets.
 *
 * Transparent: every DB read of an encrypted field returns plaintext.
 * No call site needs to change. No call site can forget to decrypt.
 *
 * Safe degradation: if decrypt() throws, the field becomes null.
 * Auth comparisons fail safely (401). LLM calls fail with a clear error.
 */

import { PrismaClient } from '@prisma/client'
import { decrypt, encrypt } from './encryption'

const ENCRYPTED_ENV_FIELDS = ['gatewayToken', 'kubeconfig']
const ENCRYPTED_EXT_FIELDS = ['apiKey']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function decryptField(raw: unknown): unknown {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return decrypt(raw)
  } catch {
    // Corrupted or incompatible data — fail safe
    return null
  }
}

function processRow(obj: unknown, model?: string): unknown {
  if (!isRecord(obj)) return obj

  const copy = { ...obj }

  // Decrypt Environment fields
  for (const field of ENCRYPTED_ENV_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(copy, field)) {
      copy[field] = decryptField(copy[field])
    }
  }

  // Decrypt ExternalModel fields
  if (model === 'ExternalModel') {
    for (const field of ENCRYPTED_EXT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(copy, field)) {
        copy[field] = decryptField(copy[field])
      }
    }
  }

  return copy
}

function processResult(result: unknown, model?: string): unknown {
  if (Array.isArray(result)) {
    return result.map((r: any) => (isRecord(r) ? processRow(r, model) : r))
  }

  return isRecord(result) ? processRow(result, model) : result
}

/**
 * Encrypt sensitive fields BEFORE write operations (SOC2: [C-003]).
 * Only encrypts fields that are still plaintext (not already starting with 'enc:v1:').
 * This is idempotent — encrypting an already-encrypted value is safe (decrypt passes it through).
 */
function preProcess(obj: unknown, model?: string): unknown {
  if (!isRecord(obj)) return obj

  const copy = { ...obj }
  let changed = false

  // Encrypt Environment fields on write
  if (model === 'Environment') {
    for (const field of ENCRYPTED_ENV_FIELDS) {
      const raw = copy[field]
      if (typeof raw === 'string' && !raw.startsWith('enc:v1:')) {
        copy[field] = encrypt(raw)
        changed = true
      }
    }
  }

  // Encrypt ExternalModel fields on write
  if (model === 'ExternalModel') {
    for (const field of ENCRYPTED_EXT_FIELDS) {
      const raw = copy[field]
      if (typeof raw === 'string' && !raw.startsWith('enc:v1:')) {
        copy[field] = encrypt(raw)
        changed = true
      }
    }
  }

  return changed ? copy : obj
}

export function registerEncryptionMiddleware(prisma: PrismaClient): void {
  prisma.$use(async (params, next) => {
    if (params.model !== 'Environment' && params.model !== 'ExternalModel') {
      return next(params)
    }

    // Encrypt before writes (POST = create, PUT/PATCH = update)
    const isWrite = ['create', 'connectOrCreate', 'upsert', 'update', 'updateMany'].includes(params.action)
    if (isWrite && params.args) {
      let newArgs = { ...params.args }

      // Handle standard data field (create, update, updateMany)
      if (newArgs.data && isRecord(newArgs.data)) {
        const processed = preProcess(newArgs.data, params.model)
        if (processed !== newArgs.data) {
          newArgs = { ...newArgs, data: processed }
        }
      }

      // Handle upsert's create and update fields
      if (newArgs.create && isRecord(newArgs.create)) {
        const processed = preProcess(newArgs.create, params.model)
        if (processed !== newArgs.create) {
          newArgs = { ...newArgs, create: processed }
        }
      }
      if (newArgs.update && isRecord(newArgs.update)) {
        const processed = preProcess(newArgs.update, params.model)
        if (processed !== newArgs.update) {
          newArgs = { ...newArgs, update: processed }
        }
      }

      // Handle connectOrCreate's create field
      if (newArgs.connectOrCreate && isRecord(newArgs.connectOrCreate) && isRecord(newArgs.connectOrCreate.create)) {
        const processed = preProcess(newArgs.connectOrCreate.create as Record<string, unknown>, params.model)
        if (processed !== newArgs.connectOrCreate.create) {
          newArgs = { ...newArgs, connectOrCreate: { ...newArgs.connectOrCreate, create: processed } }
        }
      }

      if (newArgs !== params.args) {
        params = { ...params, args: newArgs }
      }
    }

    const result = await next(params)
    return processResult(result, params.model)
  })
}
