# SOC II Smoke Test Suite — Index & Quick Reference

**Created**: 2026-04-26  
**Test Suite Version**: 1.0  
**Coverage**: 7 SOC II Fixes, 31 Test Cases  
**Status**: Ready for Testing

---

## Test Suite Files

| File | Purpose | Audience |
|------|---------|----------|
| `TEST_SUITE_README.md` | Overview, quick start, troubleshooting | Everyone (start here) |
| `STAGING_SMOKE_TESTS.md` | Detailed test procedures & curl commands | QA/Security testers |
| `STAGING_SMOKE_TEST_RESULTS.md` | Results template for recording outcomes | QA/Security sign-off |
| `SMOKE_TESTS_QUICK_START.sh` | Automated test runner script | DevOps/CI-CD |
| `SOC2_TEST_INDEX.md` | This file — quick reference | Quick lookup |

---

## The 7 SOC II Fixes at a Glance

### 1. K8S-001: Console Log Redaction
- **Commit**: 2453214 fix: extend console wrapping to all output methods
- **What it does**: Redacts API keys, tokens, passwords from pod logs
- **Test approach**: Trigger errors, check logs for `***REDACTED***`
- **Pass criteria**: No raw secrets appear in logs
- **Runtime**: ~5 minutes

### 2. INPUT-001: Input Validation
- **Commits**: bac43d6, b709b55, 4ccc7d9, a9cd99b (Zod validation series)
- **What it does**: Validates all API input with Zod (20+ routes)
- **Test approach**: POST invalid data, expect 400 Bad Request
- **Pass criteria**: Invalid requests return 400, valid return 200/201
- **Runtime**: ~5 minutes

### 3. SQL-001: Parameterized Queries
- **Commit**: (PR #114 - verify via git log)
- **What it does**: Uses Prisma ORM for all DB queries (no string interpolation)
- **Test approach**: Enable query logging, check for $1, $2 syntax
- **Pass criteria**: All queries parameterized, SQL injection safely rejected
- **Runtime**: ~5 minutes

### 4. RATE-001: Redis Rate Limiting
- **Commit**: aa6fc33 merge: CSP-001 unsafe-inline removal and RATE-001 Redis limiter
- **What it does**: Enforces 10 requests/min limit with Redis backend
- **Test approach**: Make 11 rapid requests, check for 429 status
- **Pass criteria**: 11th request returns 429, rate limit headers present
- **Runtime**: ~10 minutes

### 5. CSP-001: Content Security Policy
- **Commit**: aa6fc33 merge: CSP-001 unsafe-inline removal
- **What it does**: Removes `unsafe-inline` from CSP, hardens XSS protection
- **Test approach**: Check CSP header, open browser DevTools for violations
- **Pass criteria**: CSP header present, no unsafe-inline, zero console violations
- **Runtime**: ~10 minutes (manual browser test)

### 6. SSO-001: HMAC Header Validation
- **Commit**: 8575180 feat: add HMAC-SHA256 validation for SSO headers
- **What it does**: Validates SSO headers with HMAC-SHA256 signature
- **Test approach**: Test with valid/invalid/missing HMAC
- **Pass criteria**: Valid HMAC → auth, invalid → 401, missing → 401
- **Runtime**: ~5 minutes

### 7. AUDIT-001: S3 Audit Log Export
- **Commits**: 2453214 feat: implement AUDIT-001 S3 log export, 26d7c77 refactor: support multiple backends
- **What it does**: Exports audit logs to S3 with tamper-evident hash chain
- **Test approach**: Trigger export, verify files in MinIO, check hash chain
- **Pass criteria**: Export completes, files appear in S3, manifest has hash chain
- **Runtime**: ~10 minutes

---

## Quick Test Checklist

### Pre-Test (5 minutes)
- [ ] git branch is `main`
- [ ] All services start: `docker-compose up -d`
- [ ] Health checks pass: `docker-compose ps` (all ✓)
- [ ] Database migrations applied: `docker-compose exec orion npx prisma migrate status`

### K8S-001 (5 min)
- [ ] Trigger error and check logs for redaction
- [ ] Verify all console methods (log, error, warn, info, debug)

### INPUT-001 (5 min)
- [ ] POST empty body to /api/tasks → expect 400
- [ ] POST valid data → expect 201
- [ ] Test 3-5 routes

### SQL-001 (5 min)
- [ ] Enable PostgreSQL query logging
- [ ] Check query logs for $1, $2 syntax (not interpolated SQL)

### RATE-001 (10 min)
- [ ] Make 11 rapid requests to /api/health
- [ ] Request 11 should return 429
- [ ] Check X-RateLimit-* headers

### CSP-001 (10 min)
- [ ] curl http://localhost:3000 | grep Content-Security-Policy
- [ ] Open browser, check DevTools console for violations
- [ ] Verify no "refused to apply style" warnings

### SSO-001 (5 min)
- [ ] Generate valid HMAC, POST to /api/auth/sso → auth succeeds
- [ ] Send invalid HMAC → expect 401
- [ ] Send no HMAC → expect 401

### AUDIT-001 (10 min)
- [ ] Trigger export: POST /api/admin/audit-export
- [ ] Check job status
- [ ] Verify files in MinIO bucket
- [ ] Verify manifest has hash chain

### Post-Test (5 min)
- [ ] Fill out STAGING_SMOKE_TEST_RESULTS.md
- [ ] Document any failures
- [ ] Get sign-off from security team

---

## Test Command Reference

### Environment Setup
```bash
cd /opt/orion/deploy
cp .env.example .env
# Edit .env with your settings
docker-compose up -d
sleep 30
docker-compose ps  # Verify all healthy
```

### K8S-001: Check Log Redaction
```bash
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{"name": "Test with API Key: orion_ak_abcd1234efgh5678"}'

docker-compose logs orion | grep -i "redact\|orion_ak_"
```

### INPUT-001: Check Validation
```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 400 Bad Request

curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Valid Task", "priority": "high"}'
# Expected: 201 Created
```

### SQL-001: Check Query Logging
```bash
# Enable logging
docker-compose exec postgres psql -U orion -d orion -c \
  "ALTER SYSTEM SET log_statement = 'all'; SELECT pg_reload_conf();"

# Make a request to trigger queries
curl -X GET http://localhost:3000/api/agents

# Check logs for parameterized queries
docker-compose logs postgres | grep "SELECT.*\$1" | head -1
```

### RATE-001: Check Rate Limiting
```bash
# Quick test: 11 requests
for i in {1..11}; do
  curl -s -o /dev/null -w "Request $i: %{http_code}\n" http://localhost:3000/api/health
  sleep 0.2
done
# Expected: 10×200, 1×429
```

### CSP-001: Check CSP Header
```bash
curl -sD /dev/stdout http://localhost:3000 | grep -i "content-security-policy"
# Should NOT contain "unsafe-inline"
```

### SSO-001: Check HMAC Validation
```bash
# Test without HMAC (should fail)
curl -X POST http://localhost:3000/api/auth/sso \
  -H "X-SSO-User: testuser" \
  -d '{}'
# Expected: 401
```

### AUDIT-001: Check Export
```bash
curl -X POST http://localhost:3000/api/admin/audit-export \
  -H "Authorization: Bearer <token>"
# Expected: 200 with jobId

# Check MinIO for files
docker-compose exec minio mc ls local/orion-audit-logs/
```

### View Service Logs
```bash
docker-compose logs orion          # ORION logs
docker-compose logs postgres       # PostgreSQL logs
docker-compose logs redis          # Redis logs
docker-compose logs minio          # MinIO logs

docker-compose logs -f orion       # Follow in real-time
docker-compose logs --tail 50 orion # Last 50 lines
```

---

## Environment Variables Needed

### Core (Required)
```
NEXTAUTH_SECRET              # Session secret (generate with openssl rand -base64 32)
POSTGRES_PASSWORD            # Database password
```

### Redis (Required for RATE-001)
```
REDIS_URL                    # redis://redis:6379/0
```

### SSO (Required for SSO-001)
```
SSO_HMAC_SECRET              # generate with openssl rand -hex 32
```

### S3/MinIO (Required for AUDIT-001)
```
AUDIT_EXPORT_S3_BACKEND      # minio
AUDIT_EXPORT_S3_ENDPOINT     # http://minio:9000
AUDIT_EXPORT_S3_REGION       # us-east-1
AUDIT_EXPORT_S3_BUCKET       # orion-audit-logs
AWS_ACCESS_KEY_ID            # minioadmin
AWS_SECRET_ACCESS_KEY        # minioadmin
```

---

## Pass/Fail Criteria Summary

| Fix | PASS Criteria | FAIL Criteria |
|-----|---------------|---------------|
| K8S-001 | All secrets redacted in logs | Raw secrets appear in logs |
| INPUT-001 | Invalid input → 400, valid → 201 | All requests succeed or wrong status |
| SQL-001 | Queries use $1, $2 syntax | String interpolation found |
| RATE-001 | 11th request = 429, headers present | Rate limit not enforced |
| CSP-001 | CSP header present, no violations | unsafe-inline present or CSP violations |
| SSO-001 | Valid HMAC→auth, invalid→401 | Always rejects or always accepts |
| AUDIT-001 | Export succeeds, files in S3, hash chain | Export fails or no files appear |

---

## Test Results Sign-Off

After completing all tests, sign off on:

```markdown
## SOC II Smoke Test Sign-Off

- [ ] All 7 fixes tested
- [ ] Results documented in STAGING_SMOKE_TEST_RESULTS.md
- [ ] No critical issues remaining
- [ ] All failures have remediation plan
- [ ] Security review completed
- [ ] Ready for production deployment

**QA Lead**: _________________ Date: _______
**Security**: _________________ Date: _______
**Release Mgr**: _________________ Date: _______
```

---

## Support Resources

| Issue | Resource |
|-------|----------|
| How do I run the tests? | → TEST_SUITE_README.md |
| Detailed test procedures? | → STAGING_SMOKE_TESTS.md |
| How do I record results? | → STAGING_SMOKE_TEST_RESULTS.md |
| Test script not working? | → Troubleshooting section in TEST_SUITE_README.md |
| What does K8S-001 test? | → Section 1 of STAGING_SMOKE_TESTS.md |
| What does INPUT-001 test? | → Section 2 of STAGING_SMOKE_TESTS.md |
| SQL injection tests? | → Section 3 of STAGING_SMOKE_TESTS.md |
| Rate limiting tests? | → Section 4 of STAGING_SMOKE_TESTS.md |
| CSP header tests? | → Section 5 of STAGING_SMOKE_TESTS.md |
| SSO/HMAC tests? | → Section 6 of STAGING_SMOKE_TESTS.md |
| S3 export tests? | → Section 7 of STAGING_SMOKE_TESTS.md |

---

## Timeline for Full Test Run

| Phase | Duration | What's Tested |
|-------|----------|---------------|
| Setup | 5-10 min | Docker services start, health checks pass |
| K8S-001 | 5 min | Log redaction |
| INPUT-001 | 5 min | Input validation |
| SQL-001 | 5 min | Query parameterization |
| RATE-001 | 10 min | Rate limiting (includes wait time) |
| CSP-001 | 10 min | CSP headers + browser console check |
| SSO-001 | 5 min | HMAC validation |
| AUDIT-001 | 10 min | S3 export (includes job wait time) |
| Cleanup | 2 min | Stop services, archive logs |
| **Total** | **45-55 min** | All 7 fixes validated |

---

## Next Steps After Testing

1. **Document Results**: Fill out STAGING_SMOKE_TEST_RESULTS.md completely
2. **Get Approvals**: Share results with QA Lead and Security team
3. **Fix Any Issues**: If failures found, see troubleshooting guide
4. **Archive Evidence**: Save logs and results for compliance audit
5. **Deploy to Production**: Once approved by QA/Security
6. **Monitor in Prod**: Watch logs and metrics for first 24 hours

---

## Document Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-26 | Initial release with all 7 fixes |

---

**Questions?** Start with TEST_SUITE_README.md or STAGING_SMOKE_TESTS.md for your specific test.

**Ready to test?** Run: `chmod +x SMOKE_TESTS_QUICK_START.sh && ./SMOKE_TESTS_QUICK_START.sh all`
