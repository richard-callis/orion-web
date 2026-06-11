/**
 * POST /api/monitoring/security/demo-events
 *
 * Injects a batch of realistic sample security events for demo/testing.
 * Creates events without requiring external integrations.
 */
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

function randIp() {
  return `${10 + Math.floor(Math.random() * 245)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`
}

function ago(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000)
}

export async function POST() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  // Get first available environment (or null for global events)
  const env = await prisma.environment.findFirst({ select: { id: true } })
  const envId = env?.id ?? null

  const attackerIp = randIp()
  const now = Date.now()

  const events = [
    // Brute force sequence
    ...Array.from({ length: 8 }, (_, i) => ({
      type: 'auth_failure',
      source: 'wazuh',
      severity: 55,
      title: `Failed SSH login from ${attackerIp}`,
      description: `Authentication failure for user root from ${attackerIp} (attempt ${i + 1})`,
      attackerIp,
      dedupKey: `demo-brute-${attackerIp}-${i}-${now}`,
      firstSeen: ago(10 - i),
      lastSeen: ago(10 - i),
    })),
    // CrowdSec block
    {
      type: 'crowdsec_block',
      source: 'crowdsec',
      severity: 65,
      title: `IP ${attackerIp} blocked by CrowdSec`,
      description: `CrowdSec community blocklist match: known scanner/brute-force source`,
      attackerIp,
      dedupKey: `demo-crowdsec-${attackerIp}-${now}`,
      firstSeen: ago(8),
      lastSeen: ago(8),
    },
    // Port scan
    ...Array.from({ length: 25 }, (_, i) => ({
      type: 'connection_refused',
      source: 'ntopng',
      severity: 40,
      title: `Port scan detected from ${randIp()}`,
      description: `Connection refused on port ${1024 + i * 100}`,
      attackerIp: randIp(),
      dedupKey: `demo-portscan-${i}-${now}`,
      firstSeen: ago(15),
      lastSeen: ago(15),
    })),
    // K8s warnings
    {
      type: 'k8s_warning',
      source: 'k8s_events',
      severity: 45,
      title: 'Pod OOMKilled in namespace production',
      description: 'Container memory limit exceeded, process killed',
      dedupKey: `demo-k8s-oom-${now}`,
      firstSeen: ago(5),
      lastSeen: ago(5),
    },
    {
      type: 'k8s_warning',
      source: 'k8s_events',
      severity: 50,
      title: 'ImagePullBackOff: suspicious image tag in namespace default',
      description: 'Unknown image tag pulled from external registry',
      dedupKey: `demo-k8s-image-${now}`,
      firstSeen: ago(3),
      lastSeen: ago(3),
    },
    // Anomaly
    {
      type: 'anomaly',
      source: 'elk',
      severity: 60,
      title: 'Unusual outbound traffic spike detected',
      description: 'Network baseline deviation: 5x normal egress volume in last 10 minutes',
      attackerIp: randIp(),
      dedupKey: `demo-anomaly-${now}`,
      firstSeen: ago(2),
      lastSeen: ago(2),
    },
    // High-severity malware signal
    {
      type: 'malware',
      source: 'wazuh',
      severity: 90,
      title: 'Malware signature match on web-01',
      description: 'File /tmp/.svc matches known trojan dropper signature (EICAR-like)',
      attackerIp: '10.0.0.1',
      dedupKey: `demo-malware-${now}`,
      firstSeen: ago(1),
      lastSeen: ago(1),
    },
  ]

  let inserted = 0
  for (const ev of events) {
    const { attackerIp: aIp, ...rest } = ev as any
    await prisma.securityEvent.create({
      data: {
        environmentId: envId,
        type: rest.type,
        source: rest.source,
        severity: rest.severity,
        title: rest.title,
        description: rest.description ?? null,
        rawEvent: { demo: true, attackerIp: aIp ?? null },
        dedupKey: rest.dedupKey,
        firstSeen: rest.firstSeen,
        lastSeen: rest.lastSeen,
      },
    })
    inserted++
  }

  return NextResponse.json({ inserted, message: `Injected ${inserted} demo security events` })
}
