/**
 * POST /api/monitoring/security/seed-rules
 *
 * Seeds default correlation rules for common attack patterns.
 * Safe to call multiple times — uses upsert by name.
 */
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

const DEFAULT_RULES = [
  {
    name: 'brute_force',
    ruleType: 'threshold',
    severity: 75,
    window: 300,
    params: { eventType: 'auth_failure', threshold: 5, groupBy: 'attackerIp' },
  },
  {
    name: 'port_scan',
    ruleType: 'threshold',
    severity: 60,
    window: 120,
    params: { eventType: 'connection_refused', threshold: 20, groupBy: 'attackerIp' },
  },
  {
    name: 'malware_detection',
    ruleType: 'pattern',
    severity: 90,
    window: 60,
    params: { eventTypes: ['malware', 'trojan', 'ransomware'], matchAny: true },
  },
  {
    name: 'k8s_warning_burst',
    ruleType: 'threshold',
    severity: 50,
    window: 300,
    params: { source: 'k8s_events', threshold: 10, groupBy: 'namespace' },
  },
  {
    name: 'crowdsec_block',
    ruleType: 'pattern',
    severity: 65,
    window: 60,
    params: { eventTypes: ['crowdsec_block'], matchAny: true },
  },
  {
    name: 'anomaly_cluster',
    ruleType: 'threshold',
    severity: 55,
    window: 600,
    params: { eventType: 'anomaly', threshold: 3, groupBy: 'attackerIp' },
  },
  {
    name: 'privilege_escalation',
    ruleType: 'pattern',
    severity: 85,
    window: 60,
    params: { eventTypes: ['privilege_escalation', 'sudo_abuse', 'container_escape'], matchAny: true },
  },
  {
    name: 'data_exfil',
    ruleType: 'threshold',
    severity: 80,
    window: 300,
    params: { eventType: 'large_outbound', threshold: 3, groupBy: 'sourceIp' },
  },
]

export async function POST() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const results = await Promise.all(
    DEFAULT_RULES.map(rule =>
      prisma.correlationRule.upsert({
        where: { name: rule.name },
        update: {},
        create: {
          name: rule.name,
          ruleType: rule.ruleType,
          severity: rule.severity,
          window: rule.window,
          params: rule.params,
          enabled: true,
        },
      })
    )
  )

  return NextResponse.json({ seeded: results.length, rules: results.map(r => r.name) })
}

export async function GET() {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const rules = await prisma.correlationRule.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, ruleType: true, severity: true, enabled: true, window: true },
  })

  return NextResponse.json({ rules })
}
