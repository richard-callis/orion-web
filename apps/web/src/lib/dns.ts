import * as k8s from '@kubernetes/client-node'
import { kubeConfig } from './k8s'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const coreApi: any = kubeConfig.makeApiClient(k8s.CoreV1Api)
const MAX_RETRIES = 3

export interface DnsEntry {
  ip: string
  hostnames: string[]
}

// ── CoreDNS ConfigMap access ──────────────────────────────────────────────────

async function getConfigMap(name: string, ns = 'kube-system') {
  const res = await coreApi.readNamespacedConfigMap(name, ns)
  return res.body as k8s.V1ConfigMap
}

async function patchConfigMap(name: string, ns: string, data: Record<string, string>, resourceVersion: string) {
  const patch = { metadata: { resourceVersion }, data }
  const options = { headers: { 'Content-Type': 'application/merge-patch+json' } }
  await coreApi.patchNamespacedConfigMap(name, ns, patch, undefined, undefined, undefined, undefined, options)
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

export async function getNodeHosts(): Promise<DnsEntry[]> {
  const cm = await getConfigMap('coredns')
  return parseNodeHosts(cm.data?.['NodeHosts'])
}

export async function upsertNodeHost(ip: string, hostnames: string[]): Promise<void> {
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
      if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 409 && i < MAX_RETRIES - 1) continue
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
      if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 409 && i < MAX_RETRIES - 1) continue
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
    const res = await coreApi.readNamespacedConfigMap('coredns-custom', 'kube-system')
    return res.body as k8s.V1ConfigMap
  } catch {
    await coreApi.createNamespacedConfigMap('kube-system', {
      metadata: { name: 'coredns-custom', namespace: 'kube-system' },
      data: { 'custom.server': serializeCustomHosts([]) },
    })
    const res = await coreApi.readNamespacedConfigMap('coredns-custom', 'kube-system')
    return res.body as k8s.V1ConfigMap
  }
}

export async function getCustomRecords(): Promise<DnsEntry[]> {
  const cm = await getOrCreateCustomConfigMap()
  return parseCustomHosts(cm.data?.['custom.server'])
}

export async function upsertCustomRecord(ip: string, hostnames: string[]): Promise<void> {
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
      if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 409 && i < MAX_RETRIES - 1) continue
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
      if ((err as { response?: { statusCode?: number } })?.response?.statusCode === 409 && i < MAX_RETRIES - 1) continue
      throw err
    }
  }
  return false
}
