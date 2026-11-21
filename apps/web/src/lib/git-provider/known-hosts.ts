/**
 * Host keys for SSH clones that ArgoCD can't verify out of the box (H2).
 *
 * ArgoCD ships github.com's host keys but not the bundled Gitea's, and an
 * unverified host key fails the clone (ArgoCD never accepts unknown hosts). The
 * bundled Gitea runs on ORION's own compose network, so ORION reads its keys
 * there (ssh-keyscan to the `gitea` service on its internal port 22) and hands
 * them to the gateway as known_hosts lines for the address clusters dial,
 * [MANAGEMENT_IP]:<ssh port>. The gateway pins them in argocd-ssh-known-hosts-cm.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitProviderConfig } from './index'
import { bundledGiteaSshPort, type CloneOptions } from './scoped-credentials'

const exec = promisify(execFile)

/** One known_hosts line we accept: host, a key type, base64 key. Nothing else. */
const KEY_LINE = /^(\S+) (ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) ([A-Za-z0-9+/]+={0,2})$/

/**
 * Turn ssh-keyscan output into known_hosts lines for `host`: comments and
 * anything unexpected are dropped, duplicates removed, order kept.
 */
export function knownHostsFor(keyscanOutput: string, host: string): string[] {
  const out: string[] = []
  for (const raw of keyscanOutput.split('\n')) {
    const m = KEY_LINE.exec(raw.trim())
    if (!m) continue
    const line = `${host} ${m[2]} ${m[3]}`
    if (!out.includes(line)) out.push(line)
  }
  return out
}

let cache: { at: number; lines: string[] } | null = null
const CACHE_MS = 10 * 60_000

/** For tests. */
export function resetKnownHostsCache(): void { cache = null }

/**
 * known_hosts lines for the clone URL scopedRepoUrl() gives this provider, or
 * [] when ArgoCD already knows the host (github.com) or the clone is HTTPS.
 * Throws when the bundled Gitea's keys can't be read: handing out an SSH
 * credential without its host key would only fail later, inside ArgoCD.
 */
export async function providerKnownHosts(config: GitProviderConfig, opts: CloneOptions = {}): Promise<string[]> {
  if (config.type !== 'gitea-bundled' || !opts.bundledGiteaSsh) return []
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.lines
  const ip = process.env.MANAGEMENT_IP
  if (!ip) throw new Error('MANAGEMENT_IP not set — cannot name the Gitea SSH host for ArgoCD')
  const internalHost = process.env.GITEA_SSH_INTERNAL_HOST ?? 'gitea'
  const { stdout } = await exec('ssh-keyscan', ['-T', '5', '-p', '22', '--', internalHost], { timeout: 15_000 })
  const lines = knownHostsFor(stdout, `[${ip}]:${bundledGiteaSshPort()}`)
  if (lines.length === 0) throw new Error(`ssh-keyscan returned no host keys for ${internalHost}:22`)
  cache = { at: Date.now(), lines }
  return lines
}
