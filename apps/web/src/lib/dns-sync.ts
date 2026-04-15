/**
 * Generates a CoreDNS zone file from DnsRecord rows and syncs it to the
 * target environment via the Gateway.
 *
 * K8s  → kubectl_apply_manifest (ConfigMap coredns-orion-zones / kube-system)
 * Docker → docker_exec to write the zone file into the CoreDNS container
 */

import { prisma } from '@/lib/db'

interface GatewayExecFn {
  (toolName: string, args: Record<string, unknown>): Promise<string>
}

// ── Zone file generation ──────────────────────────────────────────────────────

export function buildZoneFile(domainName: string, records: { ip: string; hostnames: string[] }[], serial?: number): string {
  const sn = serial ?? Math.floor(Date.now() / 1000)
  const lines = [
    `$ORIGIN ${domainName}.`,
    `@ 3600 IN SOA ns1.${domainName}. admin.${domainName}. ${sn} 7200 900 1209600 86400`,
    `@ 3600 IN NS ns1.${domainName}.`,
    '',
  ]
  for (const rec of records) {
    for (const h of rec.hostnames) {
      // Strip domain suffix for relative names, keep wildcard as-is
      const rel = h === `*.${domainName}` ? '*'
        : h.endsWith(`.${domainName}`) ? h.slice(0, -(domainName.length + 1))
        : h === domainName ? '@'
        : h
      lines.push(`${rel} 60 IN A ${rec.ip}`)
    }
  }
  return lines.join('\n') + '\n'
}

// ── K8s sync ──────────────────────────────────────────────────────────────────

export async function syncToKubernetes(
  gatewayExec: GatewayExecFn,
  domainName: string,
  zoneContent: string,
): Promise<void> {
  const manifest = `apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns-orion-zones
  namespace: kube-system
  labels:
    managed-by: orion
data:
  ${domainName}.db: |
${zoneContent.split('\n').map(l => '    ' + l).join('\n')}
`
  await gatewayExec('kubectl_apply_manifest', { manifest })
}

// ── Docker sync ───────────────────────────────────────────────────────────────

export async function syncToDocker(
  gatewayExec: GatewayExecFn,
  domainName: string,
  zoneContent: string,
): Promise<void> {
  // Write zone file into the running coredns container
  const escaped = zoneContent.replace(/'/g, `'"'"'`)
  await gatewayExec('docker_exec', {
    container: 'coredns',
    command:   `sh -c 'mkdir -p /etc/coredns/zones && printf '"'"'${escaped}'"'"' > /etc/coredns/zones/${domainName}.db'`,
  })
}

// ── Full sync (reads DB, pushes to gateway) ───────────────────────────────────

export async function syncDomainDns(
  domainId: string,
  gatewayExec: GatewayExecFn,
  envType: string,
): Promise<void> {
  const records = await prisma.dnsRecord.findMany({
    where: { domainId, enabled: true },
  })
  const domain = await prisma.domain.findUnique({ where: { id: domainId } })
  if (!domain) throw new Error('Domain not found')

  const zoneContent = buildZoneFile(
    domain.name,
    records.map(r => ({ ip: r.ip, hostnames: r.hostnames })),
  )

  if (envType === 'docker') {
    await syncToDocker(gatewayExec, domain.name, zoneContent)
  } else {
    await syncToKubernetes(gatewayExec, domain.name, zoneContent)
  }
}
