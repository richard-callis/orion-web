/**
 * encryptionExtension (Prisma 7 replacement for the removed `$use` middleware):
 * encrypts secret fields on write and decrypts them on read, only for
 * Environment and ExternalModel.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'

beforeAll(() => {
  process.env.ORION_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

import { __test } from './encryption-middleware'
import { encrypt } from './encryption'

const { encryptArgs, processResult } = __test

describe('encryptionExtension helpers', () => {
  it('encrypts Environment secrets on create/update/upsert/connectOrCreate', () => {
    const data = { name: 'prod', gatewayToken: 'tok', kubeconfig: 'kc', federationToken: 'ft' }
    const created = encryptArgs({ data }, 'Environment', 'create') as { data: Record<string, string> }
    expect(created.data.name).toBe('prod')
    for (const f of ['gatewayToken', 'kubeconfig', 'federationToken']) expect(created.data[f]).toMatch(/^enc:v1:/)

    const upserted = encryptArgs({ where: { id: 'e1' }, create: { gatewayToken: 'a' }, update: { gatewayToken: 'b' } }, 'Environment', 'upsert') as Record<string, Record<string, string>>
    expect(upserted.create.gatewayToken).toMatch(/^enc:v1:/)
    expect(upserted.update.gatewayToken).toMatch(/^enc:v1:/)

    const coc = encryptArgs({ connectOrCreate: { where: { id: 'e1' }, create: { kubeconfig: 'x' } } }, 'Environment', 'connectOrCreate') as { connectOrCreate: { create: Record<string, string> } }
    expect(coc.connectOrCreate.create.kubeconfig).toMatch(/^enc:v1:/)
  })

  it('does not double-encrypt values that are already encrypted', () => {
    const already = encrypt('secret')
    const out = encryptArgs({ data: { gatewayToken: already } }, 'Environment', 'update') as { data: Record<string, string> }
    expect(out.data.gatewayToken).toBe(already)
  })

  it('encrypts ExternalModel.apiKey and leaves reads/deletes untouched', () => {
    const out = encryptArgs({ data: { apiKey: 'sk-123' } }, 'ExternalModel', 'create') as { data: Record<string, string> }
    expect(out.data.apiKey).toMatch(/^enc:v1:/)
    const args = { where: { id: 'm1' } }
    expect(encryptArgs(args, 'ExternalModel', 'findUnique')).toBe(args)
    expect(encryptArgs(args, 'Environment', 'delete')).toBe(args)
  })

  it('decrypts results (single row and lists); corrupt values become null', () => {
    const row = { id: 'e1', gatewayToken: encrypt('tok'), kubeconfig: 'enc:v1:not-valid-base64!!', name: 'prod' }
    expect(processResult(row, 'Environment')).toEqual({ id: 'e1', gatewayToken: 'tok', kubeconfig: null, name: 'prod' })
    expect(processResult([{ apiKey: encrypt('sk') }], 'ExternalModel')).toEqual([{ apiKey: 'sk' }])
    expect(processResult(null, 'Environment')).toBeNull()
    expect(processResult(3, 'Environment')).toBe(3)
  })
})
