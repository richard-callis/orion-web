# SIEM Completion — Implementation Plan

**Date prepared:** 2026-05-20
**Companion to:** `SIEM_ULTRAPLAN_BRIEF.md`
**Scope:** Complete the SIEM portion of Orion-Web as an agent-operated security stack.

---

## Build order with file-level granularity

### Phase 0 — Foundations *(no parallelism; everything depends on this)*

**P0.1 Schema redesign** — `apps/web/prisma/schema.prisma`
- Repurpose `SecurityEvent` as raw normalized record (keep `dedupKey`, `rawEvent`; add `incidentId String?`, `firstSeen`/`lastSeen`)
- New: `Incident` (id, status enum, severity, rootCauseSummary, attackerKey, hostKey, openedAt, closedAt)
- New: `ActionAudit` (id, incidentId, actionType, target, tier, proposedBy, approvedBy, status: attempting|succeeded|failed|denied, payload, result, timestamps)
- New: `ActionPolicy` (id, actionType, defaultTier, targetPatterns Json, updatedBy)
- New: `CorrelationRule` (id, name, enabled, ruleType, params Json, severity, window)
- New: `SourceHealth` (source, lastSeenAt, lastWatermark, staleAfterMs)
- New: `Suppression` (id, matchPattern Json, reason, expiresAt)
- Prisma migration + a one-shot data migration script for any existing rows

**P0.2 System room seed** — `apps/web/src/lib/seed-system-epic.ts`
- Add `Security` feature under System epic
- Add `system.room.security` ChatRoom, members: `[Warden]` initially

**P0.3 ActionPolicy defaults seed** — new `apps/web/src/lib/seed-action-policies.ts`
- Inserts the default tier matrix (see "Recommendations on the open decisions" below)
- Includes the `__panic_mode__` row

**P0.4 Shared types** — `apps/web/src/lib/security/types.ts`
- `NormalizedSecurityEvent`, `IncidentDraft`, `ActionRequest`, `ActionDecision`

---

### Phase 1 — Capability layer *(3 parallel worktrees after P0 merges)*

**Worktree A — `feat/siem-gateway-tools`** (`apps/gateway/src/builtin-tools/security.ts`)
- `crowdsec_decision_create({ ip, scope, duration, reason })` → POST `/v1/decisions`
- `crowdsec_decision_delete({ decisionId })` → DELETE
- `wazuh_active_response({ agent, command, args })` → POST `/active-response`
- `firewall_block({ cidr, reason })` — stub if no fw API yet, behind feature flag
- Tests in `security.test.ts` covering happy-path and error responses

**Worktree B — `feat/siem-ingestion`**
- Webhook endpoints:
  - `apps/web/src/app/api/monitoring/security/webhooks/crowdsec/route.ts`
  - `apps/web/src/app/api/monitoring/security/webhooks/wazuh/route.ts`
  - Shared `apps/web/src/lib/security/webhook-auth.ts` — HMAC verification, replay window, `dedupKey` idempotency
- Pollers (use existing `src/jobs/` pattern that `audit-export-daily.ts` lives in):
  - `apps/web/src/jobs/security-poll-elk.ts`
  - `apps/web/src/jobs/security-poll-ntopng.ts`
  - Watermarking via `SourceHealth.lastWatermark`
- Source normalizers `apps/web/src/lib/security/normalize/{crowdsec,wazuh,elk,ntopng}.ts` → all return `NormalizedSecurityEvent`

**Worktree C — `feat/siem-correlation`**
- `apps/web/src/workers/security-correlator.ts` — consumes new `SecurityEvent` rows, runs rules, upserts `Incident`
- `apps/web/src/lib/security/rule-engine.ts` — interprets `CorrelationRule.params`
- Default rules seeded: brute-force (≥5 failed logins, same IP, 5min), recon (port scan from ntopng), malware (Wazuh `rule.level >= 10`), suspicious-process (Wazuh rootcheck)
- Incident state machine: `open → triaged → contained → closed`, with timestamps

> Coordination: A/B/C agree on the `NormalizedSecurityEvent` shape in P0.4 before splitting.

---

### Phase 2 — Decision/action layer

- `apps/web/src/lib/security/action-service.ts` — `decide(action, target) → tier`, `execute(action) → ActionAudit`
- Approval API:
  - `apps/web/src/app/api/monitoring/security/approvals/route.ts` (GET pending list)
  - `apps/web/src/app/api/monitoring/security/approvals/[id]/route.ts` (POST approve/deny)
- Action executor `apps/web/src/lib/security/action-executor.ts` — writes `ActionAudit` with `status='attempting'` before calling gateway, updates after
- Rewrite `apps/web/src/app/api/monitoring/security/actions/route.ts` to delegate to action-service (kills dead `crowdsec_block_ip` reference)

---

### Phase 3 — Real-time push (outbound)

- Postgres triggers (new Prisma migration): NOTIFY on insert/update for `SecurityEvent`, `Incident`, `ActionAudit`
- Rewrite `apps/web/src/app/api/monitoring/security/stream/route.ts` to consume NOTIFY via a long-lived Postgres client. Payload = row ID only; consumer fetches.
- Split streams: `?channel=incidents|events|approvals`

---

### Phase 4 — Warden agent

- `apps/web/src/lib/seed-system-nebula.ts` — add `novas/warden.yaml` (system prompt: triage incidents → propose/execute per tier)
- `apps/web/src/lib/seed-system-agents.ts` — seed Warden Agent record, tool whitelist: all security read + write tools + `chat_post`, subscribed to `system.room.security`
- Verify existing room-agent runner (`src/lib/room-agents.ts`) picks up Warden on new-incident NOTIFY

---

### Phase 5 — Dashboard *(parallel with Phase 4)*

- `apps/web/src/app/(app)/security/page.tsx` — incident-centric (replaces raw-event-first layout)
- `apps/web/src/app/(app)/security/incidents/[id]/page.tsx` — drilldown with raw event timeline + Warden chatroom thread + action approval inline button
- `apps/web/src/app/(app)/security/approvals/page.tsx` — operator approval queue
- New `apps/web/src/components/security/SourceHealthPanel.tsx`
- Refactor `SecurityDashboard.tsx`: tabs become `Incidents | Approvals | Flows | Sources | Settings`
- Existing `AlertFeed.tsx` repurposed for raw-event drawer inside incident drilldown

---

### Phase 6 — Retention + tests

- `apps/web/src/jobs/security-retention-daily.ts` — TTL 30d on `SecurityEvent`, 365d on `Incident` and `ActionAudit`, hook into existing S3 audit-export
- Test suite (see Test plan below)

---

## Worktree parallelization

```
P0 (single branch)  ─────────►  merge
                                  │
            ┌─────────────────────┼─────────────────────┐
   feat/siem-gateway-tools   feat/siem-ingestion   feat/siem-correlation
   (Worktree A)              (Worktree B)          (Worktree C)
            │                     │                     │
            └─────────► merge order: A → B → C ◄────────┘
                                  │
                          feat/siem-actions  (P2)
                                  │
                          feat/siem-realtime (P3)
                                  │
              ┌───────────────────┴───────────────────┐
       feat/siem-warden (P4)                 feat/siem-ui (P5)
              └───────────────────┬───────────────────┘
                          feat/siem-retention (P6)
```

Matches the SOC2 phase pattern in `PROJECT_SUMMARY.md`.

---

## Recommendations on the open decisions

| Decision | Recommendation |
|---|---|
| Poll cadence | 15s ELK syslog, 30s ELK flow, 30s ntopng. Live in `SecurityConfig` per-env. |
| Inbound auth | HMAC per source, secret in `SecurityConfig`. mTLS via reverse proxy deferred — overkill for v1. |
| Policy granularity | Tier per action-type + optional `(action, targetPattern)` overrides in `ActionPolicy.targetPatterns`. |
| Default tier matrix | See below |
| Panic mode | Yes. `ActionPolicy` row with `actionType='__panic_mode__'`. When true, downgrades all `auto`/`notify` to `approve` at decide-time. |
| Correlation engine | In-process Node worker. Postgres windowed CTEs as a per-rule *tactic* where useful, not the engine. |
| Approval UX | Both: dedicated queue page + inline button on incident drilldown. |
| Security room membership | Warden only at v1. Add Sentinel/Pulse later if cross-domain correlation chatter is useful. |
| Source health | Derived from `SourceHealth.lastSeenAt`. Cron every 5min emits a synthetic `source_stale` `SecurityEvent` if no event in 2× expected interval. |
| Webhook replay/backfill | Per-source `backfillOnRecover` flag. Default ON for CrowdSec (small replay window), OFF for Wazuh (potentially huge). Backfilled events skip correlation (historical only). |

### Default tier matrix

| Action type | Default tier | Target-pattern overrides |
|---|---|---|
| `crowdsec_decision_create` (ban IP) | `auto` | `approve` if IP ∈ home subnet (e.g. 10.0.0.0/8 + your LAN) |
| `crowdsec_decision_delete` (unban) | `auto` | — |
| `wazuh_active_response` | `approve` | `escalate` if target host matches `named-prod-*` |
| `firewall_block` (subnet) | `approve` | `escalate` for subnets > /24 |
| `investigate` (elk_flow_search) | `auto` | — |
| `incident_close` | `notify` | — |
| `suppression_add` | `approve` | — |
| Anything labeled destructive on infra | `escalate` | — |

---

## Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | AI auto-blocks a legitimate home/LAN IP, locks user out | High | Home-subnet override forces `approve`. Static allowlist of known-good IPs in `Suppression`. |
| R2 | Wazuh active-response runs against named-prod host | Catastrophic | `wazuh_active_response` always `approve`; named-prod pattern escalates further. Cannot be overridden to `auto`. |
| R3 | Webhook secret leak → forged events trigger bogus actions | Medium | Per-source HMAC, secret rotation via `SecurityConfig`, log every failed signature, alert if rate > N/min |
| R4 | Poison correlation rule → infinite incident loop | High | Per-rule rate limit, max incidents/window cap, validation on rule save |
| R5 | ELK poller hammers ELK during an outage | Medium | Per-poller circuit breaker: 3 consecutive >5s requests → back off + emit `source_stale` |
| R6 | Backfill dump on source recovery → spurious live incidents | Medium | Backfilled events bypass correlator if `@timestamp < now - 5min` |
| R7 | Postgres NOTIFY 8KB payload limit | Low | NOTIFY carries only ID; consumer fetches the row |
| R8 | Warden hallucinates an unknown tool | Low | Gateway already rejects unknown tools; add metric + alert if Warden tries unknown tool > 3/hr |
| R9 | Action fails mid-execute, no audit row | High (compliance) | Write `ActionAudit` with `status='attempting'` BEFORE execution; update after |
| R10 | Approval queue grows unbounded if operator AFK | Medium | TTL on pending approvals (e.g. 24h → auto-deny), Warden re-evaluates after deny |
| R11 | Migration data loss on existing `SecurityEvent` rows | Low (currently empty) | Verify empty in prod before running; one-shot migration script is reversible |

---

## Test plan

**Unit**
- Each correlation rule with synthetic trigger sequences (brute-force, recon, malware, suspicious-process)
- `decide(action, target)` resolver — every cell in default tier matrix
- HMAC verification (valid, expired window, bad signature, replay)
- Watermark advance per source

**Worker integration (per worktree)**
- Webhook → `SecurityEvent` → correlator → `Incident` → notify → Warden mock observes → action-service → `ActionAudit`
- Poller with mock ELK responding "since X" → watermark advances correctly
- Approval flow: high-tier action stays pending; POST approve → executes; POST deny → no execute, audit row

**E2E smoke**
- Real Postgres, mock CrowdSec server returns synthetic event → webhook fires → row appears → correlator groups → Warden posts to security room → human-approved action → gateway WRITE tool call → `ActionAudit.status='succeeded'`

**Panic mode**
- Flip `__panic_mode__` → confirm next `auto` request is queued for approval instead of executed

**Failure modes**
- Webhook with bad signature → 401 + audit log entry
- Action executor failure → `ActionAudit.status='failed'`, Warden notified
- Source poller circuit-breaker trip → `source_stale` event in dashboard

**Regression**
- All SOC2 smoke tests still pass (`SMOKE_TESTS_QUICK_START.sh all`)

---

## Success criteria for "complete"

1. Real CrowdSec/Wazuh webhooks land `SecurityEvent` rows in DB in <1s
2. ELK + ntopng pollers running with visible `SourceHealth.lastWatermark` advance
3. Brute-force scenario (5 failed SSH from same IP within 5min) creates one `Incident`
4. Warden posts to `system.room.security` with incident summary + proposed action within 30s
5. `auto`-tier action executes; `ActionAudit` row written; visible in audit log + S3 export
6. `approve`-tier action sits in approval queue until human approves, then executes
7. Panic-mode toggle downgrades all `auto`/`notify` to `approve` immediately
8. Source goes dark (mock killed) → `source_stale` event in <2× poll interval
9. SSE stream uses LISTEN/NOTIFY (verified: no DB poll queries during idle)
10. Every E2E smoke test passes; existing SOC2 tests pass; no new high/critical risk findings

---

**Scope estimate:** ~2–3 weeks with the parallelism described, comparable to SOC2 Phase 1.
