/**
 * getSessionToken always passes the configured secret AND cookie name, so every
 * route resolves the same session cookie the proxy does.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn(async () => ({ sub: 'u1' })) }))
vi.mock('next-auth/jwt', () => ({ getToken }))

import { getSessionToken } from './session-token'
import { SESSION_COOKIE_NAME } from './auth-constants'

describe('getSessionToken', () => {
  it('passes secret and the app session cookie name', async () => {
    process.env.NEXTAUTH_SECRET = 'test-secret'
    const req = new NextRequest('http://localhost/api/chat/conversations')
    await expect(getSessionToken(req)).resolves.toEqual({ sub: 'u1' })
    expect(getToken).toHaveBeenCalledWith({ req, secret: 'test-secret', cookieName: SESSION_COOKIE_NAME })
  })
})
