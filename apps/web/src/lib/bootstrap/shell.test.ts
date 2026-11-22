import { describe, it, expect } from 'vitest'
import { runCapture } from './shell'

const sh = (script: string, timeoutMs?: number) => runCapture('sh', ['-c', script], {}, timeoutMs)

describe('runCapture', () => {
  it('keeps stdout apart from stderr noise', async () => {
    expect(await sh('echo noise >&2; echo out')).toEqual({ ok: true, stdout: 'out', stderr: 'noise' })
  })
  it('reports a failure', async () => {
    expect(await sh('echo why >&2; exit 3')).toEqual({ ok: false, stdout: '', stderr: 'why' })
    expect((await runCapture('/no/such/command', [], {})).ok).toBe(false)
  })
  it('fails rather than return a timed-out or cut-off output', async () => {
    const slow = await sh('echo partial; exec sleep 5', 100)
    expect(slow).toMatchObject({ ok: false, stdout: '' })
    expect(slow.stderr).toContain('timed out')
    const big = await sh('yes | head -c 17000000')
    expect(big).toMatchObject({ ok: false, stdout: '' })
    expect(big.stderr).toContain('too much output')
  })
})
