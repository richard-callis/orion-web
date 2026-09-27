import * as k8s from '@kubernetes/client-node'
import * as net from 'net'
import { coreApi } from './k8s'
import { isK8sConflict, isK8sNotFound } from './k8s-errors'

const MAX_RETRIES = 3

export interface DnsEntry {
  ip: string
  hostnames: string[]
}

// ── CoreDNS ConfigMap access ──────────────────────────────────────────────────

async function getConfigMap(name: string, ns = 'kube-system'): Promise<k8s.V1ConfigMap> {
  return coreApi.readNamespacedConfigMap({ name, namespace: ns })
}

// resourceVersion in the patch makes the API server reject a stale write with
// 409, which the callers below retry.
async function patchConfigMap(name: string, ns: string, data: Record<string, string>, resourceVersion: string) {
  const body = { metadata: { resourceVersion }, data }
  await coreApi.patchNamespacedConfigMap(
    { name, namespace: ns, body },
    k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
  )
}

// ── NodeHosts (built-in CoreDNS hosts entries) ────────────────────────────────

export function parseNodeHosts(content: string | undefined): DnsEntry[] {
  if (!content) return []
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const parts = l.split(/\s+/)
      return { ip: parts[0], hostnames: parts.slice(1) }
    })
    .filter(e => e.ip && e.hostnames.length > 0)
}

export function serializeNodeHosts(entries: DnsEntry[]): string {
  return entries.map(e => `${e.ip} ${e.hostnames.join(' ')}`).join('\n') + '\n'
}


// Validate IP and hostnames to prevent Corefile injection via newline/whitespace
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/

function validateIp(ip: string): boolean {
  return net.isIP(ip) !== 0
}
function validateHostname(h: string): boolean {
  return HOSTNAME_RE.test(h)
}


export async function getNodeHosts(): Promise<DnsEntry[]> {
  const cm = await getConfigMap('coredns')
  return parseNodeHosts(cm.data?.['NodeHosts'])
}

export async function upsertNodeHost(ip: string, hostnames: string[]): Promise<void> {
  if (!validateIp(ip) || !hostnames.every(validateHostname)) throw new Error("Invalid IP or hostname")
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const cm = await getConfigMap('coredns')
      const entries = parseNodeHosts(cm.data?.['NodeHosts'])
      const idx = entries.findIndex(e => e.ip === ip)
      if (idx >= 0) entries[idx] = { ip, hostnames }
      else entries.push({ ip, hostnames })
      await patchConfigMap('coredns', 'kube-system', { ...cm.data, NodeHosts: serializeNodeHosts(entries) }, cm.metadata!.resourceVersion!)
      return
    } catch (err: unknown) {
      if (isK8sConflict(err) && i < MAX_RETRIES - 1) continue
      throw err
    }
  }
}

export async function deleteNodeHost(ip: string): Promise<boolean> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const cm = await getConfigMap('coredns')
      const entries = parseNodeHosts(cm.data?.['NodeHosts'])
      const filtered = entries.filter(e => e.ip !== ip)
      if (filtered.length === entries.length) return false
      await patchConfigMap('coredns', 'kube-system', { ...cm.data, NodeHosts: serializeNodeHosts(filtered) }, cm.metadata!.resourceVersion!)
      return true
    } catch (err: unknown) {
      if (isK8sConflict(err) && i < MAX_RETRIES - 1) continue
      throw err
    }
  }
  return false
}

// ── Custom Records (coredns-custom ConfigMap) ─────────────────────────────────

export function parseCustomHosts(content: string | undefined): DnsEntry[] {
  if (!content) return []
  const entries: DnsEntry[] = []
  let inHosts = false
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t === 'hosts {') { inHosts = true; continue }
    if (t === '}') { inHosts = false; continue }
    if (!inHosts || t === 'fallthrough' || t.startsWith('#')) continue
    const parts = t.split(/\s+/)
    if (parts.length >= 2) entries.push({ ip: parts[0], hostnames: parts.slice(1) })
  }
  return entries
}

export function serializeCustomHosts(entries: DnsEntry[]): string {
  if (!entries.length) return 'hosts {\n  fallthrough\n}\n'
  return ['hosts {', ...entries.map(e => `  ${e.ip} ${e.hostnames.join(' ')}`), '  fallthrough', '}'].join('\n') + '\n'
}

async function getOrCreateCustomConfigMap(): Promise<k8s.V1ConfigMap> {
  try {
    return await getConfigMap('coredns-custom')
  } catch (err) {
    // Only create when it genuinely doesn't exist — auth/network errors must
    // surface, not trigger a create attempt.
    if (!isK8sNotFound(err)) throw err
    try {
      await coreApi.createNamespacedConfigMap({
        namespace: 'kube-system',
        body: {
          metadata: { name: 'coredns-custom', namespace: 'kube-system' },
          data: { 'custom.server': serializeCustomHosts([]) },
        },
      })
    } catch (createErr) {
      // Another request created it concurrently — fine, read it below.
      if (!isK8sConflict(createErr)) throw createErr
    }
    return getConfigMap('coredns-custom')
  }
}

export async function getCustomRecords(): Promise<DnsEntry[]> {
  const cm = await getOrCreateCustomConfigMap()
  return parseCustomHosts(cm.data?.['custom.server'])
}

export async function upsertCustomRecord(ip: string, hostnames: string[]): Promise<void> {
  if (!validateIp(ip) || !hostnames.every(validateHostname)) throw new Error("Invalid IP or hostname")
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const cm = await getOrCreateCustomConfigMap()
      const entries = parseCustomHosts(cm.data?.['custom.server'])
      const idx = entries.findIndex(e => e.ip === ip)
      if (idx >= 0) entries[idx] = { ip, hostnames }
      else entries.push({ ip, hostnames })
      await patchConfigMap('coredns-custom', 'kube-system', { 'custom.server': serializeCustomHosts(entries) }, cm.metadata!.resourceVersion!)
      return
    } catch (err: unknown) {
      if (isK8sConflict(err) && i < MAX_RETRIES - 1) continue
      throw err
    }
  }
}

export async function deleteCustomRecord(ip: string): Promise<boolean> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const cm = await getOrCreateCustomConfigMap()
      const entries = parseCustomHosts(cm.data?.['custom.server'])
      const filtered = entries.filter(e => e.ip !== ip)
      if (filtered.length === entries.length) return false
      await patchConfigMap('coredns-custom', 'kube-system', { 'custom.server': serializeCustomHosts(filtered) }, cm.metadata!.resourceVersion!)
      return true
    } catch (err: unknown) {
      if (isK8sConflict(err) && i < MAX_RETRIES - 1) continue
      throw err
    }
  }
  return false
}
