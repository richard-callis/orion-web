import { describe, it, expect, vi, beforeEach } from 'vitest'

const { findUnique, docker, runQuiet, runCommand } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  docker: vi.fn(),
  runQuiet: vi.fn(async () => ({ ok: true, out: '' })),
  runCommand: vi.fn(async () => {}),
}))

vi.mock('../db', () => ({ prisma: { environment: { findUnique, update: vi.fn() } } }))
vi.mock('./docker', () => ({ bootstrapDockerEnvironment: docker }))
vi.mock('./swarm', () => ({ bootstrapSwarmEnvironment: vi.fn() }))
vi.mock('./k8s', () => ({ bootstrapK8sCluster: vi.fn() }))
vi.mock('./shell', () => ({ runQuiet, runCommand }))

import { bootstrapCluster } from './index'
import { deployBootstrapMonitoring } from './monitoring'
import type { BootstrapEnvironment } from './types'

const emit = vi.fn()

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue({ id: 'env-1', name: 'lab', type: 'docker' })
  docker.mockReset()
  runQuiet.mockClear()
  runCommand.mockClear()
})

describe('bootstrapCluster in-flight lock', () => {
  it('is released after a successful bootstrap', async () => {
    docker.mockResolvedValue(undefined)
    await bootstrapCluster('env-1', emit)
    await expect(bootstrapCluster('env-1', emit)).resolves.toBeUndefined()
    expect(docker).toHaveBeenCalledTimes(2)
  })

  it('is released after a failed bootstrap', async () => {
    docker.mockRejectedValueOnce(new Error('ssh unreachable'))
    await expect(bootstrapCluster('env-1', emit)).rejects.toThrow('ssh unreachable')
    docker.mockResolvedValue(undefined)
    await expect(bootstrapCluster('env-1', emit)).resolves.toBeUndefined()
  })

  it('is released when the environment lookup throws', async () => {
    findUnique.mockRejectedValueOnce(new Error('db down'))
    await expect(bootstrapCluster('env-1', emit)).rejects.toThrow('db down')
    await expect(bootstrapCluster('env-1', emit)).resolves.toBeUndefined()
  })

  it('still rejects a concurrent bootstrap of the same environment', async () => {
    let finish!: () => void
    docker.mockImplementation(() => new Promise<void>(r => { finish = r }))
    const first = bootstrapCluster('env-1', emit)
    await vi.waitFor(() => expect(docker).toHaveBeenCalled())
    await expect(bootstrapCluster('env-1', emit)).rejects.toThrow('already in progress')
    finish()
    await first
  })
})

describe('deployBootstrapMonitoring', () => {
  it('creates the monitoring namespace without a shell pipeline in argv', async () => {
    const env = { monitoringConfig: { stack: 'basic' } } as unknown as BootstrapEnvironment
    await deployBootstrapMonitoring(env, { KUBECONFIG: '/tmp/k' }, emit)
    expect(runQuiet).toHaveBeenCalledWith('kubectl', ['create', 'namespace', 'monitoring'], { KUBECONFIG: '/tmp/k' })
    for (const call of runCommand.mock.calls as unknown as Array<[string, string[]]>) {
      expect(call[1]).not.toContain('|')
    }
  })

  it('does nothing when no stack is configured', async () => {
    await deployBootstrapMonitoring({ monitoringConfig: null } as unknown as BootstrapEnvironment, {}, emit)
    expect(runQuiet).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })
})
