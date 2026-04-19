/**
 * Built-in Talos tools for ORION Gateway.
 * Provides talosctl-based operations for Talos cluster management.
 * The caller must supply a base64-encoded talosconfig as `talosConfig` in args.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'

const exec = promisify(execFile)

async function talosctl(
  args: string[],
  talosConfigB64: string,
  timeoutMs = 60_000,
): Promise<string> {
  const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
  writeFileSync(tmpFile, Buffer.from(talosConfigB64, 'base64').toString('utf8'), 'utf8')
  try {
    const { stdout, stderr } = await exec('talosctl', args, { timeout: timeoutMs })
    return stdout || stderr
  } finally {
    try { unlinkSync(tmpFile) } catch { /* ignore */ }
  }
}

function withConfig(talosConfigB64: string, args: string[]): string[] {
  const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
  writeFileSync(tmpFile, Buffer.from(talosConfigB64, 'base64').toString('utf8'), 'utf8')
  return ['--talosconfig', tmpFile, ...args]
}

export const talosTools = [
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
      const cfg = String(args.talosConfig)
      const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
      writeFileSync(tmpFile, Buffer.from(cfg, 'base64').toString('utf8'), 'utf8')
      try {
        const { stdout, stderr } = await exec('talosctl', [
          '--talosconfig', tmpFile,
          '--nodes', String(args.nodeIp),
          '--endpoints', String(args.nodeIp),
          'version',
        ], { timeout: 15_000 })
        return stdout || stderr
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
      }
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
      const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
      writeFileSync(tmpFile, Buffer.from(String(args.talosConfig), 'base64').toString('utf8'), 'utf8')
      try {
        const { stdout, stderr } = await exec('talosctl', [
          '--talosconfig', tmpFile,
          '--nodes', String(args.nodeIp),
          '--endpoints', String(args.nodeIp),
          'get', 'extensions', '-o', 'json',
        ], { timeout: 20_000 })
        return stdout || stderr
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
      }
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
      const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
      writeFileSync(tmpFile, Buffer.from(String(args.talosConfig), 'base64').toString('utf8'), 'utf8')
      try {
        const { stdout, stderr } = await exec('talosctl', [
          '--talosconfig', tmpFile,
          '--nodes', String(args.nodeIp),
          '--endpoints', String(args.nodeIp),
          'patch', 'machineconfig',
          '--patch', String(args.patch),
        ], { timeout: 30_000 })
        return stdout || stderr
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
      }
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
      const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
      writeFileSync(tmpFile, Buffer.from(String(args.talosConfig), 'base64').toString('utf8'), 'utf8')
      const preserve = args.preserve !== false
      try {
        const { stdout, stderr } = await exec('talosctl', [
          '--talosconfig', tmpFile,
          '--nodes', String(args.nodeIp),
          '--endpoints', String(args.nodeIp),
          'upgrade',
          '--image', String(args.installerImage),
          preserve ? '--preserve' : '--no-preserve',
          '--wait',
        ], { timeout: 600_000 }) // 10 min — upgrades take time
        return stdout || stderr
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
      }
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
      const tmpFile = `/tmp/orion-talosconfig-${Date.now()}.yaml`
      writeFileSync(tmpFile, Buffer.from(String(args.talosConfig), 'base64').toString('utf8'), 'utf8')
      try {
        const { stdout, stderr } = await exec('talosctl', [
          '--talosconfig', tmpFile,
          '--nodes', String(args.nodeIp),
          '--endpoints', String(args.nodeIp),
          'reboot',
          '--wait',
        ], { timeout: 300_000 }) // 5 min
        return stdout || stderr
      } finally {
        try { unlinkSync(tmpFile) } catch { /* ignore */ }
      }
    },
  },
]
