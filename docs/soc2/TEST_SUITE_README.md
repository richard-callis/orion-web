# SOC II Compliance Smoke Test Suite — README

## Overview

This test suite provides comprehensive validation of all 7 SOC II remediation fixes merged to ORION's main branch:

1. **K8S-001**: Console Log Redaction — Prevents secrets leaking in pod logs
2. **INPUT-001**: Input Validation — Zod validation on 20+ API routes
3. **SQL-001**: Parameterized Queries — Prevents SQL injection
4. **RATE-001**: Redis Rate Limiting — Distributed rate limiting with Redis fallback
5. **CSP-001**: Content Security Policy — Removes unsafe-inline styles
6. **SSO-001**: HMAC Header Validation — Prevents header injection
7. **AUDIT-001**: S3 Audit Log Export — Export logs with hash chain integrity

**Status**: All 7 fixes merged to main (as of 2026-04-26)  
**Test Coverage**: 31 individual test cases  
**Estimated Runtime**: 30-45 minutes (manual + browser tests)  
**Environment**: Staging (Docker Compose with PostgreSQL, Redis, MinIO)

---

## Quick Start

### 1. Start the Test Environment

```bash
cd /opt/orion/deploy

# Copy and configure environment
cp .env.example .env
# Edit .env with your settings (see below for configuration)

# Start all services (Redis, PostgreSQL, MinIO, ORION)
docker-compose up -d

# Wait for health checks
sleep 30

# Verify all services are healthy
docker-compose ps
```

**Expected**: All services show `Up` with ✓ health checks.

### 2. Run Quick Smoke Tests

```bash
# Make the test script executable
chmod +x /opt/orion/SMOKE_TESTS_QUICK_START.sh

# Run all tests
./SMOKE_TESTS_QUICK_START.sh all

# Or run steps individually
./SMOKE_TESTS_QUICK_START.sh setup      # Initialize
./SMOKE_TESTS_QUICK_START.sh run        # Run tests
./SMOKE_TESTS_QUICK_START.sh cleanup    # Tear down
```

### 3. Review Results

Results are saved to `test-results/` directory:

```
test-results/
├── YYYYMMDD_HHMMSS/
│   ├── test-results.txt
│   ├── orion.log
│   ├── postgres.log
│   └── redis.log
```

Review the main test document for detailed instructions:

```bash
cat /opt/orion/STAGING_SMOKE_TESTS.md
```

---

## Environment Configuration

### Minimal Configuration (`.env`)

```bash
# ── Required ───────────────────────────────────
MANAGEMENT_IP=127.0.0.1
ORION_DOMAIN=localhost
NEXTAUTH_SECRET=dev-secret-generate-with-openssl-rand-base64-32
POSTGRES_PASSWORD=postgres-dev-password

# ── Redis (for RATE-001) ───────────────────────
REDIS_URL=redis://redis:6379/0

# ── MinIO (for AUDIT-001) ──────────────────────
AUDIT_EXPORT_S3_BACKEND=minio
AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin

# ── SSO (for SSO-001) ──────────────────────────
SSO_HMAC_SECRET=<generate-with-openssl-rand-hex-32>
```

### Generate Secrets

```bash
# NEXTAUTH_SECRET
openssl rand -base64 32

# SSO_HMAC_SECRET
openssl rand -hex 32
```

---

## Test Files

### 1. Main Test Suite: `STAGING_SMOKE_TESTS.md`

Comprehensive test procedures for all 7 fixes. Includes:
- Detailed test steps with curl commands
- Expected outcomes for each test
- Manual browser-based tests (CSP)
- Troubleshooting guide
- Environment setup instructions

**Usage**: Read section-by-section for each fix you're testing.

### 2. Results Template: `STAGING_SMOKE_TEST_RESULTS.md`

Template for recording test results. Includes:
- Checkboxes for pass/fail on each test
- Space for actual vs. expected results
- Known issues and resolutions tracking
- Sign-off section for QA/Security approval

**Usage**: Copy this file and fill it out as you run tests:
```bash
cp STAGING_SMOKE_TEST_RESULTS.md STAGING_SMOKE_TEST_RESULTS_$(date +%Y%m%d).md
```

### 3. Quick Test Script: `SMOKE_TESTS_QUICK_START.sh`

Automated test runner with setup and cleanup. Includes:
- Service health verification
- Automated smoke tests for all 7 fixes
- Log collection and summarization
- Cleanup (optional)

**Usage**:
```bash
# Full automated run
./SMOKE_TESTS_QUICK_START.sh all

# Individual steps
./SMOKE_TESTS_QUICK_START.sh setup      # Start services
./SMOKE_TESTS_QUICK_START.sh run        # Run tests
./SMOKE_TESTS_QUICK_START.sh cleanup    # Stop services
```

---

## Test Execution Workflow

### For Manual Testing (Recommended for First Run)

1. **Setup Environment** (5-10 minutes)
   ```bash
   cd deploy
   cp .env.example .env
   # Edit .env with required values
   docker-compose up -d
   sleep 30
   docker-compose ps  # Verify all services healthy
   ```

2. **Run Each Test** (30-40 minutes)
   - Open `STAGING_SMOKE_TESTS.md`
   - Work through each test section (K8S-001 through AUDIT-001)
   - Execute curl commands in terminal
   - Open browser for CSP test (Test 5)
   - Record results in `STAGING_SMOKE_TEST_RESULTS.md`

3. **Cleanup** (2 minutes)
   ```bash
   docker-compose down
   ```

### For Automated Testing (Faster, CI/CD)

```bash
chmod +x /opt/orion/SMOKE_TESTS_QUICK_START.sh
./SMOKE_TESTS_QUICK_START.sh all
```

This runs the same tests in ~10 minutes (less comprehensive, no manual browser checks).

---

## What Each Test Validates

### K8S-001: Console Log Redaction
- **What it tests**: Secrets are redacted from pod logs
- **How**: Triggers errors and checks logs for `***REDACTED***` or masked values
- **Passes if**: API keys, tokens, passwords never appear in raw form in logs
- **Critical for**: SOC II requirement that secrets don't leak in logs

### INPUT-001: Input Validation
- **What it tests**: API routes reject invalid input with 400 Bad Request
- **How**: Sends invalid payloads to routes (missing fields, wrong types, etc.)
- **Passes if**: All invalid requests return 400 with validation error details
- **Critical for**: SOC II requirement for input validation; prevents XSS/injection

### SQL-001: Parameterized Queries
- **What it tests**: Database queries use parameterized statements
- **How**: Enables PostgreSQL query logging, checks for $1, $2 syntax
- **Passes if**: All queries use Prisma ORM with parameters, not string interpolation
- **Critical for**: SOC II requirement to prevent SQL injection attacks

### RATE-001: Redis Rate Limiting
- **What it tests**: Rate limiting enforces 10 requests/min limit
- **How**: Makes 11 rapid requests, checks for 429 status on 11th
- **Passes if**: 11th request returns 429, headers show rate limit info
- **Critical for**: SOC II DDoS protection; prevents brute force attacks

### CSP-001: Content Security Policy
- **What it tests**: Content Security Policy headers prevent XSS
- **How**: Checks for CSP header, browser DevTools console for violations
- **Passes if**: CSP header present without unsafe-inline, no console violations
- **Critical for**: SOC II XSS protection; hardens web security

### SSO-001: HMAC Header Validation
- **What it tests**: SSO headers are validated with HMAC signature
- **How**: Makes SSO requests with valid/invalid/missing HMAC
- **Passes if**: Valid HMAC → auth, invalid HMAC → 401, missing HMAC → 401
- **Critical for**: SOC II requirement to prevent header injection if proxy compromised

### AUDIT-001: S3 Audit Log Export
- **What it tests**: Audit logs exported to S3 with tamper-evident hash chain
- **How**: Triggers export job, verifies files in MinIO, checks manifest hash
- **Passes if**: Logs exported, manifest contains hash chain, old logs deleted
- **Critical for**: SOC II requirement for audit log archival and retention

---

## Common Test Patterns

### Testing with curl

All API tests use curl. Examples:

```bash
# GET request
curl -X GET http://localhost:3000/api/agents

# POST with JSON body
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Task", "priority": "high"}'

# POST with custom headers
curl -X POST http://localhost:3000/api/auth/sso \
  -H "X-SSO-User: test-user" \
  -H "X-SSO-HMAC-SHA256: signature-here"

# Check response status code
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/health

# Show response headers and body
curl -sD /dev/stdout http://localhost:3000
```

### Using jq to Parse JSON

```bash
# Extract field from response
curl -s http://localhost:3000/api/agents | jq '.data[0].id'

# Filter and format
curl -s http://localhost:3000/api/agents | jq '.data[] | {id, name}'

# Check if field exists
curl -s http://localhost:3000/api/health | jq '.db'
```

### Capturing Logs from Services

```bash
# View logs from a service
docker-compose logs orion

# Follow logs in real-time
docker-compose logs -f orion

# Show last N lines
docker-compose logs --tail 50 orion

# Save logs to file
docker-compose logs orion > /tmp/orion.log 2>&1
```

---

## Troubleshooting

### Services Won't Start

**Problem**: Docker containers exit immediately or fail health checks.

**Diagnosis**:
```bash
docker-compose ps          # Check status
docker-compose logs orion  # View error logs
```

**Common Causes**:
- Missing `.env` file or invalid configuration
- Port conflicts (3000, 5432, 6379, 9000 already in use)
- Insufficient disk space or memory
- Database migrations failed

**Fix**:
1. Review `.env` configuration
2. Check Docker logs for specific errors
3. Run migrations: `docker-compose exec orion npx prisma migrate deploy`
4. Restart: `docker-compose down && docker-compose up -d`

### Test Fails: "Connection Refused"

**Problem**: `curl: (7) Failed to connect to localhost port 3000`

**Diagnosis**:
```bash
docker-compose ps orion  # Is it running?
docker-compose logs orion | tail -20  # What's the error?
```

**Fix**:
1. Wait longer for startup: `sleep 60 && curl http://localhost:3000/api/health`
2. Check logs for startup errors
3. Restart ORION: `docker-compose restart orion`
4. Rebuild image if needed: `docker-compose up --build -d`

### Test Fails: K8S-001 (Secrets in Logs)

**Problem**: Logs show raw secrets instead of `***REDACTED***`

**Diagnosis**:
```bash
docker-compose logs orion | grep -i "api_key\|bearer\|token" | head -5
```

**Fix**:
1. Verify `wrapConsoleLog()` is called on app startup
2. Check `lib/redact.ts` for redaction patterns
3. Restart app: `docker-compose restart orion`
4. Trigger error again to verify redaction

### Test Fails: INPUT-001 (Validation Not Working)

**Problem**: Invalid POST requests return 200 instead of 400

**Diagnosis**:
```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{}' -w "\nStatus: %{http_code}\n"
```

**Fix**:
1. Verify Zod validation schemas are applied to routes
2. Check route handler in `apps/web/src/app/api/`
3. Review validation middleware setup
4. Restart ORION if code changed: `docker-compose restart orion`

### Test Fails: RATE-001 (Rate Limit Not Working)

**Problem**: 11th request doesn't return 429, or headers missing

**Diagnosis**:
```bash
# Verify Redis is running
docker-compose logs redis | tail -10

# Check REDIS_URL is set
docker-compose exec orion printenv REDIS_URL
```

**Fix**:
1. Start Redis: `docker-compose up -d redis`
2. Verify Redis connectivity: `docker-compose exec redis redis-cli ping`
3. Check rate limiter middleware is active
4. Restart ORION: `docker-compose restart orion`
5. Re-run test (rate limits reset after 60 seconds)

### Test Fails: CSP-001 (Styles Broken)

**Problem**: Browser page looks unstyled or broken

**Diagnosis**:
1. Open http://localhost:3000 in Chrome/Firefox
2. Press F12 → Console tab
3. Look for "refused to apply style" warnings

**Fix**:
1. Clear browser cache: Ctrl+Shift+Delete
2. Hard refresh: Ctrl+F5
3. Check CSP header: `curl -sD /dev/stdout http://localhost:3000 | grep -i content-security-policy`
4. Verify no `unsafe-inline` in style-src
5. Add `'nonce-...'` if needed for inline styles

### Test Fails: SSO-001 (HMAC Always Rejected)

**Problem**: Even valid HMAC signatures are rejected

**Diagnosis**:
```bash
# Verify secret is set
docker-compose exec orion printenv SSO_HMAC_SECRET

# Check HMAC generation
echo -n "test-user|test@example.com|Test|uid|1234567890000" \
  | openssl dgst -sha256 -mac HMAC -macopt "key=YOUR_SECRET" -binary \
  | base64
```

**Fix**:
1. Verify `SSO_HMAC_SECRET` is set and matches in .env
2. Check canonical string format matches implementation
3. Use binary HMAC (not hex)
4. Verify base64 encoding of signature
5. Check timestamp is recent (< 30 seconds old)

### Test Fails: AUDIT-001 (Export Job Never Completes)

**Problem**: Export job stuck on "pending"

**Diagnosis**:
```bash
# Verify MinIO is running
docker-compose ps minio

# Check MinIO connectivity
docker-compose exec orion aws s3 ls s3://orion-audit-logs/ --endpoint-url http://minio:9000
```

**Fix**:
1. Start MinIO: `docker-compose up -d minio`
2. Create bucket if needed:
   ```bash
   docker-compose exec minio mc mb local/orion-audit-logs
   ```
3. Check AUDIT_EXPORT_S3_ENDPOINT in .env
4. Verify credentials (AWS_ACCESS_KEY_ID, etc.)
5. Check ORION logs for S3 errors: `docker-compose logs orion | grep -i "s3\|minio\|export"`
6. Restart ORION: `docker-compose restart orion`

---

## Advanced Testing

### Enable Verbose Logging

```bash
# Set debug logging for ORION
docker-compose exec orion printenv NODE_ENV

# Or update .env and restart
# NODE_ENV=development (for more verbose logs)

docker-compose restart orion
docker-compose logs -f orion
```

### Test Against Production-like Configuration

Use a separate `.env.prod` for production-like testing:

```bash
# Copy production configuration
cp deploy/.env.example deploy/.env.prod

# Set production values
vi deploy/.env.prod
# - Set real NEXTAUTH_SECRET
# - Set real SSO_HMAC_SECRET
# - Use AWS S3 instead of MinIO
# - Use production Redis URL (if available)

# Start with production config
cd deploy
export COMPOSE_PROJECT_NAME=orion_prod
docker-compose --file docker-compose.yml --env-file .env.prod up -d
```

### Capture Network Traffic

```bash
# Monitor HTTP requests with tcpdump
sudo tcpdump -i lo -n 'tcp port 3000 or tcp port 5432' -A | head -100

# Or use mitmproxy if testing through proxy
mitmproxy --mode reverse:http://localhost:3000
```

### Load Testing (Optional)

```bash
# Generate traffic to test rate limiting under load
ab -n 100 -c 10 http://localhost:3000/api/health

# Or with wrk
wrk -t4 -c100 -d10s http://localhost:3000/api/health
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: SOC II Smoke Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  smoke-tests:
    runs-on: ubuntu-latest
    
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      redis:
        image: redis:latest
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

      minio:
        image: minio/minio:latest
        env:
          MINIO_ROOT_USER: minioadmin
          MINIO_ROOT_PASSWORD: minioadmin
        options: >-
          --health-cmd "mc ready local"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v3

      - name: Setup environment
        run: |
          cd deploy
          cp .env.example .env
          sed -i 's/localhost/127.0.0.1/g' .env

      - name: Start services
        run: |
          cd deploy
          docker-compose up -d
          sleep 30

      - name: Run smoke tests
        run: |
          chmod +x SMOKE_TESTS_QUICK_START.sh
          ./SMOKE_TESTS_QUICK_START.sh run

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test-results/

      - name: Cleanup
        if: always()
        run: |
          cd deploy
          docker-compose down
```

---

## Documentation References

### Related Documents

- `STAGING_SMOKE_TESTS.md` — Detailed test procedures and curl commands
- `STAGING_SMOKE_TEST_RESULTS.md` — Results template for recording test outcomes
- `SOC2_REMEDIATION_PLAN.md` — Original remediation plan for all 7 fixes
- `context/api-routes.md` — API endpoint reference
- `context/schema.md` — Database schema reference

### External References

- [SOC II Type II Audit Requirements](https://www.soc2.org/)
- [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [Zod Documentation](https://zod.dev/)
- [Redis Rate Limiting](https://redis.io/docs/manual/client-side-caching/)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)

---

## Support & Escalation

### If Tests Fail

1. **Review logs**: `docker-compose logs [service] | tail -50`
2. **Check troubleshooting section** above
3. **Document in STAGING_SMOKE_TEST_RESULTS.md**
4. **Open GitHub issue** with:
   - Test that failed
   - Expected vs. actual result
   - Relevant logs
   - Environment details

### If Tests Pass

1. **Fill out STAGING_SMOKE_TEST_RESULTS.md completely**
2. **Get sign-off** from QA/Security team
3. **Archive test results** for compliance records
4. **Notify release manager** that fixes are validated
5. **Deploy to production** once approved

---

## Checklist: Before You Start Testing

- [ ] Git branch is `main` (production-ready code)
- [ ] All 7 fixes are merged (check git log)
- [ ] Docker and Docker Compose installed
- [ ] 50GB+ free disk space for images and data
- [ ] Ports 3000, 5432, 6379, 9000, 8200 are available
- [ ] `.env` file configured with all required variables
- [ ] Test plan reviewed (`STAGING_SMOKE_TESTS.md`)
- [ ] Results template copied (`STAGING_SMOKE_TEST_RESULTS.md`)
- [ ] Team notified of testing window
- [ ] Backup of current state created (if needed)

---

## Questions?

For questions or issues with the test suite:

1. Review the troubleshooting section above
2. Check the detailed test procedures in `STAGING_SMOKE_TESTS.md`
3. Review the main git commits for the 7 fixes
4. Open an issue with detailed steps to reproduce

---

**Test Suite Version**: 1.0  
**Last Updated**: 2026-04-26  
**Maintainer**: SOC II Audit Team  
**Status**: Ready for Production Testing
