import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const execFile = vi.fn()
vi.mock('child_process', () => ({ execFile: (...a: unknown[]) => execFile(...a) }))

import { knownHostsFor, providerKnownHosts, resetKnownHostsCache } from './known-hosts'
import type { GitProviderConfig } from './index'

const ED = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
const scan = `# gitea:22 SSH-2.0-OpenSSH_9.9\ngitea ssh-ed25519 ${ED}\ngitea ssh-rsa AAAAB3NzaC1yc2E=\ngitea ssh-ed25519 ${ED}\ngarbage line here x\n`

beforeEach(() => {
  resetKnownHostsCache()
  process.env.MANAGEMENT_IP = '10.0.0.5'
  delete process.env.GITEA_SSH_PORT
  execFile.mockReset()
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: scan, stderr: '' }))
})
afterEach(() => { delete process.env.MANAGEMENT_IP })

const bundled: GitProviderConfig = { type: 'gitea-bundled', token: 't', org: 'orion' }

describe('knownHostsFor', () => {
  it('keeps key lines only, renamed to the dialled host, deduplicated', () => {
    expect(knownHostsFor(scan, '[10.0.0.5]:2222')).toEqual([
      `[10.0.0.5]:2222 ssh-ed25519 ${ED}`,
      '[10.0.0.5]:2222 ssh-rsa AAAAB3NzaC1yc2E=',
    ])
  })
  it('drops anything that is not a plain key line', () => {
    expect(knownHostsFor('gitea ssh-ed25519 AAAA extra\n@cert-authority * ssh-ed25519 AAAA\ngitea ssh-dss AAAA', 'h')).toEqual([])
  })
})

describe('providerKnownHosts', () => {
  it('scans the bundled Gitea on the compose network and names the cluster-facing address', async () => {
    process.env.GITEA_SSH_PORT = '2022'
    const lines = await providerKnownHosts(bundled, { bundledGiteaSsh: true })
    expect(lines[0]).toBe(`[10.0.0.5]:2022 ssh-ed25519 ${ED}`)
    expect(execFile.mock.calls[0][0]).toBe('ssh-keyscan')
    expect(execFile.mock.calls[0][1]).toEqual(['-T', '5', '-p', '22', '--', 'gitea'])
  })
  it('caches the scan', async () => {
    await providerKnownHosts(bundled, { bundledGiteaSsh: true })
    await providerKnownHosts(bundled, { bundledGiteaSsh: true })
    expect(execFile).toHaveBeenCalledTimes(1)
  })
  it('needs nothing for GitHub, HTTPS providers, or the bundled Gitea over HTTP', async () => {
    expect(await providerKnownHosts(bundled)).toEqual([])
    expect(await providerKnownHosts({ type: 'github', token: 't', org: 'o' })).toEqual([])
    expect(await providerKnownHosts({ type: 'gitea', url: 'https://g.example.com', token: 't', org: 'o' })).toEqual([])
    expect(execFile).not.toHaveBeenCalled()
  })
  it('fails when no key comes back', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string }) => void) => cb(null, { stdout: '' }))
    await expect(providerKnownHosts(bundled, { bundledGiteaSsh: true })).rejects.toThrow(/no host keys/)
  })
})
