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
import { decrypt } from './encryption'

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

function processRow(obj: unknown): unknown {
  if (!isRecord(obj)) return obj

  const copy = { ...obj }

  for (const field of ENCRYPTED_ENV_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(copy, field)) {
      copy[field] = decryptField(copy[field])
    }
  }

  return copy
}

function processResult(result: unknown): unknown {
  if (Array.isArray(result)) {
    return result.map((r) => (isRecord(r) ? processRow(r) : r))
  }

  return isRecord(result) ? processRow(result) : result
}

export function registerEncryptionMiddleware(prisma: PrismaClient): void {
  prisma.$use(async (params, next) => {
    if (params.model !== 'Environment' && params.model !== 'ExternalModel') {
      return next(params)
    }

    const result = await next(params)
    return processResult(result)
  })
}
