/**
 * Default correlation rules seed — runs on startup via instrumentation.ts.
 *
 * Seeds the default correlation rules for security event processing.
 * Rules are environment-scoped and follow SIEM_PLAN.md tier matrix.
 */

import { prisma } from './db'

/**
 * Default correlation rules seeded at startup.
 * These rules are the same for all environments (global rules).
 */
const DEFAULT_RULES = [
  {
    name: 'brute_force',
    ruleType: 'threshold',
    params: {
      type: 'threshold',
      // Plan: "≥5 failed logins, same IP, 5min". Group by the virtual
      // `attackerKey` extractor so the rule fires uniformly across CrowdSec,
      // Wazuh, ELK, and ntopng — each source surfaces the attacker IP at a
      // different JSON path. The previous seed hard-coded `rawEvent.srcip`
      // which silently missed CrowdSec (where the attacker IP lives at
      // `rawEvent.payload.value`) and ntopng (at `rawEvent.cli.ip`).
      // See `extractGroupValue` in `lib/security/rule-engine.ts` for the
      // source-path probe order.
      field: 'attackerKey',
      op: 'gte' as const,
      value: 5,
      window: 300, // 5 minutes
      groupBy: ['attackerKey'],
    },
    severity: 70,
    window: 300,
  },
  {
    name: 'port_scan',
    ruleType: 'pattern',
    params: {
      type: 'pattern',
      regex: 'port_scan|scan',
      field: 'title',
      window: 60,
    },
    severity: 50,
    window: 60,
  },
  {
    name: 'malware',
    ruleType: 'malware',
    params: {
      type: 'malware',
      ruleLevel: 10,
      field: 'severity',
    },
    severity: 90,
    window: 0,
  },
  {
    name: 'suspicious_process',
    ruleType: 'process',
    params: {
      type: 'process',
      commandPattern: '(bash|sh|cmd|powershell)\\s+(?=.*\\b(rm\\s+-rf|chmod\\s+777|wget\\s+.*\\|\\s*sh|curl\\s+.*\\|\\s*sh|nc\\s+-e|mkfifo|/dev/tcp)\\b)',
      window: 300,
    },
    severity: 85,
    window: 300,
  },
]

/**
 * Seed default correlation rules. Runs idempotently — skips existing rules.
 */
export async function ensureCorrelationRules(): Promise<void> {
  try {
    for (const rule of DEFAULT_RULES) {
      await prisma.correlationRule.upsert({
        where: { name: rule.name },
        update: {
          ruleType: rule.ruleType,
          params: rule.params,
          severity: rule.severity,
          window: rule.window,
        },
        create: {
          name: rule.name,
          ruleType: rule.ruleType,
          params: rule.params,
          severity: rule.severity,
          window: rule.window,
          environmentId: null, // global rule
        },
      })
      console.log(`[seed] CorrelationRule: ${rule.name} (${rule.ruleType}, severity=${rule.severity})`)
    }
  } catch (err) {
    console.error('[seed] Failed to seed correlation rules:', err instanceof Error ? err.message : err)
  }
}
