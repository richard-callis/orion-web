import { describe, it, expect, afterEach } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import { isAllowedIp, assertSafeUrlShape, guardedLookup, safeFetch, SsrfBlockedError } from './ssrf'

describe('isAllowedIp', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
  ])('blocks private/reserved IPv4 %s', ip => {
    expect(isAllowedIp(ip)).toBe(false)
  })

  it.each([
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    // IPv4-mapped IPv6 — the original bypass: hex and dotted forms of loopback/metadata
    '::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '::ffff:169.254.169.254',
    '[::ffff:7f00:1]', '0:0:0:0:0:ffff:7f00:1',
    // deprecated IPv4-compatible, NAT64 and 6to4 wrappers around private IPv4
    '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:c0a8:101::1',
  ])('blocks private/reserved/wrapped IPv6 %s', ip => {
    expect(isAllowedIp(ip)).toBe(false)
  })

  it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:1.1.1.1', '64:ff9b::101:101'])(
    'allows public address %s', ip => {
      expect(isAllowedIp(ip)).toBe(true)
    },
  )

  it('rejects garbage', () => {
    expect(isAllowedIp('not-an-ip')).toBe(false)
    expect(isAllowedIp('1.2.3')).toBe(false)
  })
})

describe('assertSafeUrlShape', () => {
  it.each([
    'http://127.0.0.1/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/latest/meta-data',
    'http://2130706433/',          // decimal 127.0.0.1 (WHATWG URL normalises it)
    'http://0x7f.0.0.1/',          // hex octet
    'http://0177.0.0.1/',          // octal octet
    'http://localhost:8080/',
    'http://foo.localhost/',
    'file:///etc/passwd',
    'gopher://example.com/',
    'http://user:pass@example.com/',
  ])('rejects %s', url => {
    expect(() => assertSafeUrlShape(url)).toThrow(SsrfBlockedError)
  })

  it('accepts a normal public URL', () => {
    expect(assertSafeUrlShape('https://example.com/manifest.yaml').hostname).toBe('example.com')
  })
})

describe('guardedLookup', () => {
  it('rejects a hostname that resolves to loopback', async () => {
    const err = await new Promise<Error | null>(resolve => {
      guardedLookup('localhost', { all: false } as never, ((e: Error | null) => resolve(e)) as never)
    })
    expect(err).toBeInstanceOf(SsrfBlockedError)
  })
})

describe('safeFetch', () => {
  let server: http.Server | undefined
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())))

  /** Start a local server and a lookup that maps `public.test` to it (test-only). */
  async function localOrigin(handler: http.RequestListener) {
    server = http.createServer(handler)
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const lookup = ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
      opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)) as never
    return { base: `http://public.test:${port}`, lookup }
  }

  it('blocks literal private IPs before connecting', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow(SsrfBlockedError)
    await expect(safeFetch('http://[::ffff:a9fe:a9fe]/')).rejects.toThrow(SsrfBlockedError)
  })

  it('blocks hostnames that resolve to private addresses', async () => {
    await expect(safeFetch('http://localhost./')).rejects.toThrow()
  })

  it('re-validates redirect targets (public URL → 302 → metadata IP is blocked)', async () => {
    const { base, lookup } = await localOrigin((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' })
      res.end()
    })
    await expect(safeFetch(`${base}/start`, { lookup })).rejects.toThrow(/private\/reserved/)
  })

  it('blocks redirects to IPv4-mapped IPv6 loopback', async () => {
    const { base, lookup } = await localOrigin((_req, res) => {
      res.writeHead(307, { Location: 'http://[::ffff:7f00:1]:22/' })
      res.end()
    })
    await expect(safeFetch(`${base}/start`, { lookup })).rejects.toThrow(SsrfBlockedError)
  })

  it('caps the response body (truncate mode)', async () => {
    const { base, lookup } = await localOrigin((_req, res) => { res.end('x'.repeat(5000)) })
    const res = await safeFetch(`${base}/big`, { lookup, maxBytes: 100 })
    expect(res.truncated).toBe(true)
    expect(res.body.startsWith('x'.repeat(100))).toBe(true)
    expect(res.body).toContain('[truncated')
  })

  it('caps the response body (error mode)', async () => {
    const { base, lookup } = await localOrigin((_req, res) => { res.end('x'.repeat(5000)) })
    await expect(safeFetch(`${base}/big`, { lookup, maxBytes: 100, onOverflow: 'error' })).rejects.toThrow(/exceeds 100 bytes/)
  })

  it('times out slow responses', async () => {
    const { base, lookup } = await localOrigin(() => { /* never respond */ })
    await expect(safeFetch(`${base}/slow`, { lookup, timeoutMs: 200 })).rejects.toThrow()
  })

  it('returns the body for a normal response', async () => {
    const { base, lookup } = await localOrigin((_req, res) => { res.end('hello') })
    const res = await safeFetch(`${base}/ok`, { lookup })
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello')
  })
})
