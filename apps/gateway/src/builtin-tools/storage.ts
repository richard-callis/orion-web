import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'

const exec = promisify(execFile)

async function kubectl(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout, stderr } = await exec('kubectl', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
  return stdout || stderr
}

interface PvcItem {
  metadata?: { name?: string; namespace?: string }
  spec?: { storageClassName?: string; resources?: { requests?: { storage?: string } } }
  status?: { phase?: string; capacity?: { storage?: string } }
}

export const storageTools = ([
  {
    name: 'pvc_list',
    description: 'List PersistentVolumeClaims with size, phase, and storage class',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace (omit for all namespaces)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const cmd = ['get', 'pvc', '-o', 'json']
      if (args.namespace) cmd.push('-n', String(args.namespace))
      else cmd.push('-A')
      const json = await kubectl(cmd)
      const list = JSON.parse(json) as { items?: PvcItem[] }
      const items = list.items ?? []
      if (items.length === 0) return 'No PVCs found'
      const lines = items.map((p) => {
        const ns = p.metadata?.namespace ?? '-'
        const name = p.metadata?.name ?? '-'
        const phase = p.status?.phase ?? '-'
        const size = p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage ?? '-'
        const sc = p.spec?.storageClassName ?? '-'
        return `${ns}/${name}  phase=${phase}  size=${size}  storageClass=${sc}`
      })
      return lines.join('\n')
    },
  },
  {
    name: 'pvc_resize',
    description: 'Resize a PVC by patching its requested storage (requires a storage class that allows volume expansion)',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace' },
        name:      { type: 'string', description: 'PVC name' },
        newSize:   { type: 'string', description: 'New size, e.g. 20Gi' },
      },
      required: ['namespace', 'name', 'newSize'],
    },
    async execute(args: Record<string, unknown>) {
      const patch = JSON.stringify({ spec: { resources: { requests: { storage: String(args.newSize) } } } })
      return kubectl([
        'patch', 'pvc', String(args.name),
        '-n', String(args.namespace),
        '--type=merge', '-p', patch,
      ])
    },
  },
  {
    name: 'pvc_snapshot',
    description: 'Create a VolumeSnapshot of a PVC (requires the CSI snapshot controller)',
    inputSchema: {
      type: 'object',
      properties: {
        namespace:    { type: 'string', description: 'Namespace of the source PVC' },
        name:         { type: 'string', description: 'Source PVC name' },
        snapshotName: { type: 'string', description: 'Name for the new VolumeSnapshot' },
        snapshotClass: { type: 'string', description: 'VolumeSnapshotClass name (optional — uses cluster default if omitted)' },
      },
      required: ['namespace', 'name', 'snapshotName'],
    },
    async execute(args: Record<string, unknown>) {
      const snapClassLine = args.snapshotClass
        ? `\n  volumeSnapshotClassName: ${String(args.snapshotClass)}`
        : ''
      const manifest = `apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: ${String(args.snapshotName)}
  namespace: ${String(args.namespace)}
spec:${snapClassLine}
  source:
    persistentVolumeClaimName: ${String(args.name)}
`
      const tmp = `/tmp/orion-snapshot-${randomUUID()}.yaml`
      writeFileSync(tmp, manifest, 'utf8')
      try {
        return await kubectl(['apply', '-f', tmp])
      } finally {
        try { unlinkSync(tmp) } catch { /* ignore */ }
      }
    },
  },
  {
    name: 'pvc_list_snapshots',
    description: 'List VolumeSnapshots',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace (omit for all namespaces)' },
      },
    },
    async execute(args: Record<string, unknown>) {
      const cmd = ['get', 'volumesnapshots']
      if (args.namespace) cmd.push('-n', String(args.namespace))
      else cmd.push('-A')
      return kubectl(cmd)
    },
  },
  {
    name: 'pvc_delete_unused',
    description: 'List Released or Lost PersistentVolumes for agent review (does NOT auto-delete — surfaces candidates for cleanup)',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>) {
      const json = await kubectl(['get', 'pv', '-o', 'json'])
      const list = JSON.parse(json) as {
        items?: Array<{
          metadata?: { name?: string }
          status?: { phase?: string }
          spec?: { capacity?: { storage?: string }; storageClassName?: string; claimRef?: { namespace?: string; name?: string } }
        }>
      }
      const candidates = (list.items ?? []).filter((pv) => {
        const phase = pv.status?.phase
        return phase === 'Released' || phase === 'Failed' || phase === 'Lost'
      })
      if (candidates.length === 0) return 'No Released/Failed/Lost PVs found — nothing to clean up.'
      const lines = candidates.map((pv) => {
        const name = pv.metadata?.name ?? '-'
        const phase = pv.status?.phase ?? '-'
        const size = pv.spec?.capacity?.storage ?? '-'
        const sc = pv.spec?.storageClassName ?? '-'
        const claim = pv.spec?.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : '-'
        return `${name}  phase=${phase}  size=${size}  storageClass=${sc}  formerClaim=${claim}`
      })
      return [
        `Found ${candidates.length} PV(s) eligible for review (NOT auto-deleted):`,
        ...lines,
        '',
        'Review each PV before deleting. Use kubectl_delete with resource=pv to remove.',
      ].join('\n')
    },
  },
] as const).map(t => ({ ...t, category: 'storage' as const }))
