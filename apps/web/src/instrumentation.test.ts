import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateSecurityEnv } from './instrumentation'

const good = {
  NEXTAUTH_SECRET: 'a-real-secret',
  ORION_ENCRYPTION_KEY: 'a-real-key',
  MINIO_ROOT_PASSWORD: 'x', REDIS_PASSWORD: 'x', POSTGRES_PASSWORD: 'x',
} as unknown as NodeJS.ProcessEnv

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('validateSecurityEnv', () => {
  it('passes with real secrets', () => {
    expect(() => validateSecurityEnv({ ...good, NODE_ENV: 'production' })).not.toThrow()
  })

  it('refuses to start in production when a required secret is missing', () => {
    const env = { ...good, NODE_ENV: 'production' } as NodeJS.ProcessEnv
    delete env.ORION_ENCRYPTION_KEY
    expect(() => validateSecurityEnv(env)).toThrow(/ORION_ENCRYPTION_KEY/)
  })

  it('only logs a missing secret outside production', () => {
    const env = { ...good, NODE_ENV: 'development' } as NodeJS.ProcessEnv
    delete env.NEXTAUTH_SECRET
    expect(() => validateSecurityEnv(env)).not.toThrow()
    expect(console.error).toHaveBeenCalled()
  })

  it('rejects placeholder secrets without echoing the value', () => {
    const env = { ...good, NODE_ENV: 'development', NEXTAUTH_SECRET: 'change-me-please' } as NodeJS.ProcessEnv
    expect(() => validateSecurityEnv(env)).toThrow(/NEXTAUTH_SECRET/)
    try { validateSecurityEnv(env) } catch (e) {
      expect((e as Error).message).not.toContain('change-me-please')
    }
  })
})
