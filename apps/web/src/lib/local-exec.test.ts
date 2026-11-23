import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync } from 'fs'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', async orig => ({ ...(await orig<typeof import('child_process')>()), execFile }))

import { makeLocalGx } from './local-exec'

const argv = () => execFile.mock.calls.map(c => [c[0], ...c[1]])
beforeEach(() => { execFile.mockReset().mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: 'out' })) })

describe('makeLocalGx', () => {
  it('passes kubectl arguments as kubectl takes them, and removes the kubeconfig on cleanup', async () => {
    const gx = makeLocalGx(Buffer.from('kc').toString('base64'))
    await gx('kubectl_get', { resource: 'pods', namespace: 'sso', output: 'json' })
    await gx('kubectl_patch', { resource: 'deployment', name: 'd', namespace: 'sso', patchType: 'strategic', patch: '{}' })
    const kc = argv()[0].at(-1)!
    expect(argv()[0]).toEqual(['kubectl', 'get', 'pods', '-n', 'sso', '-o', 'json', '--kubeconfig', kc])
    expect(argv()[1]).toEqual(['kubectl', 'patch', 'deployment', 'd', '-n', 'sso', '--type=strategic', '--patch={}', '--kubeconfig', kc])
    expect(existsSync(kc)).toBe(true)
    gx.cleanup()
    expect(existsSync(kc)).toBe(false)
  })
  it('refuses a tool it does not have, instead of returning nothing', async () => {
    const gx = makeLocalGx('')
    await expect(gx('docker_run', {})).rejects.toThrow('unsupported tool docker_run')
    expect(execFile).not.toHaveBeenCalled()
    gx.cleanup()
  })
})
