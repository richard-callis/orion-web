import { execFile } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execFile)

/**
 * Velero backup & recovery tools. Implemented as a thin `velero` CLI wrapper
 * (the velero binary talks to the in-cluster Velero server via the kubeconfig
 * available to the gateway). Critical for disaster recovery.
 */
async function velero(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout, stderr } = await exec('velero', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })
  return stdout || stderr
}

export const backupTools = ([
  {
    name: 'velero_list_backups',
    description: 'List all Velero backups with status and age',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>) {
      return velero(['backup', 'get'])
    },
  },
  {
    name: 'velero_create_backup',
    description: 'Trigger an on-demand Velero backup',
    inputSchema: {
      type: 'object',
      properties: {
        name:       { type: 'string', description: 'Backup name' },
        namespaces: { type: 'array', items: { type: 'string' }, description: 'Namespaces to include (omit for all)' },
        ttl:        { type: 'string', description: 'Backup retention, e.g. 720h0m0s (default Velero policy)' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>) {
      const cmd = ['backup', 'create', String(args.name)]
      const namespaces = Array.isArray(args.namespaces) ? (args.namespaces as string[]) : []
      if (namespaces.length > 0) cmd.push('--include-namespaces', namespaces.join(','))
      if (args.ttl) cmd.push('--ttl', String(args.ttl))
      return velero(cmd)
    },
  },
  {
    name: 'velero_describe_backup',
    description: 'Show detailed status and errors for a Velero backup',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Backup name' },
      },
      required: ['name'],
    },
    async execute(args: Record<string, unknown>) {
      return velero(['backup', 'describe', String(args.name), '--details'])
    },
  },
  {
    name: 'velero_restore',
    description: 'Initiate a restore from a Velero backup',
    inputSchema: {
      type: 'object',
      properties: {
        backupName:      { type: 'string', description: 'Name of the backup to restore from' },
        targetNamespace: { type: 'string', description: 'Restore only this namespace (omit to restore everything in the backup)' },
      },
      required: ['backupName'],
    },
    async execute(args: Record<string, unknown>) {
      const cmd = ['restore', 'create', '--from-backup', String(args.backupName), '--wait']
      if (args.targetNamespace) cmd.push('--include-namespaces', String(args.targetNamespace))
      return velero(cmd)
    },
  },
  {
    name: 'velero_list_schedules',
    description: 'Show scheduled Velero backup policies',
    inputSchema: { type: 'object', properties: {} },
    async execute(_args: Record<string, unknown>) {
      return velero(['schedule', 'get'])
    },
  },
] as const).map(t => ({ ...t, category: 'backup' as const }))
