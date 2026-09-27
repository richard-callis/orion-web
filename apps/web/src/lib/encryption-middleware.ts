/**
 * Prisma client extension — encrypts on write and decrypts on read the
 * Environment and ExternalModel secret fields. (Was a `$use` middleware; Prisma 7
 * removed `$use`, so it is now a `query` extension with the same semantics.)
 *
 * Transparent: every DB read of an encrypted field returns plaintext.
 * No call site needs to change. No call site can forget to decrypt.
 *
 * Safe degradation: if decrypt() throws, the field becomes null.
 * Auth comparisons fail safely (401). LLM calls fail with a clear error.
 */

import { Prisma } from '@prisma/client'
import { decrypt, encrypt } from './encryption'

// federationToken was encrypted by the environment routes but never decrypted
// on read, so the hub sent ciphertext to spokes and token lookups never matched.
const ENCRYPTED_ENV_FIELDS = ['gatewayToken', 'kubeconfig', 'federationToken']
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

/** Encrypt the write payloads (data / create / update / connectOrCreate.create) of one operation's args. */
function encryptArgs(args: unknown, model: string, operation: string): unknown {
  // Encrypt before writes (POST = create, PUT/PATCH = update)
  const isWrite = ['create', 'connectOrCreate', 'upsert', 'update', 'updateMany'].includes(operation)
  if (!isWrite || !isRecord(args)) return args
  let newArgs: Record<string, unknown> = { ...args }

  // Handle standard data field (create, update, updateMany)
  if (isRecord(newArgs.data)) {
    const processed = preProcess(newArgs.data, model)
    if (processed !== newArgs.data) newArgs = { ...newArgs, data: processed }
  }

  // Handle upsert's create and update fields
  if (isRecord(newArgs.create)) {
    const processed = preProcess(newArgs.create, model)
    if (processed !== newArgs.create) newArgs = { ...newArgs, create: processed }
  }
  if (isRecord(newArgs.update)) {
    const processed = preProcess(newArgs.update, model)
    if (processed !== newArgs.update) newArgs = { ...newArgs, update: processed }
  }

  // Handle connectOrCreate's create field
  if (isRecord(newArgs.connectOrCreate) && isRecord(newArgs.connectOrCreate.create)) {
    const processed = preProcess(newArgs.connectOrCreate.create, model)
    if (processed !== newArgs.connectOrCreate.create) {
      newArgs = { ...newArgs, connectOrCreate: { ...newArgs.connectOrCreate, create: processed } }
    }
  }

  return newArgs
}

type Operation = { model: string; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }

async function encryptThenDecrypt({ model, operation, args, query }: Operation): Promise<unknown> {
  const result = await query(encryptArgs(args, model, operation))
  return processResult(result, model)
}

/**
 * Encrypt-on-write / decrypt-on-read for Environment and ExternalModel.
 * Apply with `client.$extends(encryptionExtension)`. Like the old `$use`
 * middleware it covers top-level operations on those two models only.
 */
export const encryptionExtension = Prisma.defineExtension({
  name: 'orion-encryption',
  query: {
    environment: {
      $allOperations: (p) => encryptThenDecrypt(p as unknown as Operation) as ReturnType<typeof p.query>,
    },
    externalModel: {
      $allOperations: (p) => encryptThenDecrypt(p as unknown as Operation) as ReturnType<typeof p.query>,
    },
  },
})

// Exported for unit tests.
export const __test = { encryptArgs, processResult }
