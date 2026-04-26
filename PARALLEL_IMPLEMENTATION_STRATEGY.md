# Parallel Implementation Strategy — SOC II Phase 1 (4 Critical Paths)

**Date**: 2026-04-26  
**Approach**: Parallel worktrees for INPUT-001, SSO-001, K8S-001, AUDIT-001  
**Target**: Complete all 4 by 2026-05-02 (6 days)  

---

## Parallel Execution Plan

### Worktree 1: fix/input-validation-tier1 (INPUT-001)
**Status**: Phase 2 in progress (1/20 routes done)  
**Owner**: Continue from current state  
**Work**: Update 19 remaining routes with Zod validation  
**Effort**: 9-11 hours across remaining routes  
**Priority**: HIGH (blocking audit)  

**Routes to batch**:
- Auth batch (7 routes): 2-3 hours
- Admin batch (6 routes): 2-3 hours  
- Agent batch (3 routes): 1 hour
- Task batch (3 routes): 1 hour
- Feature/Epic batch (4 routes): 1 hour
- Testing & PR: 2 hours

### Worktree 2: fix/sso-header-hmac-validation (SSO-001)
**Status**: Not started  
**Owner**: Start fresh  
**Work**: HMAC-SHA256 validation for SSO headers  
**Effort**: 4-6 hours  
**Priority**: CRITICAL (P0 - exploitable vulnerability)  

**Tasks**:
1. Add HMAC validation function to lib/auth.ts
2. Update getCurrentUser() to validate HMAC signatures
3. Add timestamp checking (30-second tolerance)
4. Use timingSafeEqual for comparison
5. Add audit logging for failed attempts
6. Document HMAC secret management
7. Test with valid/invalid signatures

### Worktree 3: fix/k8s-logs-redaction (K8S-001)
**Status**: Not started  
**Owner**: Start fresh  
**Work**: Fix console.error/warn/info redaction gap  
**Effort**: 2-3 hours  
**Priority**: MEDIUM (real gap in log redaction)  

**Tasks**:
1. Extend wrapConsoleLog in lib/redact.ts
2. Add coverage for console.error, console.warn, console.info
3. Test that secrets in error logs are masked
4. Verify performance impact
5. Update documentation

### Worktree 4: fix/audit-log-retention (AUDIT-001)
**Status**: Not started  
**Owner**: Start fresh  
**Work**: Add S3 export before TTL-based deletion  
**Effort**: 6-8 hours  
**Priority**: HIGH (compliance requirement)  

**Tasks**:
1. Create scheduled export job (export logs to S3 before deletion)
2. Implement manifest generation with hash chain
3. Enable S3 Object Lock on archive
4. Gate manual cleanup behind archive verification
5. Document retention policy (12 months)
6. Test export/delete lifecycle
7. Add metrics/alerts for failed exports

---

## Parallel Execution Order

### Phase 1: INPUT-001 Completion (Primary focus)
1. Batch update auth routes (7 routes) — 2-3 hours
2. Batch update admin routes (6 routes) — 2-3 hours
3. Batch update remaining routes (agent/task/feature/epic) — 3 hours
4. Test & create PR — 2 hours
5. **Commit & merge to main**

### Phase 2: SSO-001 Implementation (Critical)
1. Implement HMAC validation in lib/auth.ts — 1 hour
2. Update getCurrentUser() with HMAC check — 1 hour
3. Add timestamp & timing-safe comparison — 1 hour
4. Audit logging + documentation — 1 hour
5. Test with signatures — 1 hour
6. **Commit & prepare for PR (ops coordination needed)**

### Phase 3: K8S-001 & AUDIT-001 (Parallel)
1. **K8S-001**: Extend console wrapping (2-3 hours)
   - Update wrapConsoleLog to cover all console methods
   - Test redaction effectiveness
   
2. **AUDIT-001**: S3 export job (6-8 hours)
   - Create scheduled export job
   - Implement manifest + S3 Object Lock
   - Test lifecycle

---

## Coordination Points

| Issue | Blocker | Owner | Status |
|-------|---------|-------|--------|
| INPUT-001 | None | Continue current | Phase 2 |
| SSO-001 | Ops (reverse proxy HMAC config) | Start fresh | Pending ops |
| K8S-001 | None | Parallel | Ready |
| AUDIT-001 | Ops (S3 bucket with Object Lock) | Parallel | Pending ops |

**Ops Prerequisites** (coordinate in parallel):
- [ ] Reverse proxy configured to compute HMAC signatures (for SSO-001)
- [ ] S3 bucket created with Object Lock enabled (for AUDIT-001)
- [ ] Redis Sentinel deployed (for RATE-001, separate from Phase 1)

---

## Merge Strategy

**Order to merge to main**:
1. ✅ INPUT-001 (must be done first - blocking audit)
2. ✅ SSO-001 (P0 - critical vulnerability)
3. ✅ K8S-001 (audit logging gap)
4. ✅ AUDIT-001 (compliance requirement)

**Testing before merge**:
- INPUT-001: Valid/invalid inputs, error messages, type safety
- SSO-001: Valid HMAC, invalid HMAC, expired timestamp, audit logs
- K8S-001: Secrets in error logs are masked
- AUDIT-001: Export/delete lifecycle, manifest integrity, Object Lock

---

## Timeline Estimates

| Work | Effort | Duration | Critical Path |
|------|--------|----------|----------------|
| INPUT-001 (remain) | 9-11h | 1-2 days | YES (day 1) |
| SSO-001 | 4-6h | 0.5-1 day | YES (day 2) |
| K8S-001 | 2-3h | 0.5 day | NO (parallel) |
| AUDIT-001 | 6-8h | 1-2 days | NO (parallel) |
| **Total** | **21-28h** | **2-3 days** | **Sequential on critical path** |

**Actual timeline**: 3-4 days (can parallelize K8S-001 & AUDIT-001 while SSO-001 waits for ops)

---

## Success Criteria

**INPUT-001**: ✅ All 20 Tier 1 routes validated with Zod
**SSO-001**: ✅ HMAC signatures required for SSO headers
**K8S-001**: ✅ All console methods have redaction coverage  
**AUDIT-001**: ✅ Logs exported to S3 before deletion, hash chain preserved

**Compliance Impact**: 75% → 95%+ SOC2 compliant

---

## Git Workflow

```bash
# For each worktree:
cd /opt/orion/.worktrees/fix/<issue>
git add <changed files>
git commit -m "fix/<issue>: ..."
git log --oneline | head

# When ready to merge:
git push origin <branch>
# Create PR on GitHub
# After review: merge to main
```

---

**Status**: Ready to execute all 4 in parallel. Starting now.
