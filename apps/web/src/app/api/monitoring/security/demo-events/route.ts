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

interface DemoEvent {
  type: string
  source: string
  severity: number
  title: string
  description: string
  attackerIp?: string
  dedupKey: string
  firstSeen: Date
  lastSeen: Date
}

function randIp() {
  return `${10 + Math.floor(Math.random() * 245)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`
}

function ago(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000)
}

export async function POST() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const env = await prisma.environment.findFirst({ select: { id: true } })
  const envId = env?.id ?? null

  const attackerIp = randIp()
  // Port scanner uses a single IP so the threshold rule (groupBy attackerIp, threshold 20) fires
  const scannerIp = randIp()
  // Dedup key uses today's date (not ms timestamp) so repeated clicks in the same
  // day return 409-style skips rather than flooding the table with duplicate events.
  const today = new Date().toISOString().slice(0, 10)

  const events: DemoEvent[] = [
    // Brute force sequence — same IP, fires brute_force rule (threshold 5 in 300s)
    ...Array.from({ length: 8 }, (_, i): DemoEvent => ({
      type: 'auth_failure',
      source: 'wazuh',
      severity: 55,
      title: `Failed SSH login from ${attackerIp}`,
      description: `Authentication failure for user root from ${attackerIp} (attempt ${i + 1})`,
      attackerIp,
      dedupKey: `demo-brute-${attackerIp}-${i}-${today}`,
      firstSeen: ago(10 - i * 0.5),
      lastSeen: ago(10 - i * 0.5),
    })),
    // CrowdSec block — fires crowdsec_block pattern rule
    {
      type: 'crowdsec_block',
      source: 'crowdsec',
      severity: 65,
      title: `IP ${attackerIp} blocked by CrowdSec`,
      description: 'CrowdSec community blocklist match: known scanner/brute-force source',
      attackerIp,
      dedupKey: `demo-crowdsec-${attackerIp}-${today}`,
      firstSeen: ago(8),
      lastSeen: ago(8),
    },
    // Port scan — 25 events from the SAME IP fires port_scan threshold rule (>20 in 120s)
    ...Array.from({ length: 25 }, (_, i): DemoEvent => ({
      type: 'connection_refused',
      source: 'ntopng',
      severity: 40,
      title: `Port scan detected from ${scannerIp}`,
      description: `Connection refused on port ${1024 + i * 100}`,
      attackerIp: scannerIp,
      dedupKey: `demo-portscan-${scannerIp}-${i}-${today}`,
      firstSeen: ago(1),
      lastSeen: ago(1),
    })),
    // K8s warnings
    {
      type: 'k8s_warning',
      source: 'k8s_events',
      severity: 45,
      title: 'Pod OOMKilled in namespace production',
      description: 'Container memory limit exceeded, process killed',
      dedupKey: `demo-k8s-oom-${today}`,
      firstSeen: ago(5),
      lastSeen: ago(5),
    },
    {
      type: 'k8s_warning',
      source: 'k8s_events',
      severity: 50,
      title: 'ImagePullBackOff: suspicious image tag in namespace default',
      description: 'Unknown image tag pulled from external registry',
      dedupKey: `demo-k8s-image-${today}`,
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
      attackerIp,
      dedupKey: `demo-anomaly-${today}`,
      firstSeen: ago(2),
      lastSeen: ago(2),
    },
    // High-severity malware signal — fires malware_detection pattern rule
    {
      type: 'malware',
      source: 'wazuh',
      severity: 90,
      title: 'Malware signature match on web-01',
      description: 'File /tmp/.svc matches known trojan dropper signature (EICAR-like)',
      attackerIp: '10.0.0.1',
      dedupKey: `demo-malware-${today}`,
      firstSeen: ago(1),
      lastSeen: ago(1),
    },
  ]

  // Skip events that already have their dedupKey to prevent repeat-click flooding
  const existingKeys = new Set(
    (await prisma.securityEvent.findMany({
      where: { dedupKey: { in: events.map(e => e.dedupKey) } },
      select: { dedupKey: true },
    })).map(r => r.dedupKey)
  )
  const toInsert = events.filter(e => !existingKeys.has(e.dedupKey))
  if (toInsert.length === 0) {
    return NextResponse.json({ inserted: 0, message: 'Demo events already injected today — no duplicates created' })
  }

  try {
    await prisma.$transaction(
      toInsert.map(ev =>
        prisma.securityEvent.create({
          data: {
            environmentId: envId,
            type: ev.type,
            source: ev.source,
            severity: ev.severity,
            title: ev.title,
            description: ev.description,
            rawEvent: { demo: true, attackerIp: ev.attackerIp ?? null },
            dedupKey: ev.dedupKey,
            firstSeen: ev.firstSeen,
            lastSeen: ev.lastSeen,
          },
        })
      )
    )
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }

  return NextResponse.json({ inserted: toInsert.length, message: `Injected ${toInsert.length} demo security events` })
}
