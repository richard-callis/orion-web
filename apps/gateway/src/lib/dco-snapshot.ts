/**
 * dco_k8s_snapshot: fixed, argument-free, read-only kubectl listings for the DCO
 * inventory (docs/design/dco-visibility.md §5.1). Nothing a caller sends reaches argv.
 *
 * Each listing is paged by kubectl itself (--chunk-size, API continue tokens) and projected
 * with -o custom-columns, so the output stays near 150 B/pod. Output is never truncated:
 * the cap is turned off and the 16 MB maxBuffer fails the call loudly instead.
 * No Secret is ever listed.
 */
import { run } from './run.js'
import { redactSensitive } from './redact.js'

export const CHUNK_SIZE = 250
const LH = ['-n', 'longhorn-system'] as const

/** One fixed listing: argv, plus the number of leading single-token columns (the last column absorbs the rest of the line). */
interface Listing { args: string[]; cols: number }

const list = (resource: string, columns: string[], ns: readonly string[] = []): Listing => ({
  args: ['get', resource, ...ns, ...(ns.length ? [] : ['-A']), `--chunk-size=${CHUNK_SIZE}`, '--no-headers', '-o', `custom-columns=${columns.map((c, i) => `C${i}:${c}`).join(',')}`],
  cols: columns.length,
})

export const LISTINGS = {
  nodes: list('nodes', ['.metadata.name', '.status.addresses[?(@.type=="InternalIP")].address', '.status.conditions[?(@.type=="Ready")].status']),
  pods: list('pods', [
    '.metadata.uid', '.metadata.namespace', '.metadata.name', '.metadata.ownerReferences[0].kind', '.metadata.ownerReferences[0].name',
    '.spec.nodeName', '.status.podIPs[*].ip', '.spec.hostNetwork',
  ]),
  // Last column of each Longhorn listing may hold spaces (a map or a cron), so it is read as the rest of the line.
  backups: list('backups.longhorn.io', ['.metadata.name', '.status.state', '.status.progress', '.status.volumeName', '.status.size', '.status.backupCreatedAt', '.status.messages'], LH),
  volumes: list('volumes.longhorn.io', ['.metadata.name', '.spec.size', '.status.actualSize', '.metadata.labels'], LH),
  recurringJobs: list('recurringjobs.longhorn.io', ['.metadata.name', '.spec.task', '.spec.retain', '.spec.groups[*]', '.spec.cron'], LH),
} as const

const val = (s: string | undefined): string | null => (s === undefined || s === '<none>' || s === '' ? null : s)
const num = (s: string | undefined): number | null => { const v = val(s); return v === null || !/^\d+$/.test(v) ? null : Number(v) }
const csv = (s: string | undefined): string[] => (val(s)?.split(',') ?? [])

/** Split --no-headers custom-columns output: `cols - 1` single tokens, then the rest of the line. A short row is an error, never a guess. */
export function rows(out: string, { cols }: Listing): string[][] {
  return out.split('\n').filter(l => l.trim()).map(line => {
    const t = line.trim().split(/\s+/)
    if (t.length < cols) throw new Error(`unparsable kubectl row (${t.length} of ${cols} columns)`)
    return [...t.slice(0, cols - 1), t.slice(cols - 1).join(' ')]
  })
}

/** `map[a:b c:d]` (how custom-columns prints a map) → keys of the entries; none → []. */
const mapKeys = (s: string | undefined): string[] => {
  const m = /^map\[(.*)\]$/.exec(val(s) ?? '')
  return m ? m[1].split(' ').map(e => e.slice(0, e.indexOf(':'))).filter(Boolean) : []
}

export interface Snapshot {
  nodes: Array<{ name: string; internalIPs: string[]; ready: boolean }>
  pods: Array<{ uid: string; namespace: string; name: string; ownerKind: string | null; ownerName: string | null; node: string | null; podIPs: string[]; hostNetwork: boolean }>
  longhorn: {
    ok: boolean
    error?: string
    items: {
      backups: Array<{ name: string; state: string | null; progress: number | null; volume: string | null; size: number | null; createdAt: string | null; messages: string | null }>
      volumes: Array<{ name: string; size: number | null; actualSize: number | null; recurringJobs: string[] }>
      recurringJobs: Array<{ name: string; task: string | null; retain: number | null; groups: string[]; cron: string | null }>
    }
  }
}

const exec = async (l: Listing) => rows((await run('kubectl', l.args, { timeoutMs: 60_000, maxOutput: 0 })).stdout, l)

const reason = (e: unknown): string => {
  const x = e as { stderr?: string; message?: string }
  return redactSensitive(String(x?.stderr || x?.message || e).trim().split('\n')[0]).slice(0, 200)
}

/**
 * Nodes and pods must succeed (a failure, including output over maxBuffer, rejects).
 * Longhorn may be absent or forbidden: nodes and pods are still returned, with `longhorn.ok=false`.
 */
export async function collectSnapshot(): Promise<Snapshot> {
  const [nodes, pods, lh] = await Promise.all([
    exec(LISTINGS.nodes), exec(LISTINGS.pods),
    Promise.allSettled([exec(LISTINGS.backups), exec(LISTINGS.volumes), exec(LISTINGS.recurringJobs)]),
  ])
  const failed = lh.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  const get = (i: number): string[][] => { const r = lh[i]; return r.status === 'fulfilled' ? r.value : [] }
  return {
    nodes: nodes.map(([name, ips, ready]) => ({ name, internalIPs: csv(ips), ready: ready === 'True' })),
    pods: pods.map(([uid, namespace, name, ownerKind, ownerName, node, ips, hostNet]) => ({
      uid, namespace, name, ownerKind: val(ownerKind), ownerName: val(ownerName), node: val(node), podIPs: csv(ips), hostNetwork: hostNet === 'true',
    })),
    longhorn: {
      ok: failed.length === 0,
      ...(failed.length ? { error: [...new Set(failed.map(f => reason(f.reason)))].join('; ') } : {}),
      items: {
        backups: get(0).map(([name, state, progress, volume, size, createdAt, messages]) => ({
          name, state: val(state), progress: num(progress), volume: val(volume), size: num(size), createdAt: val(createdAt), messages: val(messages),
        })),
        volumes: get(1).map(([name, size, actualSize, labels]) => ({
          name, size: num(size), actualSize: num(actualSize), recurringJobs: mapKeys(labels).filter(k => k.startsWith('recurring-job')),
        })),
        recurringJobs: get(2).map(([name, task, retain, groups, cron]) => ({ name, task: val(task), retain: num(retain), groups: csv(groups), cron: val(cron) })),
      },
    },
  }
}
