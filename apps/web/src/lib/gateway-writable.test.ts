import { describe, it, expect, vi, beforeEach } from 'vitest'
import { gatewayCanWrite } from './gateway-writable'

const fetchMock = vi.fn()
const gateway = (tools: unknown, { probe = 200, list = 200 } = {}) => fetchMock.mockImplementation(async (url: string) =>
  url.endsWith('/tools/execute') ? new Response('{}', { status: probe }) : new Response(JSON.stringify(tools), { status: list }))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock.mockReset())
  return () => vi.unstubAllGlobals()
})

describe('gatewayCanWrite', () => {
  it('a writable gateway', async () => {
    gateway([{ name: 'kubectl_get' }, { name: 'kubectl_apply_manifest' }])
    expect(await gatewayCanWrite('http://gw', 't', 'cluster')).toBe(true)
  })
  it('not a read-only one, which still answers reads', async () => {
    gateway([{ name: 'kubectl_get' }, { name: 'kubectl_get_nodes' }])
    expect(await gatewayCanWrite('http://gw', 't', 'cluster')).toBe(false)
  })
  it('not one that fails, errors or answers nonsense', async () => {
    gateway([], { probe: 503 })
    expect(await gatewayCanWrite('http://gw', 't', 'cluster')).toBe(false)
    gateway([], { list: 500 })
    expect(await gatewayCanWrite('http://gw', 't', 'cluster')).toBe(false)
    gateway({ tools: 'x' })
    expect(await gatewayCanWrite('http://gw', 't', 'cluster')).toBe(false)
    fetchMock.mockRejectedValue(new Error('unreachable'))
    expect(await gatewayCanWrite('http://gw', 't', 'cluster')).toBe(false)
  })
  it('a Docker gateway needs only to answer, as before', async () => {
    gateway([])
    expect(await gatewayCanWrite('http://gw', 't', 'docker')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
