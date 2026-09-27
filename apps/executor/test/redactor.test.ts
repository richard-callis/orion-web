import { describe, it, expect } from 'vitest'
import { Redactor } from '../src/redactor.js'

const r = new Redactor()
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
const HEX64 = 'a3f1c9e0b7d24f5a8c6e1b0d9f2a4c7e5b8d0f1a2c3e4b5d6f7a8b9c0d1e2f3a'

describe('redactor.redactOutput', () => {
  it('masks KEY=value for secret-looking names', () => {
    expect(r.redactOutput('ORION_GATEWAY_TOKEN=abc123def')).toBe('ORION_GATEWAY_TOKEN=[REDACTED]')
    expect(r.redactOutput('DB_PASSWORD=hunter2 other=1')).toBe('DB_PASSWORD=[REDACTED] other=1')
    expect(r.redactOutput('"api_key": "xyz"')).toContain('[REDACTED]')
  })

  it('masks bare JWTs', () => {
    expect(r.redactOutput(`token is ${JWT} ok`)).toBe('token is [REDACTED] ok')
  })

  it('masks bare long hex secrets but keeps git SHAs and digests readable', () => {
    expect(r.redactOutput(`=${HEX64}`)).toBe('=[REDACTED]')
    const sha = 'e83c5163316f89bfbde7d9ab23ca2e25604af290'
    expect(r.redactOutput(`commit ${sha}`)).toBe(`commit ${sha}`)
    expect(r.redactOutput(`sha256:${HEX64}`)).toBe(`sha256:${HEX64}`)
  })

  it('masks bare base64 tokens with mixed case and digits', () => {
    const tok = 'Zk9vQmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O'
    expect(r.redactOutput(`value ${tok}`)).toBe('value [REDACTED]')
  })

  it('leaves ordinary output alone', () => {
    const text = 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 50G 20G 30G 40% /\nAuthor: someone\nmonkey: 1'
    expect(r.redactOutput(text)).toBe(text)
    const logPath = '/var/log/containers/orion-web-6d8f7c9b5-abcde_default_web.log'
    expect(r.redactOutput(logPath)).toBe(logPath)
  })

  it('masks bearer headers, URL credentials, known token formats and PEM keys', () => {
    expect(r.redactOutput('Authorization: Bearer abcdefghijklmnop')).toContain('Bearer [REDACTED]')
    expect(r.redactOutput('postgres://orion:s3cret@db:5432/orion')).toBe('postgres://orion:[REDACTED]@db:5432/orion')
    expect(r.redactOutput('ghp_0123456789abcdefghijABCDEFGHIJ')).toBe('[REDACTED]')
    expect(r.redactOutput('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]')
    expect(r.redactOutput('hvs.CAESIJ0123456789abcdefghijklmnop')).toBe('[REDACTED]')
    expect(r.redactOutput('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED]')
  })
})

describe('redactor.redactArgs', () => {
  it('masks values of secret-named keys and secrets inside strings', () => {
    const out = r.redactArgs({
      command: `curl -H "Authorization: Bearer ${JWT}" http://x`,
      password: 'hunter2',
      nested: { apiKey: 'x', list: [JWT], count: 3 },
    })
    const nested = out.nested as { apiKey: string; list: string[]; count: number }
    expect(out.password).toBe('[REDACTED]')
    expect(String(out.command)).not.toContain(JWT)
    expect(nested.apiKey).toBe('[REDACTED]')
    expect(nested.list[0]).toBe('[REDACTED]')
    expect(nested.count).toBe(3)
  })

  it('does not treat ordinary keys as secrets', () => {
    expect(r.redactArgs({ command: 'ls -la', path: '/var/log' })).toEqual({ command: 'ls -la', path: '/var/log' })
  })
})
