import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({ systemSetting: { findUnique: vi.fn() } }))
vi.mock('./db', () => ({ prisma: db }))

import { resolveModel, clearModelRoleCache, DEFAULT_ROLE_MODELS } from './model-roles'

beforeEach(() => {
  vi.clearAllMocks()
  clearModelRoleCache()
})

describe('resolveModel', () => {
  it('falls back to the built-in default when no setting exists', async () => {
    db.systemSetting.findUnique.mockResolvedValue(null)
    expect(await resolveModel('reviewer')).toBe(DEFAULT_ROLE_MODELS.reviewer)
    expect(db.systemSetting.findUnique).toHaveBeenCalledWith({ where: { key: 'model.role.reviewer' } })
  })

  it('uses the SystemSetting override and strips a claude: prefix', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ value: 'claude:claude-opus-5-5' })
    expect(await resolveModel('room')).toBe('claude-opus-5-5')
  })

  it('caches per role', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ value: 'claude-sonnet-5' })
    await resolveModel('chat')
    await resolveModel('chat')
    expect(db.systemSetting.findUnique).toHaveBeenCalledOnce()
  })

  it('falls back to the default when the DB is unavailable', async () => {
    db.systemSetting.findUnique.mockRejectedValue(new Error('db down'))
    expect(await resolveModel('chat')).toBe(DEFAULT_ROLE_MODELS.chat)
  })

  it('ignores blank or non-string values', async () => {
    db.systemSetting.findUnique.mockResolvedValue({ value: '   ' })
    expect(await resolveModel('planner')).toBe(DEFAULT_ROLE_MODELS.planner)
  })
})
