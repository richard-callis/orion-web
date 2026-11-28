import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { collectSnapshot, LISTINGS, CHUNK_SIZE } from './dco-snapshot.js'
import { kubernetesTools } from '../builtin-tools/kubernetes.js'
import { READ_ONLY_TOOLS, readOnlyBuiltins } from './read-only.js'
import { getToolSeverity } from '../gateway-audit.js'

// A fake `kubectl` on PATH, run through the real run.ts: it logs argv and prints fixtures, so
// truncation (maxOutput) and the buffer limit are exercised, not mocked.
let dir: string, oldPath: string | undefined
const fix = (name: string, body: string) => writeFileSync(path.join(dir, name), body)
const calls = () => readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\n').filter(Boolean)

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dco-kubectl-'))
  writeFileSync(path.join(dir, 'kubectl'), `#!/bin/sh
echo "$@" >> "$FIXDIR/argv.log"
case "$2" in
  *longhorn.io) [ -n "$NO_LONGHORN" ] && { echo 'Error from server (NotFound): the server could not find the requested resource' >&2; exit 1; }; f="$2" ;;
  *) f="$2" ;;
esac
[ -n "$BIG" ] && [ "$2" = pods ] && { yes 'x' | head -c 17000000; exit 0; }
cat "$FIXDIR/$f"
`)
  chmodSync(path.join(dir, 'kubectl'), 0o755)
  oldPath = process.env.PATH
  process.env.PATH = `${dir}:${oldPath}`
  process.env.FIXDIR = dir
})
afterAll(() => { process.env.PATH = oldPath; delete process.env.FIXDIR; rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  delete process.env.NO_LONGHORN; delete process.env.BIG
  writeFileSync(path.join(dir, 'argv.log'), '')
  fix('nodes', 'node-01 10.0.0.11 True\nnode-02 10.0.0.12 False\n')
  fix('pods', 'u-1 kube-system coredns-abc ReplicaSet coredns-abc node-01 10.244.0.5 <none>\nu-2 kube-system kube-proxy-x DaemonSet kube-proxy node-02 10.0.0.12 true\nu-3 default job-1 <none> <none> <none> <none> <none>\nu-4 default dual-1 StatefulSet dual node-01 10.244.0.9,fd00::9 <none>\n')
  fix('backups.longhorn.io', 'bk-1 InProgress 61 vol-a 5000000000 2026-01-01T00:00:00Z map[error:disk is slow]\nbk-2 Completed 100 vol-b 10 <none> <none>\n')
  fix('volumes.longhorn.io', 'vol-a 6000000000 5000000000 map[recurring-job-group.longhorn.io/default:enabled recurring-job.longhorn.io/nightly:enabled other:x]\nvol-b 1 0 <none>\n')
  fix('recurringjobs.longhorn.io', 'nightly backup 7 default,extra 0 2 * * *\n')
})

describe('collectSnapshot', () => {
  it('projects nodes, pods and Longhorn objects', async () => {
    const s = await collectSnapshot()
    expect(s.nodes).toEqual([
      { name: 'node-01', internalIPs: ['10.0.0.11'], ready: true },
      { name: 'node-02', internalIPs: ['10.0.0.12'], ready: false },
    ])
    expect(s.pods[0]).toEqual({ uid: 'u-1', namespace: 'kube-system', name: 'coredns-abc', ownerKind: 'ReplicaSet', ownerName: 'coredns-abc', node: 'node-01', podIPs: ['10.244.0.5'], hostNetwork: false })
    expect(s.pods[1].hostNetwork).toBe(true)
    expect(s.pods[2]).toMatchObject({ ownerKind: null, ownerName: null, node: null, podIPs: [] })
    expect(s.pods[3].podIPs).toEqual(['10.244.0.9', 'fd00::9'])
    expect(s.longhorn.ok).toBe(true)
    expect(s.longhorn.items.backups[0]).toEqual({ name: 'bk-1', state: 'InProgress', progress: 61, volume: 'vol-a', size: 5000000000, createdAt: '2026-01-01T00:00:00Z', messages: 'map[error:disk is slow]' })
    expect(s.longhorn.items.backups[1]).toMatchObject({ size: 10, createdAt: null, messages: null })
    expect(s.longhorn.items.volumes[0]).toEqual({ name: 'vol-a', size: 6000000000, actualSize: 5000000000, recurringJobs: ['recurring-job-group.longhorn.io/default', 'recurring-job.longhorn.io/nightly'] })
    expect(s.longhorn.items.volumes[1].recurringJobs).toEqual([])
    expect(s.longhorn.items.recurringJobs).toEqual([{ name: 'nightly', task: 'backup', retain: 7, groups: ['default', 'extra'], cron: '0 2 * * *' }])
  })

  it('returns a 3000-pod listing (>256 KB) untruncated', async () => {
    const line = (i: number) => `uid-${String(i).padStart(5, '0')} workloads app-${i}-6d9f7b8c5-abcde ReplicaSet app-${i}-6d9f7b8c5 node-0${i % 3} 10.244.${i % 250}.${i % 200} <none>`
    const text = Array.from({ length: 3000 }, (_, i) => line(i)).join('\n') + '\n'
    expect(text.length).toBeGreaterThan(256 * 1024)
    fix('pods', text)
    const s = await collectSnapshot()
    expect(s.pods).toHaveLength(3000)
    expect(s.pods[2999].uid).toBe('uid-02999')
  })

  it('fails loudly when output exceeds the buffer, instead of truncating', async () => {
    process.env.BIG = '1'
    await expect(collectSnapshot()).rejects.toThrow()
  })

  it('fails on an unparsable row instead of guessing', async () => {
    fix('nodes', 'node-01 10.0.0.11\n')
    await expect(collectSnapshot()).rejects.toThrow(/unparsable/)
  })

  it('still returns nodes and pods when the Longhorn CRDs are absent', async () => {
    process.env.NO_LONGHORN = '1'
    const s = await collectSnapshot()
    expect(s.nodes).toHaveLength(2)
    expect(s.pods).toHaveLength(4)
    expect(s.longhorn.ok).toBe(false)
    expect(s.longhorn.error).toMatch(/NotFound/)
    expect(s.longhorn.items).toEqual({ backups: [], volumes: [], recurringJobs: [] })
  })
})

describe('dco_k8s_snapshot argv and tool wiring', () => {
  const tool = kubernetesTools.find(t => t.name === 'dco_k8s_snapshot')!

  it('runs only the fixed, paged, projected listings, whatever the caller sends', async () => {
    await tool.execute({ namespace: '--server=https://attacker.example.com', args: ['--token=x'], resource: 'secrets' })
    const expected = Object.values(LISTINGS).map(l => l.args.join(' ')).sort()
    expect(calls().sort()).toEqual(expected)
    for (const l of Object.values(LISTINGS)) {
      expect(l.args).toContain(`--chunk-size=${CHUNK_SIZE}`)
      expect(l.args.join(' ')).toMatch(/-o custom-columns=/)
      expect(l.args[0]).toBe('get')
    }
    expect(calls().join(' ')).not.toMatch(/secret|attacker|token|-o json|-o yaml|--raw/i)
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('returns parseable JSON', async () => {
    expect(JSON.parse(await tool.execute({}) as string).nodes).toHaveLength(2)
  })

  it('is on the read-only allowlist and survives read-only filtering', () => {
    expect(READ_ONLY_TOOLS.has('dco_k8s_snapshot')).toBe(true)
    expect(readOnlyBuiltins(kubernetesTools).map(t => t.name)).toContain('dco_k8s_snapshot')
  })

  it('is audited at severity 10 (no incident)', () => {
    expect(getToolSeverity('dco_k8s_snapshot')).toBe(10)
  })
})
