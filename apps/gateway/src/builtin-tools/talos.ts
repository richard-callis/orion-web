/**
 * Built-in Talos tools for ORION Gateway.
 * Provides talosctl-based operations for Talos cluster management.
 * The caller must supply a base64-encoded talosconfig as `talosConfig` in args.
 */
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'
import { runOut } from '../lib/run.js'
import { withValidation, hostOrIp, imageRef, ArgValidationError } from '../lib/validate-args.js'

/**
 * Run talosctl against one node with a temporary talosconfig.
 *
 * Unique temp file name (randomUUID) prevents collisions under concurrent calls;
 * mode 0600 keeps the credentials unreadable by other users. The node address is
 * validated so it cannot be read as a talosctl flag.
 */
async function talosctl(args: Record<string, unknown>, sub: string[], timeoutMs: number): Promise<string> {
  const node = hostOrIp('nodeIp', args.nodeIp)
  const tmpFile = `/tmp/orion-talosconfig-${randomUUID()}.yaml`
  writeFileSync(tmpFile, Buffer.from(String(args.talosConfig ?? ''), 'base64').toString('utf8'), { encoding: 'utf8', mode: 0o600 })
  try {
    return await runOut('talosctl', ['--talosconfig', tmpFile, '--nodes', node, '--endpoints', node, ...sub], { timeoutMs })
  } finally {
    try { unlinkSync(tmpFile) } catch { /* ignore */ }
  }
}

/** talosctl --patch accepts `@file` to read a local file — never allow that from an agent. */
function patchArg(value: unknown): string {
  const s = String(value ?? '').trim()
  if (!s) throw new ArgValidationError(`Invalid argument 'patch': is required`)
  if (s.startsWith('@') || s.startsWith('-')) {
    throw new ArgValidationError(`Invalid argument 'patch': must be inline JSON, not a file reference or flag`)
  }
  return s
}

export const talosTools = ([
  {
    name: 'talos_get_version',
    description: 'Get Talos version info for a node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
      },
      required: ['nodeIp', 'talosConfig'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(() => talosctl(args, ['version'], 15_000))
    },
  },

  {
    name: 'talos_get_extensions',
    description: 'List installed Talos system extensions on a node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
      },
      required: ['nodeIp', 'talosConfig'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(() => talosctl(args, ['get', 'extensions', '-o', 'json'], 20_000))
    },
  },

  {
    name: 'talos_patch_machineconfig',
    description: 'Apply a JSON patch to the Talos machine config on a node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
        patch:       { type: 'string', description: 'JSON patch array (RFC 6902)' },
      },
      required: ['nodeIp', 'talosConfig', 'patch'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(() => talosctl(args, ['patch', 'machineconfig', `--patch=${patchArg(args.patch)}`], 30_000))
    },
  },

  {
    name: 'talos_upgrade',
    description: 'Upgrade a Talos node to a new installer image (applies pending config changes, reboots)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:         { type: 'string', description: 'Node IP address' },
        talosConfig:    { type: 'string', description: 'Base64-encoded talosconfig content' },
        installerImage: { type: 'string', description: 'Talos installer image, e.g. factory.talos.dev/installer/<id>:v1.9.5' },
        preserve:       { type: 'boolean', description: 'Preserve data across upgrade (default true)' },
      },
      required: ['nodeIp', 'talosConfig', 'installerImage'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(() => {
        const preserve = args.preserve !== false
        return talosctl(args, [
          'upgrade',
          `--image=${imageRef('installerImage', args.installerImage)}`,
          preserve ? '--preserve' : '--no-preserve',
          '--wait',
        ], 600_000) // 10 min — upgrades take time
      })
    },
  },

  {
    name: 'talos_reboot',
    description: 'Reboot a Talos node (applies pending config changes)',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIp:      { type: 'string', description: 'Node IP address' },
        talosConfig: { type: 'string', description: 'Base64-encoded talosconfig content' },
      },
      required: ['nodeIp', 'talosConfig'],
    },
    async execute(args: Record<string, unknown>) {
      return withValidation(() => talosctl(args, ['reboot', '--wait'], 300_000)) // 5 min
    },
  },
] as const).map(t => ({ ...t, category: 'talos' as const }))
