import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { collectSnapshot, LISTINGS, CHUNK_SIZE } from './dco-snapshot.js'
import { kubernetesTools } from '../builtin-tools/kubernetes.js'
import { READ_ONLY_TOOLS, readOnlyBuiltins } from './read-only.js'
import { getToolSeverity, TOOL_SEVERITY } from '../gateway-audit.js'

// A fake `kubectl` on PATH, run through the real run.ts: it logs argv and prints fixtures, so
// truncation (maxOutput) and the buffer limit are exercised, not mocked.
let dir: string, oldPath: string | undefined
const fix = (name: string, body: string) => writeFileSync(path.join(dir, name), body)
const calls = () => readFileSync(path.join(dir, 'argv.log'), 'utf8').split('\n').filter(Boolean)

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dco-kubectl-'))
  writeFileSync(path.join(dir, 'kubectl'), `#!/bin/sh
printf '%s\n' "$*" >> "$FIXDIR/argv.log"
case "$2" in
  *longhorn.io)
    [ -n "$NO_LONGHORN" ] && { echo "error: the server doesn't have a resource type \\"$2\\"" >&2; exit 1; }
    [ -n "$FORBIDDEN" ] && { echo 'W1128 memcache.go:265] couldn'"'"'t get resource list for metrics.k8s.io/v1beta1' >&2; echo 'Error from server (Forbidden): backups.longhorn.io is forbidden: User "system:serviceaccount:x:y" cannot list resource "backups" in API group "longhorn.io" in the namespace "longhorn-system"' >&2; exit 1; }
    [ -n "$BACKUPS_FAIL" ] && [ "$2" = backups.longhorn.io ] && { echo 'Error from server (Forbidden): backups.longhorn.io is forbidden' >&2; exit 1; }
    f="$2" ;;
  *) f="$2" ;;
esac
[ -n "$BIG" ] && [ "$2" = pods ] && { yes 'u-1 default p ReplicaSet p node-01 10.244.0.5 <none>' | head -c 17000000; exit 0; }
cat "$FIXDIR/$f"
`)
  chmodSync(path.join(dir, 'kubectl'), 0o755)
  oldPath = process.env.PATH
  process.env.PATH = `${dir}:${oldPath}`
  process.env.FIXDIR = dir
})
afterAll(() => { process.env.PATH = oldPath; delete process.env.FIXDIR; rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => {
  delete process.env.NO_LONGHORN; delete process.env.BIG; delete process.env.FORBIDDEN; delete process.env.BACKUPS_FAIL
  writeFileSync(path.join(dir, 'argv.log'), '')
  fix('nodes', 'node-01 10.0.0.11 True\nnode-02 10.0.0.12 Unknown\nnode-03 10.0.0.13 <none>\n')
  fix('pods', 'u-1 kube-system coredns-abc ReplicaSet coredns-abc node-01 10.244.0.5 <none>\nu-2 kube-system kube-proxy-x DaemonSet kube-proxy node-02 10.0.0.12 true\nu-3 default job-1 <none> <none> <none> <none> <none>\nu-4 default dual-1 StatefulSet dual node-01 10.244.0.9,fd00::9 <none>\n')
  const tsv = (...r: string[][]) => r.map(c => c.join('\t') + '\n').join('')
  const labels = '{"other":"x","recurring-job-group.longhorn.io/default":"enabled","recurring-job.longhorn.io/nightly":"enabled"}'
  // kubectl jsonpath shape: an empty string is a blank cell, an absent field is blank, a map is one-line JSON.
  const st = (o: Record<string, unknown>) => JSON.stringify(o)
  fix('backups.longhorn.io', tsv(
    ['bk-1', st({ state: 'InProgress', progress: 61, volumeName: 'vol-a', size: '5000000000', backupCreatedAt: '2026-01-01T00:00:00Z', messages: { note: 'disk is slow' } })],
    ['bk-2', st({ state: 'Completed', progress: 100, volumeName: 'vol-b', size: '10', backupCreatedAt: '2026-01-02T00:00:00Z', messages: {} })],
    ['bk-3', st({ state: 'InProgress', progress: 37, volumeName: 'vol-a' })],
    ['bk-4', st({ progress: 0, messages: { error: 'engine is not ready for backup', detail: 'a b c d e f g h' } })],
    ['bk-5', st({ state: 'Error', progress: 0, volumeName: 'vol-a', error: 'proxyAddress is unreachable' })],
    ['bk-6', st({ state: 'Error', progress: 0, volumeName: 'vol-a', error: 'line one\nline two\tx', messages: { error: 'line one\nline two\ttabbed a b c d e f g h' } })],
    ['bk-7', ''],
  ))
  fix('volumes.longhorn.io', tsv(['vol-a', '6000000000', '5000000000', labels], ['vol-b', '1', '0', '']))
  fix('recurringjobs.longhorn.io', tsv(
    ['nightly', st({ task: 'backup', retain: 7, groups: ['default', 'extra'], cron: '0 2 * * *' })],
    ['tabbed', st({ task: 'snapshot', retain: 3, groups: [], cron: '0\t2 * * *' })],
  ))
})

describe('collectSnapshot', () => {
  it('projects nodes, pods and Longhorn objects', async () => {
    const s = await collectSnapshot()
    expect(s.nodes).toEqual([
      { name: 'node-01', internalIPs: ['10.0.0.11'], ready: 'True' },
      { name: 'node-02', internalIPs: ['10.0.0.12'], ready: 'Unknown' },
      { name: 'node-03', internalIPs: ['10.0.0.13'], ready: null },
    ])
    expect(s.pods[0]).toEqual({ uid: 'u-1', namespace: 'kube-system', name: 'coredns-abc', ownerKind: 'ReplicaSet', ownerName: 'coredns-abc', node: 'node-01', podIPs: ['10.244.0.5'], hostNetwork: false })
    expect(s.pods[1].hostNetwork).toBe(true)
    expect(s.pods[2]).toMatchObject({ ownerKind: null, ownerName: null, node: null, podIPs: [] })
    expect(s.pods[3].podIPs).toEqual(['10.244.0.9', 'fd00::9'])
    expect(s.longhorn.ok).toBe(true)
    const bk = s.longhorn.items.backups!
    expect(bk).toHaveLength(7)
    expect(bk[0]).toEqual({ name: 'bk-1', state: 'InProgress', progress: 61, volume: 'vol-a', size: 5000000000, createdAt: '2026-01-01T00:00:00Z', messages: { note: 'disk is slow' }, error: null })
    expect(bk[1]).toMatchObject({ size: 10, createdAt: '2026-01-02T00:00:00Z', messages: null })
    // in progress: blank size/createdAt cells stay in their columns
    expect(bk[2]).toEqual({ name: 'bk-3', state: 'InProgress', progress: 37, volume: 'vol-a', size: null, createdAt: null, messages: null, error: null })
    // pending: blank state/volume, a message with spaces
    expect(bk[3]).toMatchObject({ state: null, volume: null, messages: { error: 'engine is not ready for backup', detail: 'a b c d e f g h' } })
    expect(bk[4]).toMatchObject({ state: 'Error', error: 'proxyAddress is unreachable', messages: null })
    // newline and tab inside error/messages cannot split the row or merge cells: JSON-encoded in the status map
    expect(bk[5].name).toBe('bk-6')
    expect(bk[5].error).toBe('line one\nline two\tx')
    expect(bk[6]).toEqual({ name: 'bk-7', state: null, progress: null, volume: null, size: null, createdAt: null, messages: null, error: null })
    expect(bk[5].messages).toEqual({ error: 'line one\nline two\ttabbed a b c d e f g h' })
    expect(s.longhorn.items.volumes![0]).toEqual({ name: 'vol-a', size: 6000000000, actualSize: 5000000000, recurringJobs: ['recurring-job-group.longhorn.io/default', 'recurring-job.longhorn.io/nightly'] })
    expect(s.longhorn.items.volumes![1].recurringJobs).toEqual([])
    expect(s.longhorn.items.recurringJobs).toEqual([
      { name: 'nightly', task: 'backup', retain: 7, groups: ['default', 'extra'], cron: '0 2 * * *' },
      { name: 'tabbed', task: 'snapshot', retain: 3, groups: [], cron: '0\t2 * * *' },
    ])
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
    await expect(collectSnapshot()).rejects.toThrow(/maxBuffer/)
  })

  it('fails on an unparsable row instead of guessing', async () => {
    fix('nodes', 'node-01 10.0.0.11\n')
    await expect(collectSnapshot()).rejects.toThrow(/nodes: unparsable kubectl row \(2 of 3 columns\)/)
    fix('nodes', 'node-01 10.0.0.11 True\n')
    fix('backups.longhorn.io', 'bk-1\tInProgress\t37\tvol-a\n')
    const s = await collectSnapshot()
    expect(s.longhorn.ok).toBe(false)
    expect(s.longhorn.error).toMatch(/^backups: unparsable kubectl row \(4 of 2 columns\)/)
  })

  it('names a Longhorn map parse failure per listing and still returns nodes and pods', async () => {
    fix('volumes.longhorn.io', 'vol-a\t6000000000\t5000000000\tnot json\n')
    const s = await collectSnapshot()
    expect(s.nodes).toHaveLength(3)
    expect(s.pods).toHaveLength(4)
    expect(s.longhorn.ok).toBe(false)
    expect(s.longhorn.error).toMatch(/^volumes: unparsable kubectl map/)
    expect(s.longhorn.items.volumes).toBeNull()
    expect(s.longhorn.items.backups).toHaveLength(7)
  })

  it('still returns nodes and pods when the Longhorn CRDs are absent', async () => {
    process.env.NO_LONGHORN = '1'
    const s = await collectSnapshot()
    expect(s.nodes).toHaveLength(3)
    expect(s.pods).toHaveLength(4)
    expect(s.longhorn.ok).toBe(false)
    expect(s.longhorn.error).toMatch(/doesn't have a resource type/)
    expect(s.longhorn.items).toEqual({ backups: null, volumes: null, recurringJobs: null })
  })

  it('reports an RBAC failure from the Error line, not a leading warning', async () => {
    process.env.FORBIDDEN = '1'
    const s = await collectSnapshot()
    expect(s.longhorn.ok).toBe(false)
    expect(s.longhorn.error).toMatch(/^backups: Error from server \(Forbidden\)/)
    expect(s.nodes).toHaveLength(3)
  })

  it('returns the other Longhorn listings when only backups fails, and names the failure', async () => {
    process.env.BACKUPS_FAIL = '1'
    const s = await collectSnapshot()
    expect(s.longhorn.ok).toBe(false)
    expect(s.longhorn.error).toMatch(/^backups: .*Forbidden/)
    expect(s.longhorn.error).not.toMatch(/volumes|recurringJobs/)
    expect(s.longhorn.items.backups).toBeNull()
    expect(s.longhorn.items.volumes).toHaveLength(2)
    expect(s.longhorn.items.recurringJobs).toHaveLength(2)
    expect(s.nodes).toHaveLength(3)
    expect(s.pods).toHaveLength(4)
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
      expect(l.args.join(' ')).toMatch(/-o (custom-columns|jsonpath)=/)
      expect(l.args[0]).toBe('get')
    }
    expect(calls().join(' ')).not.toMatch(/secret|attacker|token|-o json(\s|$)|-o yaml|--raw/i)
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} })
  })

  it('returns parseable JSON', async () => {
    expect(JSON.parse(await tool.execute({}) as string).nodes).toHaveLength(3)
  })

  it('is on the read-only allowlist and survives read-only filtering', () => {
    expect(READ_ONLY_TOOLS.has('dco_k8s_snapshot')).toBe(true)
    expect(readOnlyBuiltins(kubernetesTools).map(t => t.name)).toContain('dco_k8s_snapshot')
  })

  it('is audited at severity 10 (no incident)', () => {
    expect(Object.prototype.hasOwnProperty.call(TOOL_SEVERITY, 'dco_k8s_snapshot')).toBe(true)
    expect(TOOL_SEVERITY.dco_k8s_snapshot).toBeLessThan(60)
    expect(getToolSeverity('dco_k8s_snapshot')).toBe(10)
  })
})
