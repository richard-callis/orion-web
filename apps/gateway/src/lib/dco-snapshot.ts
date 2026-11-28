/**
 * dco_k8s_snapshot: fixed, argument-free, read-only kubectl listings for the DCO
 * inventory (docs/design/dco-visibility.md §5.1). Nothing a caller sends reaches argv.
 *
 * Each listing is paged by kubectl itself (--chunk-size, API continue tokens) and projected
 * narrowly, so the output stays near 150 B/pod: nodes and pods with -o custom-columns (fields
 * that never hold whitespace), the Longhorn kinds with tab-separated -o jsonpath (a blank cell
 * is a real value there, and maps print as one-line JSON). jsonpath prints a string raw, so no
 * free-text string is projected: backups carry the whole .status map as JSON, parsed per listing. Output is never truncated:
 * the cap is turned off and the 16 MB maxBuffer fails the call loudly instead.
 * No Secret is ever listed.
 */
import { run } from './run.js'
import { redactSensitive } from './redact.js'

export const CHUNK_SIZE = 250
const LH = ['-n', 'longhorn-system'] as const
const TIMEOUT_MS = 45_000

/** One fixed listing: argv, and how many columns each row must have (anything else is an error). */
interface Listing { name: string; args: string[]; cols: number; tab: boolean }

const list = (name: string, resource: string, columns: string[], ns: readonly string[] = []): Listing => ({
  name, cols: columns.length, tab: false,
  args: ['get', resource, ...ns, ...(ns.length ? [] : ['-A']), `--chunk-size=${CHUNK_SIZE}`, '--no-headers', '-o', `custom-columns=${columns.map((c, i) => `C${i}:${c}`).join(',')}`],
})

const tabList = (name: string, resource: string, fields: string[]): Listing => ({
  name, cols: fields.length, tab: true,
  args: ['get', resource, ...LH, `--chunk-size=${CHUNK_SIZE}`, '-o', `jsonpath={range .items[*]}${fields.map(f => `{${f}}`).join('{"\\t"}')}{"\\n"}{end}`],
})

export const LISTINGS = {
  nodes: list('nodes', 'nodes', ['.metadata.name', '.status.addresses[?(@.type=="InternalIP")].address', '.status.conditions[?(@.type=="Ready")].status']),
  pods: list('pods', 'pods', [
    '.metadata.uid', '.metadata.namespace', '.metadata.name',
    '.metadata.ownerReferences[?(@.controller==true)].kind', '.metadata.ownerReferences[?(@.controller==true)].name',
    '.spec.nodeName', '.status.podIPs[*].ip', '.spec.hostNetwork',
  ]),
  backups: tabList('backups', 'backups.longhorn.io', ['.metadata.name', '.status']),
  volumes: tabList('volumes', 'volumes.longhorn.io', ['.metadata.name', '.spec.size', '.status.actualSize', '.metadata.labels']),
  recurringJobs: tabList('recurringJobs', 'recurringjobs.longhorn.io', ['.metadata.name', '.spec.task', '.spec.retain', '.spec.groups[*]', '.spec.cron']),
} as const

const val = (s: string | undefined): string | null => (s === undefined || s === '<none>' || s === '' ? null : s)
const num = (s: string | undefined): number | null => { const v = val(s); return v === null || !/^\d+$/.test(v) ? null : Number(v) }
const csv = (s: string | undefined): string[] => (val(s)?.split(',') ?? [])

/** Rows of a listing: whitespace-separated (custom-columns) or tab-separated (jsonpath), exactly `cols` cells each. A wrong count is an error, never a guess. */
export function rows(out: string, { cols, tab }: Listing): string[][] {
  return out.split('\n').filter(l => (tab ? l : l.trim()) !== '').map(line => {
    const t = tab ? line.split('\t') : line.trim().split(/\s+/)
    if (t.length !== cols) throw new Error(`unparsable kubectl row (${t.length} of ${cols} columns)`)
    return t
  })
}

/** A jsonpath-printed map (one-line JSON) → the object; absent, empty or not a map → null. */
const asMap = (m: unknown): Record<string, unknown> | null =>
  m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length ? m as Record<string, unknown> : null
const jsonMap = (s: string | undefined): Record<string, unknown> | null => {
  const v = val(s)
  if (v === null) return null
  try { return asMap(JSON.parse(v)) } catch { throw new Error(`unparsable kubectl map: ${v.slice(0, 40)}`) }
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const numOf = (v: unknown): number | null => num(v === undefined || v === null ? undefined : String(v))

export interface Snapshot {
  nodes: Array<{ name: string; internalIPs: string[]; ready: 'True' | 'False' | 'Unknown' | null }>
  pods: Array<{ uid: string; namespace: string; name: string; ownerKind: string | null; ownerName: string | null; node: string | null; podIPs: string[]; hostNetwork: boolean }>
  longhorn: {
    ok: boolean
    /** One `<listing>: <reason>` per failed listing, joined by `; `. */
    error?: string
    /** A listing that failed is null, which is not the same as [] (none exist). */
    items: {
      backups: Array<{ name: string; state: string | null; progress: number | null; volume: string | null; size: number | null; createdAt: string | null; messages: Record<string, unknown> | null; error: string | null }> | null
      volumes: Array<{ name: string; size: number | null; actualSize: number | null; recurringJobs: string[] }> | null
      recurringJobs: Array<{ name: string; task: string | null; retain: number | null; groups: string[]; cron: string | null }> | null
    }
  }
}

const reason = (e: unknown): string => {
  const x = e as { stderr?: string; message?: string; killed?: boolean }
  if (x?.killed) return `timed out after ${TIMEOUT_MS / 1000}s`
  const lines = String(x?.stderr || x?.message || e).trim().split('\n')
  return redactSensitive(lines.find(l => /^(error:|Error from server)/.test(l)) ?? lines[0]).slice(0, 200)
}

/** Run one listing and map its rows; every failure (kubectl, timeout, buffer, parse, map) is an Error naming the listing. */
const exec = async <T = string[]>(l: Listing, map: (r: string[]) => T = (r => r) as (r: string[]) => T): Promise<T[]> => {
  try { return rows((await run('kubectl', l.args, { timeoutMs: TIMEOUT_MS, maxOutput: 0 })).stdout, l).map(map) }
  catch (e) { throw new Error(`${l.name}: ${reason(e)}`, { cause: e }) }
}

/**
 * Nodes and pods must succeed (a failure, including output over maxBuffer, rejects).
 * Longhorn may be absent or forbidden: nodes and pods are still returned, with `longhorn.ok=false`
 * and each failed listing null.
 */
export async function collectSnapshot(): Promise<Snapshot> {
  const [nodes, pods, lh] = await Promise.all([
    exec(LISTINGS.nodes), exec(LISTINGS.pods),
    Promise.allSettled([
      exec(LISTINGS.backups, ([name, status]) => {
        const st = jsonMap(status) ?? {}
        return { name, state: str(st.state), progress: numOf(st.progress), volume: str(st.volumeName), size: numOf(st.size), createdAt: str(st.backupCreatedAt), messages: asMap(st.messages), error: str(st.error) }
      }),
      exec(LISTINGS.volumes, ([name, size, actualSize, labels]) => ({
        name, size: num(size), actualSize: num(actualSize), recurringJobs: Object.keys(jsonMap(labels) ?? {}).filter(k => k.startsWith('recurring-job')),
      })),
      exec(LISTINGS.recurringJobs, ([name, task, retain, groups, cron]) => ({ name, task: val(task), retain: num(retain), groups: val(groups)?.split(' ') ?? [], cron: val(cron) })),
    ]),
  ])
  const failed = lh.flatMap(r => r.status === 'rejected' ? [(r.reason as Error).message] : [])
  return {
    nodes: nodes.map(([name, ips, ready]) => ({ name, internalIPs: csv(ips), ready: ready === 'True' || ready === 'False' || ready === 'Unknown' ? ready : null })),
    pods: pods.map(([uid, namespace, name, ownerKind, ownerName, node, ips, hostNet]) => ({
      uid, namespace, name, ownerKind: val(ownerKind), ownerName: val(ownerName), node: val(node), podIPs: csv(ips), hostNetwork: hostNet === 'true',
    })),
    longhorn: {
      ok: failed.length === 0,
      ...(failed.length ? { error: failed.join('; ') } : {}),
      items: {
        backups: lh[0].status === 'fulfilled' ? lh[0].value : null,
        volumes: lh[1].status === 'fulfilled' ? lh[1].value : null,
        recurringJobs: lh[2].status === 'fulfilled' ? lh[2].value : null,
      },
    },
  }
}
