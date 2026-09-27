import { describe, it, expect } from 'vitest'
import { run, ALLOWED_BINARIES } from './run'

describe('run() binary allowlist', () => {
  it('rejects binaries outside the allowlist without spawning', async () => {
    await expect(run('bash', ['-c', 'id'])).rejects.toThrow(/not an allowed binary/)
    await expect(run('/bin/sh', ['-c', 'id'])).rejects.toThrow(/not an allowed binary/)
  })

  it('allows the known tool binaries', () => {
    for (const b of ['kubectl', 'helm', 'docker', 'talosctl', 'velero', 'sh']) expect(ALLOWED_BINARIES.has(b)).toBe(true)
  })
})

describe('run() argument checks', () => {
  it('rejects NUL and newlines in tool CLI arguments', async () => {
    await expect(run('kubectl', ['get', 'pods\n--all-namespaces'])).rejects.toThrow(/unsafe command argument/)
    await expect(run('kubectl', ['get', 'po\u0000ds'])).rejects.toThrow(/unsafe command argument/)
  })

  it('allows a multi-line sh -c script (admin-defined shell tools)', async () => {
    const { stdout } = await run('sh', ['-c', "echo one\necho 'two'"])
    expect(stdout).toBe('one\ntwo\n')
  })

  it('still rejects NUL in a sh -c script', async () => {
    await expect(run('sh', ['-c', 'echo a\u0000b'])).rejects.toThrow(/unsafe command argument/)
  })
})
