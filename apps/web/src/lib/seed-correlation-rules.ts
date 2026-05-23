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
  // ── Host-agent rules (from gigly-sniffing-parasol.md, PR3) ─────────────────

  // host.ssh_brute_force — ≥5 SSH failed-password events from same IP in 5min.
  // This is a narrower variant of the generic brute_force rule that fires
  // specifically on host_agent source SSH failures (which have structured
  // metadata from the Vector shipper).
  {
    name: 'host.ssh_brute_force',
    ruleType: 'threshold',
    params: {
      type: 'threshold',
      field: 'attackerKey',
      op: 'gte' as const,
      value: 5,
      window: 300, // 5 minutes
      groupBy: ['attackerKey'],
      // Only match events from the host_agent source — the generic
      // brute_force rule already handles CrowdSec/Wazuh SSH failures.
      sourceFilter: ['host_agent'],
    },
    severity: 70,
    window: 300,
  },

  // host.vault_anomaly — Vault root-token create OR unseal. Fires immediately
  // (no aggregation) because these are always high-signal admin operations
  // regardless of time of day — an attacker will not schedule around a
  // maintenance window. Any vault root-token creation or unseal is auditable
  // and should trigger an Incident for human review.
  {
    name: 'host.vault_anomaly',
    ruleType: 'pattern',
    params: {
      type: 'pattern',
      regex: '^vault\\.(token\\.create\\.root|unseal)$',
      field: 'type',
      window: 0, // fire immediately — no aggregation window
    },
    severity: 80,
    window: 0,
  },

  // gateway_audit — any single agent.tool.invoked event with severity >= 60
  // opens an Incident immediately. This is the correlation rule for PR4
  // (gateway tool-call audit). Lower-severity gateway events are informational
  // only. Uses a pattern rule scoped to source=gateway_audit and
  // minSeverity=60 to avoid false positives from other gateway_audit event
  // types (e.g. agent.session.start, agent.tool.result).
  {
    name: 'gateway_audit_high_severity',
    ruleType: 'pattern',
    params: {
      type: 'pattern',
      regex: '^agent\\.tool\\.invoked$',
      field: 'type',
      window: 0, // fire immediately — no aggregation
      sourceFilter: ['gateway_audit'],
      minSeverity: 60,
    },
    severity: 80,
    window: 0,
  },

  // ── Phase 2 PR9 — Infra correlation rules ─────────────────────────────────
  // Seeded DISABLED by default (enabled=false) per the plan: thresholds
  // need tuning against real-world Falco / K8s event volumes before they
  // can run without paging on noise. Operators flip enabled=true once
  // they've confirmed thresholds via the security dashboard.
  //
  // The SIEM_INFRA_RULES_ENABLED env var (checked at seed time below) can
  // pre-enable them in dev/staging where false-positive paging is acceptable.

  // infra.k8s_crash_storm — ≥3 CrashLoopBackOff events in same namespace
  // within 5 minutes. Catches "deploy that immediately CrashLoopBackOffs
  // across many pods" — a high-confidence outage signal.
  {
    name: 'infra.k8s_crash_storm',
    ruleType: 'threshold',
    params: {
      type: 'threshold',
      field: 'metadata.namespace',
      op: 'gte' as const,
      value: 3,
      window: 300, // 5 minutes
      groupBy: ['metadata.namespace'],
      sourceFilter: ['k8s_events'],
      typeFilter: ['k8s.crash_loop_backoff'],
    },
    severity: 70,
    window: 300,
    enabledByDefault: false,
  },

  // infra.falco_critical — any single Falco alert with severity ≥ 85 opens
  // an Incident immediately. EMERGENCY / ALERT / CRITICAL Falco priorities
  // are individually high-signal (container escape, kernel module load,
  // sensitive file write to /etc/shadow, etc.).
  {
    name: 'infra.falco_critical',
    ruleType: 'pattern',
    params: {
      type: 'pattern',
      regex: '^falco\\.',
      field: 'type',
      window: 0, // fire immediately
      sourceFilter: ['falco'],
      minSeverity: 85,
    },
    severity: 90,
    window: 0,
    enabledByDefault: false,
  },

  // infra.container_shell_storm — ≥2 Falco "Terminal shell in container"
  // alerts on same environment within 10 minutes. Single ad-hoc exec is
  // common (debugging); two within a window suggests scripted access.
  {
    name: 'infra.container_shell_storm',
    ruleType: 'threshold',
    params: {
      type: 'threshold',
      field: 'environmentId',
      op: 'gte' as const,
      value: 2,
      window: 600, // 10 minutes
      groupBy: ['environmentId'],
      sourceFilter: ['falco'],
      typeFilter: ['falco.terminal_shell_in_container'],
    },
    severity: 80,
    window: 600,
    enabledByDefault: false,
  },

  // infra.cross_env_image_anomaly — same container image tag triggering
  // Falco alerts OR OOMKilled across ≥2 environments within 30 minutes.
  // Supply-chain signal: an image is misbehaving identically in multiple
  // places, suggesting the image itself (not the env) is the cause.
  //
  // Grouping by metadata.container_image bridges Falco events (which carry
  // it in output_fields.container.image → metadata.container_image) and
  // K8s OOM events (which carry the image in involvedObject — handled by
  // the rule engine's path probe).
  {
    name: 'infra.cross_env_image_anomaly',
    ruleType: 'threshold',
    params: {
      type: 'threshold',
      field: 'environmentId',
      op: 'gte' as const,
      value: 2,
      window: 1800, // 30 minutes
      groupBy: ['metadata.container_image'],
      countDistinct: 'environmentId',
      sourceFilter: ['falco', 'k8s_events'],
      typeFilter: ['k8s.oom_killed', 'falco.terminal_shell_in_container'],
    },
    severity: 75,
    window: 1800,
    enabledByDefault: false,
  },

  // infra.falco_silence — synthetic rule: emits a SecurityEvent of type
  // "source.silent" when an EnvironmentSourceHealth(source='falco') row
  // is stale beyond 2× its staleAfterMs. A silenced Falco may mean the
  // container was killed by an attacker — high-signal blind spot.
  //
  // Implementation: the correlator's source-stale checker (already runs
  // every cycle) consults this rule's params to decide WHICH sources to
  // check and what the synthetic event type should look like.
  {
    name: 'infra.falco_silence',
    ruleType: 'pattern',
    params: {
      type: 'pattern',
      regex: '^source\\.silent$',
      field: 'type',
      window: 0,
      sourceFilter: ['environment_source_health'],
      stalenessMultiplier: 2,
      monitoredSource: 'falco',
    },
    severity: 70,
    window: 0,
    enabledByDefault: false,
  },
]

/**
 * Seed default correlation rules. Runs idempotently — does NOT modify the
 * `enabled` field of existing rows (operators flip rules on/off in the
 * dashboard and we must not stomp that on every startup).
 *
 * Phase 2 infra rules carry `enabledByDefault: false`. They are seeded
 * disabled unless `SIEM_INFRA_RULES_ENABLED=true` in the environment, in
 * which case new infra rows are created with enabled=true. Existing rows
 * are never re-enabled by this seeder regardless of the env var.
 */
export async function ensureCorrelationRules(): Promise<void> {
  const infraRulesEnabledViaEnv =
    (process.env.SIEM_INFRA_RULES_ENABLED ?? '').toLowerCase() === 'true'
  try {
    for (const rule of DEFAULT_RULES) {
      const enabledByDefault =
        (rule as { enabledByDefault?: boolean }).enabledByDefault
      const createEnabled =
        enabledByDefault === false ? infraRulesEnabledViaEnv : true
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
          enabled: createEnabled,
        },
      })
      console.log(
        `[seed] CorrelationRule: ${rule.name} (${rule.ruleType}, severity=${rule.severity}, ` +
          `enabledByDefault=${enabledByDefault !== false}, createEnabled=${createEnabled})`
      )
    }
  } catch (err) {
    console.error('[seed] Failed to seed correlation rules:', err instanceof Error ? err.message : err)
  }
}
