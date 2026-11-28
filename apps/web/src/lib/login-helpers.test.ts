import { describe, it, expect } from 'vitest'
import { safeCallbackPath, loginErrorMessage } from './login-helpers'

describe('safeCallbackPath', () => {
  it.each(['//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', 'https://evil.example', 'evil', '', '/a\\b'])(
    'rejects %j', (u) => expect(safeCallbackPath(u)).toBe('/'))
  it.each(['/', '/dashboard', '/a/b?x=1#h', '/%09/evil'])('accepts %j', (u) => expect(safeCallbackPath(u)).toBe(u))
  it('falls back for null/undefined', () => {
    expect(safeCallbackPath(null)).toBe('/')
    expect(safeCallbackPath(undefined)).toBe('/')
  })
})

describe('loginErrorMessage', () => {
  it('maps known codes and never echoes unknown ones', () => {
    expect(loginErrorMessage(null)).toBe('')
    expect(loginErrorMessage('AccessDenied')).toMatch(/not allowed/)
    expect(loginErrorMessage('AuthentikDisabled')).toMatch(/disabled/)
    for (const c of ['OAuthSignin', 'OAuthCallback', 'Callback']) expect(loginErrorMessage(c)).toMatch(/Authentik failed/)
    const m = loginErrorMessage('<script>boom</script>')
    expect(m).not.toContain('boom')
    expect(m).toMatch(/Sign-in failed/)
  })
})
