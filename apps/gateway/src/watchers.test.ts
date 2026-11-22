import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('./lib/run.js', () => ({ run }))

import { ArgoCDWatcher, REPORT_REFRESH_MS } from './argocd-watcher.js'
import { DockerComposeWatcher } from './docker-compose-watcher.js'

const app = (health = 'Healthy') => ({ metadata: { name: 'a', namespace: 'argocd' }, status: { sync: { status: 'Synced', revision: 'r1' }, health: { status: health } } })
const argo = (health?: string) => ({ stdout: JSON.stringify({ items: [app(health)] }), stderr: '' })
const ID = (n: string) => n.repeat(12)
const container = (id: string, state: string, status: string) => ({ ID: id, Names: `c-${id[0]}`, State: state, Status: status, Image: 'img', Labels: '' })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-22T20:00:00Z'))
  run.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('ArgoCDWatcher', () => {
  it('reports a change at once, then re-sends unchanged state as a refresh', async () => {
    const report = vi.fn(async () => {})
    const w = new ArgoCDWatcher(report)
    run.mockResolvedValue(argo())
    await w.poll()
    expect(report.mock.calls).toEqual([[[expect.objectContaining({ name: 'a' })]]])
    vi.advanceTimersByTime(REPORT_REFRESH_MS - 1)
    await w.poll()
    expect(report).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await w.poll()
    expect(report).toHaveBeenCalledTimes(2)
    expect(report).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'a' })], { refresh: true })
    run.mockResolvedValue(argo('Degraded'))
    await w.poll()
    expect(report).toHaveBeenLastCalledWith([expect.objectContaining({ healthStatus: 'Degraded' })])
  })

  it('keeps the refresh inside the detector’s 10 minutes, poll interval included', () => {
    expect(REPORT_REFRESH_MS + 2 * 60_000).toBeLessThan(10 * 60_000)
  })

  it('retries a refresh that failed on the next poll', async () => {
    const report = vi.fn(async () => {})
    const w = new ArgoCDWatcher(report)
    run.mockResolvedValue(argo())
    await w.poll()
    vi.advanceTimersByTime(REPORT_REFRESH_MS)
    report.mockRejectedValueOnce(new Error('down'))
    await expect(w.poll()).rejects.toThrow('down')
    await w.poll()
    expect(report).toHaveBeenCalledTimes(3)
    expect(report).toHaveBeenLastCalledWith(expect.anything(), { refresh: true })
  })

  it('re-sends a change whose report failed as a change, not a refresh', async () => {
    const report = vi.fn(async () => {})
    const w = new ArgoCDWatcher(report)
    run.mockResolvedValue(argo())
    await w.poll()
    run.mockResolvedValue(argo('Degraded'))
    report.mockRejectedValueOnce(new Error('502'))
    await expect(w.poll()).rejects.toThrow('502')
    await w.poll()
    expect(report).toHaveBeenLastCalledWith([expect.objectContaining({ healthStatus: 'Degraded' })])
  })

  it('refreshes on every fourth 60s poll even when reports are slow', async () => {
    const report = vi.fn(async () => { vi.advanceTimersByTime(2_000) })
    const w = new ArgoCDWatcher(report)
    run.mockResolvedValue(argo())
    const start = Date.now()
    for (let i = 0; i <= 8; i++) {
      vi.setSystemTime(start + i * 60_000)
      await w.poll()
    }
    expect(report).toHaveBeenCalledTimes(3) // polls 0, 4 and 8
  })

  it('drops a removed app on the next refresh, and sends nothing for an empty list', async () => {
    const report = vi.fn(async () => {})
    const w = new ArgoCDWatcher(report)
    const two = { ...app(), metadata: { name: 'b', namespace: 'argocd' } }
    run.mockResolvedValue({ stdout: JSON.stringify({ items: [app(), two] }), stderr: '' })
    await w.poll()
    run.mockResolvedValue(argo())
    vi.advanceTimersByTime(REPORT_REFRESH_MS)
    await w.poll()
    expect(report).toHaveBeenLastCalledWith([expect.objectContaining({ name: 'a' })], { refresh: true })
    run.mockResolvedValue({ stdout: JSON.stringify({ items: [] }), stderr: '' })
    vi.advanceTimersByTime(REPORT_REFRESH_MS)
    await w.poll()
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('reports nothing when ArgoCD cannot be read, so the state does go stale', async () => {
    const report = vi.fn(async () => {})
    const w = new ArgoCDWatcher(report)
    run.mockResolvedValue(argo())
    await w.poll()
    run.mockRejectedValue(new Error('forbidden'))
    vi.advanceTimersByTime(REPORT_REFRESH_MS * 5)
    await w.poll()
    expect(report).toHaveBeenCalledTimes(1)
  })
})

describe('DockerComposeWatcher', () => {
  const poll = async (containers: unknown[], inspect: string | Error) => {
    const report = vi.fn(async () => {})
    run.mockImplementation(async (_bin: string, args: string[]) => {
      if (args[0] === 'ps') return { stdout: containers.map(c => JSON.stringify(c)).join('\n'), stderr: '' }
      if (inspect instanceof Error) throw inspect
      return { stdout: inspect, stderr: '' }
    })
    await new DockerComposeWatcher(report).poll()
    const apps = (report.mock.calls as unknown as Array<[Array<{ name: string; syncStatus: string; healthStatus: string }>]>)[0][0]
    return Object.fromEntries(apps.map(a => [a.name, `${a.syncStatus}/${a.healthStatus}`]))
  }

  it('treats a finished one-shot as healthy, but not a stopped service or a failure', async () => {
    const got = await poll([
      container(ID('a'), 'exited', 'Exited (0) 2 days ago'),
      container(ID('b'), 'exited', 'Exited (0) 2 days ago'),
      container(ID('c'), 'exited', 'Exited (137) 2 days ago'),
      container(ID('d'), 'running', 'Up 3 hours (healthy)'),
    ], `${ID('a')}ffff no\n${ID('b')}ffff unless-stopped\n`)
    expect(got).toEqual({ 'c-a': 'Synced/Healthy', 'c-b': 'OutOfSync/Degraded', 'c-c': 'OutOfSync/Degraded', 'c-d': 'Synced/Healthy' })
    const inspect = run.mock.calls.find(c => c[1][0] === 'inspect')![1]
    expect(inspect.slice(-2)).toEqual([ID('a'), ID('b')])
  })

  it('still flags them when docker inspect fails', async () => {
    expect(await poll([container(ID('a'), 'exited', 'Exited (0) 1 hour ago')], new Error('x'))).toEqual({ 'c-a': 'OutOfSync/Degraded' })
  })

  it('keeps the other results when one container vanished before the inspect', async () => {
    const partial = Object.assign(new Error('No such container'), { stdout: `${ID('a')}ffff no\n` })
    expect(await poll([
      container(ID('a'), 'exited', 'Exited (0) 1 hour ago'),
      container(ID('b'), 'exited', 'Exited (0) 1 hour ago'),
    ], partial)).toEqual({ 'c-a': 'Synced/Healthy', 'c-b': 'OutOfSync/Degraded' })
  })

  it('does not inspect when nothing exited cleanly', async () => {
    await poll([container(ID('d'), 'running', 'Up')], '')
    expect(run.mock.calls.every(c => c[1][0] === 'ps')).toBe(true)
  })

  it('re-sends unchanged state as a refresh', async () => {
    const report = vi.fn(async () => {})
    run.mockResolvedValue({ stdout: JSON.stringify(container(ID('d'), 'running', 'Up')), stderr: '' })
    const w = new DockerComposeWatcher(report)
    await w.poll()
    vi.advanceTimersByTime(REPORT_REFRESH_MS)
    await w.poll()
    expect(report).toHaveBeenLastCalledWith(expect.anything(), { refresh: true })
  })
})
