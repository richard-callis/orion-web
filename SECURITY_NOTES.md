# ORION Security Notes

**Last Updated**: 2026-04-26  
**Scope**: ORION Web + Gateway  
**Full audit details**: `docs/soc2/SECURITY_FINDINGS.md`

## Current Posture

SOC 2 Phase 1 remediation is **~95% complete**. All critical auth and injection findings
have been addressed. See `SOC2_STATUS.md` for per-finding status.

## What Was Fixed

| ID | Fix | Status |
|----|-----|--------|
| CR-001/002/004 | Auth on tool/environment/K8s endpoints | Complete |
| H-002 | CSP + security headers (nonce-based) | Complete |
| H-003 | Path traversal in domain setup | Complete |
| H-005 | Shell injection filter strengthened | Complete |
| M-001 | SQL — moved to Prisma parameterized queries | Complete |
| M-002 | Secure cookie flags | Complete |
| M-003 | Rate limiting (Redis + in-memory fallback) | Complete |
| RATE-001 | Distributed rate limiting with Redis Sentinel | Complete |
| SSO-001 | HMAC-SHA256 validation on SSO headers | Complete |
| AUDIT-001 | S3 audit log export with hash chain | Complete |
| INPUT-001 | Zod input validation on all API routes | In progress |

## Open Items

- **INPUT-001**: Input validation rollout (~55% complete — see `INPUT_VALIDATION.md`)
- **CR-003**: Unauthenticated K8s stream/pod-logs endpoints — verify in auth middleware
- **CR-005**: LLM prompt injection — tool approval flow exists; review coverage
- **H-001**: Plaintext secrets in DB — envelope encryption deferred (architectural decision pending)
- **M-004**: Sensitive data in logs — redaction library in place; broader rollout needed
- **M-005**: Missing audit fields on some models

## Key Security Files

| File | Purpose |
|------|---------|
| `apps/web/src/middleware.ts` | Rate limiting + CSP headers |
| `apps/web/src/lib/rate-limit-redis.ts` | Redis rate limiter |
| `apps/web/src/lib/auth.ts` | NextAuth config + SSO HMAC validation |
| `apps/web/src/lib/redact.ts` | Secret redaction patterns |
| `apps/gateway/src/tool-runner.ts` | Tool execution + injection prevention |
| `docs/soc2/SECURITY_FINDINGS.md` | Full audit findings (19 items) |
| `apps/web/src/lib/RATE-LIMITING.md` | Rate limiting architecture + config |

## SIEM Telemetry Sources

| Source | Producer | Authentication | Secret source |
|--------|----------|----------------|---------------|
| `host_agent` | Vector container on the Orion host (`deploy/host-agent/vector.toml`) → POST `/api/monitoring/security/webhooks/host-agent` | HMAC-SHA256 over body, 5-min replay window | `HOST_AGENT_WEBHOOK_SECRET` env var (from `deploy/.env`, injected via `deploy/docker-compose.yml`) — read by both vector and the orion webhook route |
| `gateway_audit` | In-process gateway dispatcher (`apps/gateway/src/gateway-audit.ts`) — writes `SecurityEvent` rows directly via the orion audit webhook | HMAC over body | `GATEWAY_AUDIT_SECRET` env var |
| `falco` | Falcosidekick (Orion host + per managed env) → POST `/api/monitoring/security/webhooks/falco` | **Bearer token** via `X-Orion-Falco-Token` (Falcosidekick cannot body-sign — constant-time compare against shared secret). Replay protection from alert's `time` field (5-min window). TLS at Traefik ingress provides transport confidentiality. | `FALCO_WEBHOOK_SECRET` env var, mirrored to Vault KV at `secret/orion/falco/webhook_secret` |
| `crowdsec` / `wazuh` | External (not deployed yet) | HMAC per source | Per-source `SecurityConfig` row (via `getWebhookSecret` in `webhook-auth.ts`) |
| `elk` / `ntopng` | Internal pollers (`apps/web/src/jobs/security-poll-*.ts`) | n/a (in-process) | n/a |
| `k8s_events` | In-process poller (Phase 2 PR8) — calls `kubectl_get_events` gateway tool every 30s | n/a (in-process, per-env auth via gateway) | n/a (env-scoped via `EnvironmentSourceHealth`) |

> Note: `bootstrap.sh` also seeds a `SecurityConfig` row keyed `HOST_AGENT_WEBHOOK_SECRET` for forward compatibility, but the host-agent webhook route currently reads the env var directly. Don't rely on the DB row alone — the env var is load-bearing.

### Secret rotation — `HOST_AGENT_WEBHOOK_SECRET`

Both producer (vector) and verifier (orion webhook route) read the same env var, so they must be updated and restarted together.

1. Generate new value: `openssl rand -hex 32`
2. Update `deploy/.env` with the new value (replace the `HOST_AGENT_WEBHOOK_SECRET=...` line).
3. (Optional) Mirror to Vault KV: `vault kv put secret/orion/host-agent webhook_secret=<new>`.
4. (Optional) Update the `SecurityConfig` row of the same key — currently unused at runtime, but keep it in sync if you want the row to remain accurate.
5. Restart **both** services so they pick up the new env value:
   `docker compose up -d orion vector` (or `docker compose restart orion vector`).
6. Old secret stops being accepted on the next batch.

If you only restart vector, every signed batch will 401 against the orion route until orion is also restarted. If you only restart orion, vector keeps signing with the old value until it's restarted too.

The bootstrap script (`deploy/bootstrap.sh`) generates this on first install; subsequent rotations are manual per the steps above.

### Secret rotation — `FALCO_WEBHOOK_SECRET`

Single shared secret used by every Falcosidekick instance (Orion host + every managed env) and verified by the orion `/webhooks/falco` route. Same env-var load-bearing pattern as `HOST_AGENT_WEBHOOK_SECRET`.

1. Generate new value: `openssl rand -hex 32`
2. Update `deploy/.env`: replace the `FALCO_WEBHOOK_SECRET=...` line.
3. Update Vault KV: `vault kv put secret/orion/falco webhook_secret=<new>` (managed envs fetch from here on next reconcile).
4. Restart orion + the host's falcosidekick: `docker compose up -d orion falcosidekick`.
5. For each managed env: redeploy the Falcosidekick container with the new secret (compose-fragment env interpolation will pick it up automatically if envs re-render from Vault).
6. Old secret stops being accepted on next request.

Until step 5 completes for a given managed env, alerts from that env will 401 against the orion route. Plan rotations during low-activity windows or coordinate across envs.

### Deployment artifacts — Falco

- **Orion host:** `falco` + `falcosidekick` services in `deploy/docker-compose.yml`. Config at `deploy/host-agent/falco/falco.yaml`. Bootstrap mints `FALCO_WEBHOOK_SECRET` automatically.
- **Managed Docker envs:** `deploy/managed-env/falco/docker-compose.fragment.yml` — applied by the environment-registration flow.
- **Managed K8s envs:** `deploy/managed-env/falco/falco-helm-values.yaml` — `helm install` (Falco chart + falcosidekick subchart).
- **Verifying alerts arrive:** trigger `docker exec -it <container> bash` on any host → expect a `falco.terminal_shell_in_container` SecurityEvent within ~5s with the right `environmentId`.
