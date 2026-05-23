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

| Source | Producer | Authentication | Secret |
|--------|----------|----------------|--------|
| `host_agent` | Vector container on the Orion host (`deploy/host-agent/vector.toml`) → POST `/api/monitoring/security/webhooks/host-agent` | HMAC-SHA256 over body, 5-min replay window | `SecurityConfig.HOST_AGENT_WEBHOOK_SECRET` |
| `gateway_audit` | In-process gateway dispatcher (`apps/gateway/src/gateway-audit.ts`) — writes `SecurityEvent` rows directly via the orion audit webhook | HMAC over body | `GATEWAY_AUDIT_SECRET` |
| `crowdsec` / `wazuh` | External (not deployed yet — Phase 2+) | HMAC per source | Per-source `SecurityConfig` row |
| `elk` / `ntopng` | Internal pollers (`apps/web/src/jobs/security-poll-*.ts`) | n/a (in-process) | n/a |

### Secret rotation — `HOST_AGENT_WEBHOOK_SECRET`

1. Generate new value: `openssl rand -hex 32`
2. Update `SecurityConfig` row (`key='HOST_AGENT_WEBHOOK_SECRET'`) with the new value.
3. Update Vault KV: `vault kv put secret/orion/host-agent webhook_secret=<new>`.
4. Update `.env` on the Orion host and the env file the vector container reads.
5. Restart vector: `docker compose restart vector`.
6. Old secret stops being accepted on next webhook request.

The bootstrap script (`deploy/bootstrap.sh`) generates this on first install and seeds the `SecurityConfig` row; subsequent rotations are manual per the steps above.
