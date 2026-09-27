/**
 * dns.ts against the client-node >= 1.0 API: object parameters, bodies returned
 * directly, ApiException.code for errors (the 409 retry never matched before).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApiException } from '@kubernetes/client-node'

const { coreApi } = vi.hoisted(() => ({
  coreApi: {
    readNamespacedConfigMap: vi.fn(),
    patchNamespacedConfigMap: vi.fn(),
    createNamespacedConfigMap: vi.fn(),
  },
}))
vi.mock('./k8s', () => ({ coreApi }))

import { upsertNodeHost, getCustomRecords, upsertCustomRecord } from './dns'

const cm = (data: Record<string, string>, rv = '1') => ({ metadata: { resourceVersion: rv }, data })
const conflict = () => new ApiException(409, 'Conflict', {}, {})
const notFound = () => new ApiException(404, 'Not Found', {}, {})

beforeEach(() => {
  for (const f of Object.values(coreApi)) f.mockReset()
})

describe('dns.ts (client-node >= 1.0 API)', () => {
  it('reads with object params and merge-patches with resourceVersion', async () => {
    coreApi.readNamespacedConfigMap.mockResolvedValue(cm({ NodeHosts: '10.0.0.1 a.local\n' }, '42'))
    coreApi.patchNamespacedConfigMap.mockResolvedValue({})

    await upsertNodeHost('10.0.0.2', ['b.local'])

    expect(coreApi.readNamespacedConfigMap).toHaveBeenCalledWith({ name: 'coredns', namespace: 'kube-system' })
    const [param, options] = coreApi.patchNamespacedConfigMap.mock.calls[0]
    expect(param.name).toBe('coredns')
    expect(param.namespace).toBe('kube-system')
    expect(param.body.metadata.resourceVersion).toBe('42')
    expect(param.body.data.NodeHosts).toContain('10.0.0.2 b.local')
    expect(options).toBeDefined() // setHeaderOptions(Content-Type: merge-patch+json)
  })

  it('retries on a 409 conflict (ApiException.code) and succeeds', async () => {
    coreApi.readNamespacedConfigMap
      .mockResolvedValueOnce(cm({ NodeHosts: '' }, '1'))
      .mockResolvedValueOnce(cm({ NodeHosts: '' }, '2'))
    coreApi.patchNamespacedConfigMap.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({})

    await upsertNodeHost('10.0.0.3', ['c.local'])

    expect(coreApi.patchNamespacedConfigMap).toHaveBeenCalledTimes(2)
    expect(coreApi.patchNamespacedConfigMap.mock.calls[1][0].body.metadata.resourceVersion).toBe('2')
  })

  it('does not retry non-conflict errors', async () => {
    coreApi.readNamespacedConfigMap.mockResolvedValue(cm({ NodeHosts: '' }))
    coreApi.patchNamespacedConfigMap.mockRejectedValue(new ApiException(403, 'Forbidden', {}, {}))
    await expect(upsertNodeHost('10.0.0.4', ['d.local'])).rejects.toMatchObject({ code: 403 })
    expect(coreApi.patchNamespacedConfigMap).toHaveBeenCalledTimes(1)
  })

  it('creates coredns-custom only when it is missing (404)', async () => {
    coreApi.readNamespacedConfigMap
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(cm({ 'custom.server': 'hosts {\n  fallthrough\n}\n' }))
    coreApi.createNamespacedConfigMap.mockResolvedValue({})

    expect(await getCustomRecords()).toEqual([])
    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'kube-system',
      body: expect.objectContaining({ metadata: { name: 'coredns-custom', namespace: 'kube-system' } }),
    }))
  })

  it('surfaces auth errors instead of attempting a create', async () => {
    coreApi.readNamespacedConfigMap.mockRejectedValue(new ApiException(403, 'Forbidden', {}, {}))
    await expect(getCustomRecords()).rejects.toMatchObject({ code: 403 })
    expect(coreApi.createNamespacedConfigMap).not.toHaveBeenCalled()
  })

  it('tolerates a concurrent create (409) and reads the ConfigMap', async () => {
    coreApi.readNamespacedConfigMap
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(cm({ 'custom.server': 'hosts {\n  1.2.3.4 x.local\n  fallthrough\n}\n' }))
    coreApi.createNamespacedConfigMap.mockRejectedValue(conflict())
    expect(await getCustomRecords()).toEqual([{ ip: '1.2.3.4', hostnames: ['x.local'] }])
  })

  it('upsertCustomRecord patches coredns-custom via object params', async () => {
    coreApi.readNamespacedConfigMap.mockResolvedValue(cm({ 'custom.server': 'hosts {\n  fallthrough\n}\n' }, '7'))
    coreApi.patchNamespacedConfigMap.mockResolvedValue({})
    await upsertCustomRecord('10.1.1.1', ['svc.local'])
    const [param] = coreApi.patchNamespacedConfigMap.mock.calls[0]
    expect(param).toMatchObject({ name: 'coredns-custom', namespace: 'kube-system' })
    expect(param.body.data['custom.server']).toContain('10.1.1.1 svc.local')
  })
})
