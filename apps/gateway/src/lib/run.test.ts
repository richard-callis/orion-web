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
