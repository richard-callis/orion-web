/**
 * H2: the executor's x-executor-token may read only 'system.room.execution'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const { prisma, requireServiceAuth } = vi.hoisted(() => ({
  prisma: { systemSetting: { findUnique: vi.fn() } },
  requireServiceAuth: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ prisma }))
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>()
  return { ...actual, requireServiceAuth }
})

import { GET } from './route'

const EXECUTOR_TOKEN = 'executor-token-0123456789'

function get(key: string, headers: Record<string, string> = {}) {
  return GET(
    new NextRequest(`http://x/api/system-settings/${encodeURIComponent(key)}`, { headers }),
    { params: Promise.resolve({ key }) },
  )
}

beforeEach(() => {
  process.env.ORION_EXECUTOR_TOKEN = EXECUTOR_TOKEN
  prisma.systemSetting.findUnique.mockReset().mockImplementation(async ({ where }) => ({ key: where.key, value: `v:${where.key}` }))
  requireServiceAuth.mockReset().mockResolvedValue(null)
})
afterEach(() => { delete process.env.ORION_EXECUTOR_TOKEN })

describe('GET /api/system-settings/[key] — executor token', () => {
  it('reads system.room.execution', async () => {
    const res = await get('system.room.execution', { 'x-executor-token': EXECUTOR_TOKEN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ key: 'system.room.execution', value: 'v:system.room.execution' })
  })

  it.each(['system.room.security', 'vault.rootToken', 'git.provider.config'])('refuses %s', async (key) => {
    const res = await get(key, { 'x-executor-token': EXECUTOR_TOKEN })
    expect(res.status).toBe(401)
    expect(prisma.systemSetting.findUnique).not.toHaveBeenCalled()
  })
})
