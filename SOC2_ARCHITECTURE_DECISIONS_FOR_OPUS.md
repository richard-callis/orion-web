# SOC II Fixes — Architectural Decisions for Opus Review

**For**: Claude Opus (Architectural Review)  
**Date**: 2026-04-26  
**Status**: Ready for Approval  

---

## Overview

5 CRITICAL/HIGH issues require architectural decisions before implementation. This document presents options for each, with recommendations.

---

## Issue #185: Zero Rate Limiting (CRITICAL)

**Current State**: No rate limiting anywhere in the API  
**Risk**: Brute force, API abuse, DDoS  
**Blocked PRs**: None  

### Decision 1: Storage Backend

**Option A: Redis (Recommended)**
- Distributed rate limiting across multiple replicas
- Industry standard (battle-tested)
- Requires Redis dependency
- Fallback to in-memory if Redis unavailable
- Cost: ~$10-20/month for managed Redis

**Option B: In-Memory Map (Local Only)**
- No external dependency
- Simple implementation
- Does NOT work for multi-replica deployments
- Fine for single-instance development
- Production limitation

**Option C: PostgreSQL (Existing DB)**
- Use existing database
- Slower than Redis
- No additional dependencies
- Can be bottleneck under high load

### Decision 2: Rate Limit Scope

**Option A: Per-IP (Recommended for public endpoints)**
- Blocks bots and attackers
- May over-block shared networks
- Simple to implement

**Option B: Per-User (Recommended for authenticated endpoints)**
- More granular
- Works with session/token auth
- Requires user context

**Option C: Per-Endpoint (Recommended)**
- Different limits for different endpoints
- Login: 5 req/min
- Public API: 100 req/min
- Admin: 1000 req/min

### Decision 3: Implementation Approach

**Option A: Middleware (Recommended)**
- Applied to all routes automatically
- Central configuration
- Consistent behavior

**Option B: Per-Route Decorators**
- Fine-grained control
- More boilerplate
- Easier to customize per-endpoint

### Recommendation

**Use Redis + per-IP rate limiting (public) + per-user rate limiting (auth) applied via middleware, with in-memory fallback.**

```typescript
// Pseudo-code
const limiter = new RedisRateLimiter({
  fallback: new InMemoryRateLimiter(),
  rules: [
    { path: '/api/auth/login', max: 5, window: '60s', key: 'ip' },
    { path: '/api/*', max: 100, window: '60s', key: 'user' },
    { default: { max: 1000, window: '60s', key: 'ip' } }
  ]
})

app.use(rateLimitMiddleware(limiter))
```

---

## Issue #186: Systematic Secret Redaction (CRITICAL)

**Current State**: 315 routes access secrets, only 6 use redaction (2%)  
**Risk**: Credential exposure in logs, errors, responses  
**Blocked PRs**: #177 (partial — K8s only)  

### Decision 1: Redaction Scope

**Option A: Everywhere (Recommended)**
- Error messages
- Audit logs
- Response bodies
- Server logs
- K8s logs
- Debug endpoints

**Option B: Sensitive Paths Only**
- /api/environments, /api/api-keys, /api/webhooks
- Others left unredacted
- Risk: Easy to miss sensitive data

### Decision 2: Redaction Method

**Option A: Central Redaction Library (Recommended)**
- Reuse existing `lib/redact.ts`
- Patterns for all known secret types
- Applied consistently

**Option B: Per-Route Redaction**
- Custom redaction per endpoint
- Hard to maintain
- Risk of inconsistency

### Decision 3: Performance Impact

**Option A: Redact on Write**
- Redact before storing in DB or logs
- Performance hit at write time
- Logs are permanently clean

**Option B: Redact on Read**
- Redact when fetching logs/errors
- Runtime filtering
- Logs are stored in full (risky)

### Decision 4: Audit Log Impact

**Question**: Should audit logs themselves be redacted?
- If yes, auditors see redacted logs (less detail but safe)
- If no, full request details logged (detail but risky if logs leak)

**Recommendation:**
- Create separate "audit-safe" version of requests with sensitive fields removed
- Store in audit logs
- Store full request in temporary request log (TTL: 7 days)

### Recommendation

**Redact everything using `lib/redact.ts` patterns, applied on write. Create separate "audit-safe" request format for audit logs.**

---

## Issue #170: Comprehensive Input Validation (CRITICAL)

**Current State**: 31% of routes have some validation, 69% have none  
**Risk**: SQL injection, XSS, type confusion, DoS  
**Blocked PRs**: #184 (Batch 1 of 5-6 batches)  

### Decision 1: Validation Strategy

**Option A: Per-Route Zod Schemas (Recommended)**
- Explicit schema per endpoint
- Best error messages
- Schema documents API contract
- Requires ~140 schemas

**Option B: Middleware + Conventions**
- Automatic validation based on route pattern
- Less boilerplate
- Less explicit
- Harder to understand

**Option C: Hybrid (Recommended)**
- Middleware for common patterns
- Per-route overrides for custom logic
- Best of both worlds

### Decision 2: Rollout Strategy

**Option A: All Routes at Once**
- Comprehensive
- Risk of breaking changes
- May need backward compatibility layer

**Option B: Phased Rollout (Recommended)**
- Batch 1: Authentication endpoints (login, signup, 2FA)
- Batch 2: Admin endpoints
- Batch 3: API endpoints
- Batch 4: Internal endpoints
- Batch 5: Optional/rarely-used endpoints
- Monitor each batch for regressions

**Option C: Logging-Only Mode**
- Deploy validation without rejection
- Monitor for failures in production
- Switch to rejection after 2 weeks

### Decision 3: Backward Compatibility

**Question**: What about clients sending extra fields?

**Option A: Strict (Recommended)**
- Return 400 if extra fields sent
- Forces API contracts
- Better security

**Option B: Lenient**
- Ignore extra fields (Zod default)
- More forgiving
- Risk: undocumented fields accepted

### Recommendation

**Use per-route Zod schemas with middleware fallback. Phased rollout starting with auth/admin endpoints. Strict validation (reject extra fields). PR batches: 1 batch per 2-3 days.**

---

## Issue #165: Gateway MCP Auth (CRITICAL)

**Current State**: MCP endpoints have no authentication  
**Risk**: Unauthorized access to all gateway tools  
**Blocked PRs**: #176 (Ready for review)  

### Decision 1: Auth Mechanism

**Option A: Bearer Token (Recommended)**
- Same as REST /tools/execute
- Consistent with existing pattern
- Use `requireAuth` middleware

**Option B: API Key**
- Separate from HTTP auth
- Header-based
- Requires new infrastructure

### Recommendation

**Use existing `requireAuth` middleware on `/mcp` and `/mcp/message` routes. No new infrastructure needed. PR #176 appears ready.**

---

## Issue #168: db push Data Loss (CRITICAL)

**Current State**: entrypoint.sh uses `prisma db push --accept-data-loss`  
**Risk**: Production data destruction on misconfiguration  
**Blocked PRs**: #178 (Ready for review)  

### Decision 1: Migration Approach

**Option A: prisma migrate deploy (Recommended)**
- Production-safe
- Requires pre-made migrations
- No `--accept-data-loss`
- Fails safely if schema mismatch

**Option B: Manual Migration Script**
- Full control
- Complex
- Requires careful testing

### Decision 2: Development vs Production

**Question**: Separate entrypoint logic?

**Option A: One Entrypoint (Recommended)**
- Use `NODE_ENV` to determine behavior
- Production: `migrate deploy`
- Development: `db push`

**Option B: Separate Dockerfiles**
- prod.Dockerfile uses `migrate deploy`
- dev.Dockerfile uses `db push`
- More explicit

### Recommendation

**Replace `db push --accept-data-loss` with `migrate deploy`. Use `NODE_ENV` to detect production. PR #178 appears ready.**

---

## Summary Table

| Issue | Decision | Recommendation | Risk |
|-------|----------|---|------|
| #185 Rate Limit | Storage | Redis + in-memory fallback | Low (fallback safe) |
| #185 Rate Limit | Scope | Per-IP + per-user | Low (standard pattern) |
| #186 Redaction | Scope | Everything | Medium (performance) |
| #186 Redaction | Method | Central library | Low (existing code) |
| #186 Redaction | Audit | Separate safe format | Low (clear separation) |
| #170 Validation | Strategy | Per-route Zod + middleware | Low (explicit) |
| #170 Validation | Rollout | Phased (auth → admin → api) | Low (gradual) |
| #170 Validation | Compat | Strict (reject extra) | Medium (breaking) |
| #165 Gateway Auth | Mechanism | Existing Bearer token | None (already tested) |
| #168 db push | Approach | migrate deploy | Low (safe by design) |

---

## Questions for Opus

1. **Rate Limiting**: Approve Redis + fallback approach?
2. **Secret Redaction**: Approve "redact on write" + "audit-safe format"?
3. **Input Validation**: Approve phased rollout starting with auth?
4. **Backward Compat**: Okay to break clients sending extra fields?
5. **Timeline**: Prioritize #185, #186 first (most blocking)?

---

## Implementation Readiness

✅ **Ready to Start**:
- #165, #168 (PRs already in flight, just need approval)
- #185, #186, #170 (waiting on your architectural decisions)

⏳ **Awaiting Your Decision**:
- All architecture questions above

---

**Next Steps**:
1. Review this document
2. Approve recommendations or suggest alternatives
3. I'll proceed with implementation once approved
4. Create PRs from worktrees for each issue

---

**Prepared By**: Claude Code  
**Status**: Ready for Opus Architectural Review
