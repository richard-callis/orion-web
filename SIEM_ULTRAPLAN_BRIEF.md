# SIEM Completion — Ultraplan Brief

**Date prepared:** 2026-05-20
**Target:** `/ultraplan`
**Scope:** Complete the SIEM portion of Orion-Web as an agent-operated security stack.

---

## Premise

Orion-Web manages this homelab's infrastructure via AI agents. Security must be part of that loop: the AI needs to SEE security events and TAKE ACTION on them (block IPs, quarantine hosts, investigate flows) with human oversight where risk warrants it. The current SIEM scaffold is a human dashboard with empty tables and dead response actions — it must become an agent-first SIEM with a human approval/observation UI on top.

## Repo

`/home/rkhalis/orion-web` — monorepo with `apps/web` (Next.js + Prisma) and `apps/gateway` (tool execution).

## Current state (verified by file read)

- DB: `SecurityEvent` (severity 0-100, type, source, dedupKey, rawEvent, acknowledged) and `SecurityConfig` (per-env key/value). `apps/web/prisma/schema.prisma:881`.
- Web API under `/api/monitoring/security/`:
  - `overview` — counts off `SecurityEvent`
  - `alerts` + `alerts/ack` — list/acknowledge
  - `flows` — proxies `elk_flow_search` via gateway
  - `actions` — block_ip/quarantine/investigate; calls `crowdsec_block_ip` which **does not exist** in gateway
  - `stream` — SSE polling `SecurityEvent` every 5s
- Web UI: `apps/web/src/components/security/{SecurityDashboard,AlertFeed,FlowTable,SecuritySettings}.tsx`
- Gateway security tools (all read-only): `crowdsec_blocks`, `crowdsec_suggestions`, `ntopng_threats`, `ntopng_top_talkers`, `elk_flow_search`, `elk_syslog_search`, `wazuh_alerts`, `wazuh_rootcheck`, `prometheus_query[_range]`. `apps/gateway/src/builtin-tools/security.ts`.
- System agent "Warden" is mentioned in `seed-system-agents.ts` and assigned to the Maintenance system chatroom, but is **not seeded** as a Nova/Agent. No prompt, no tool whitelist, no behavior.
- No ingestion worker. No correlation layer. No approval flow. No audit trail for response actions.

## Goal (v1 = production-grade, agent-first)

1. **Ingest via push where natively supported; poll-as-adapter for sources that don't.** CrowdSec + Wazuh → webhook endpoints under `/api/monitoring/security/webhooks/{source}`, HMAC-authenticated, idempotent on `dedupKey`. ELK + ntopng → a thin internal poller per source that transforms polled results into the same internal event pipeline (no separate code path for downstream consumers). Source health derived from last-event timestamp regardless of mechanism.
2. **Schema redesign**: separate raw events from derived `Incident`s; add `ActionAudit` (every proposed + executed action, with tier and approver); add `ActionPolicy` (action-type → risk tier, with target overrides); add `CorrelationRule` store; add `SourceHealth` view/table; add `Suppression`/`Allowlist`; add `system.room.security` to the system-room seed.
3. **Correlation engine**: rule-based grouping (attacker IP, host, rule chain), severity scoring, dedup window, incident lifecycle (open → triaged → contained → closed).
4. **Warden system agent**: seed Nova + Agent, subscribe to a **new dedicated `system.room.security` chatroom** (not Maintenance), post incident summaries, propose/announce response actions per their risk tier.
5. **Risk-tiered response action layer (everything has a tier)**:
   - New gateway WRITE tools: `crowdsec_decision_create` (ban), `crowdsec_decision_delete`, `wazuh_active_response` (isolate/kill), `firewall_block` if applicable.
   - **Every action is tagged with a risk tier** in a DB-backed `ActionPolicy` table — editable without redeploy. Tiers (proposed): `auto` (AI executes immediately), `notify` (AI executes, posts to Security room for awareness), `approve` (AI proposes, human must approve in UI before execution), `escalate` (must be human-initiated; AI cannot propose).
   - Bias toward letting the AI act: default most actions to `auto` or `notify` so Warden can do its job; reserve `approve`/`escalate` for high-blast-radius operations (whole-subnet blocks, host isolation of named-prod hosts, irreversible quarantine).
   - Per-action overrides keyed on target (e.g., `block_ip` is `auto` for unknown IPs but `approve` for IPs inside the home subnet).
   - Every executed/proposed action emits an `ActionAudit` row linked to the incident — even auto ones.
6. **Real-time push end-to-end (with internal poll adapters where unavoidable)**:
   - **Inbound (sources → orion)**: webhooks where native (CrowdSec, Wazuh). HMAC-signed, replay-safe, idempotent on `dedupKey`. ELK + ntopng run internal pollers that produce the same internal event records — invisible to downstream consumers.
   - **Outbound (orion → clients/agents)**: replace 5s polling SSE with Postgres `LISTEN/NOTIFY` (or Redis pub/sub if already deployed) so dashboard + Warden both react instantly regardless of how the event arrived.
7. **Dashboard polish**: incident-centric (not raw-event-centric), drilldowns, source health panel, action approval queue, agent activity log per incident.
8. **Retention**: TTL on raw events, longer retention on incidents; align with existing AUDIT_EXPORT for compliance.

## Constraints

- Schema redesign is allowed and expected.
- Must integrate cleanly with the existing system-epic/chatroom architecture (see `seed-system-epic.ts` and `seed-system-agents.ts`).
- Must reuse the gateway tool pattern (don't fork into a separate runtime).
- Must respect SOC2 work already done — audit log + S3 export; response actions should land in the same audit pipeline.
- The reverse-proxy HMAC, S3-object-lock, Redis-Sentinel ops items in `PROJECT_SUMMARY.md` are unrelated; do not gate this work on them.

## Decisions (locked 2026-05-20)

- **Ingestion = push where native, internal poller-adapter where not.** CrowdSec + Wazuh push via webhook. ELK + ntopng are polled internally; downstream code sees the same event pipeline either way.
- **Risk-tiered everything**: every action has a tier; default tier-set should let Warden act autonomously on the common path; humans only gate high-blast-radius operations.
- **Dedicated Security chatroom** (`system.room.security`). Not Maintenance.

## Open decisions still to surface in the plan

- **Poll-adapter cadence + tuning**: ELK and ntopng pollers need per-source intervals (default ~30s for ntopng top-talkers / threats, ~15s for ELK syslog/flows on a small index). Plan should specify whether intervals are env-config or live in `SecurityConfig` (per-env). Watermarking strategy: store last-seen `@timestamp` per source in `SourceHealth` so pollers ask for "since X" rather than full re-scans.
- **Inbound auth**: shared-secret HMAC per source, or mTLS via the same reverse proxy that already does SSO HMAC (see `SSO_HMAC.md`)? Reusing the proxy is cheaper to operate.
- **Action policy granularity**: tier per action-type only, or `(action, source, target)` matrix? Recommend tier per action-type with optional `(action, target-pattern)` overrides — keeps the table small.
- **Default tier assignments** (the actual table contents): which actions are `auto` vs `notify` vs `approve`? Plan should propose a starting matrix, not leave it for later.
- **"Panic mode" / kill-switch**: a single env-var or DB row that downgrades all `auto`/`notify` to `approve` during incidents or pre-prod weeks. Likely yes — cheap to add.
- **Correlation engine**: in-process Node worker (recommended), Postgres-only windowed CTEs, or a dedicated stream processor (overkill at homelab scale).
- **Approval UX**: inline action button on the incident row vs. dedicated approval-queue route. Probably both — queue for the operator-on-shift, inline for incident drilldown.
- **Security room membership**: Warden only, or also Sentinel (monitoring) and Pulse (cluster health) for cross-domain correlation chatter?
- **Source health signal**: separate heartbeat job vs. derived from "last webhook received within N minutes". Derived is simpler.
- **Webhook replay/backfill**: when a source recovers after downtime, do we ingest its missed-event backlog (via a one-shot fetch) or accept the gap? Likely a per-source `backfillOnRecover` flag.

## Deliverable

- Build order with file-level granularity (Schema → Gateway write tools → Ingestion workers → Correlation engine → Warden seed → API/SSE → UI → Tests).
- Identify worktrees that can run in parallel (matches the SOC2 phase pattern in `PROJECT_SUMMARY.md`).
- Risk register and mitigations (esp. autonomous block actions).
- Test plan: source mocks, correlation rule unit tests, approval-flow integration test, end-to-end smoke (mock CrowdSec event → `SecurityEvent` → Incident → Warden post → human-approved action → audit row).
- Success criteria for "complete".

---

## Author's tradeoff notes (not for the ultraplan prompt itself)

- **Push vs poll ingestion** is the single biggest call. Polling is simpler and fits the existing gateway-tool pattern; push (webhooks) gets you sub-second latency but adds inbound auth/rate-limiting surface. For homelab scale, recommend polling first, design schema so push can be added later.
- **Auto-approve risk tier** is the safety call. Defaulting everything to require-approval is safer but makes the AI feel performative. A narrow auto-approve list (e.g., "IP already on CrowdSec community blocklist with confidence > X") is the sweet spot.
- **Warden in Security room vs Maintenance** — argue for a dedicated `system.room.security` room so Warden's incident chatter doesn't drown the maintenance feed.
