import { describe, expect, it, vi } from 'vitest'
import { dropNodePorts, nodePortRemovalPatch } from './drop-node-ports'

const svc = (alloc: boolean | undefined, ports: Array<{ nodePort?: number }>) =>
  ({ spec: { type: 'LoadBalancer', allocateLoadBalancerNodePorts: alloc, ports } })

describe('nodePortRemovalPatch', () => {
  it('removes every allocated nodePort once allocation is off', () => {
    expect(nodePortRemovalPatch(svc(false, [{ nodePort: 31935 }, {}, { nodePort: 31033 }]))).toEqual([
      { op: 'remove', path: '/spec/ports/0/nodePort' },
      { op: 'remove', path: '/spec/ports/2/nodePort' },
    ])
  })
  it('leaves a Service that still allocates NodePorts alone', () => {
    expect(nodePortRemovalPatch(svc(true, [{ nodePort: 31935 }]))).toEqual([])
    expect(nodePortRemovalPatch(svc(undefined, [{ nodePort: 31935 }]))).toEqual([])
  })
  it('has nothing to do without NodePorts or a spec', () => {
    expect(nodePortRemovalPatch(svc(false, [{}, {}]))).toEqual([])
    expect(nodePortRemovalPatch(null)).toEqual([])
  })
})

describe('dropNodePorts', () => {
  it('patches with a JSON patch only when needed', async () => {
    const exec = vi.fn(async (tool: string) =>
      tool === 'kubectl_get' ? JSON.stringify(svc(false, [{ nodePort: 31200 }, { nodePort: 31200 }])) : 'patched')
    expect(await dropNodePorts(exec, 'coredns-orion', 'kube-system')).toBe(2)
    expect(exec).toHaveBeenLastCalledWith('kubectl_patch', {
      resource: 'service', name: 'coredns-orion', namespace: 'kube-system', patchType: 'json',
      patch: JSON.stringify([
        { op: 'remove', path: '/spec/ports/0/nodePort' },
        { op: 'remove', path: '/spec/ports/1/nodePort' },
      ]),
    })
    const idle = vi.fn(async () => JSON.stringify(svc(false, [{}])))
    expect(await dropNodePorts(idle, 'traefik', 'kube-system')).toBe(0)
    expect(idle).toHaveBeenCalledTimes(1)
  })
})
