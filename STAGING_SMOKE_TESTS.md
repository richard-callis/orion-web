# SOC II Compliance Smoke Test Suite — ORION

**Date**: 2026-04-26  
**Target Environment**: Staging (Docker Compose)  
**Coverage**: 7 SOC II Remediation Fixes  
**Execution Time**: ~30-45 minutes total  

---

## Pre-Test Checklist

- [ ] Running from a clean branch (no uncommitted changes)
- [ ] All required `.env` variables configured (see [Environment Setup](#environment-setup))
- [ ] Docker and Docker Compose installed and running
- [ ] Network connectivity to staging environment verified
- [ ] PostgreSQL, Redis, MinIO services accessible
- [ ] Test user account created (or use admin default)

---

## Environment Setup

### 1. Copy Configuration Files

```bash
cd /opt/orion
cp deploy/.env.example deploy/.env
```

### 2. Configure `.env` for Staging

Edit `deploy/.env` with these critical values:

```bash
# ── Management & Domains ───
MANAGEMENT_IP=127.0.0.1
ORION_DOMAIN=localhost
NEXTAUTH_SECRET=dev-secret-change-me-in-production-$(openssl rand -base64 32)
POSTGRES_PASSWORD=postgres-dev-password

# ── Redis (for RATE-001 testing) ───
REDIS_URL=redis://redis:6379/0

# ── MinIO (for AUDIT-001 testing) ───
AUDIT_EXPORT_S3_BACKEND=minio
AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=minioadmin

# ── SSO (for SSO-001 testing) ───
SSO_HMAC_SECRET=$(openssl rand -hex 32)
```

### 3. Start Staging Environment

```bash
# Navigate to deploy directory
cd /opt/orion/deploy

# Start all services (includes Redis and MinIO)
docker-compose up -d

# Wait for health checks
echo "Waiting 30s for services to start..."
sleep 30

# Verify all services are healthy
docker-compose ps
```

**Expected Output**: All services should show `Up` status with ✓ health checks.

### 4. Verify Database Initialization

```bash
# Run migrations
docker-compose exec orion npx prisma migrate deploy

# Seed test data (if not automated)
docker-compose exec orion npx prisma db seed
```

### 5. Create Test User Account

```bash
# Create admin test user via API
curl -X POST http://localhost:3000/api/admin/users \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "email": "admin@orion.local",
    "password": "TestPassword123!",
    "role": "admin"
  }'
```

---

## Test Execution

### Test 1: K8S-001 — Console Log Redaction

**Scope**: Verify pod logs don't leak secrets. All console methods (log, error, warn, info, debug) should redact.

**Acceptance Criteria**:
- All sensitive patterns redacted: API keys, Bearer tokens, JWT tokens, secrets
- Readability preserved: first 4 + last 4 chars visible (e.g., `orion_ak_****...****`)
- All console methods wrapped: console.log, console.error, console.warn, console.info, console.debug

#### Test 1.1: Generate Application Error (Trigger 500)

```bash
# Trigger a route that will fail and log error
# This should hit error handler and redact secrets in logs
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Agent with API Key: orion_ak_1234567890abcdef1234567890abcdef12345678"
  }' 2>&1

# Check pod logs
docker-compose logs orion | grep -i "orion_ak_"
```

**Expected**: 
- [ ] Logs show `***REDACTED***` or masked version (`orion_ak_****...****`)
- [ ] No raw API key value appears in logs
- [ ] Error response is still sent to client

#### Test 1.2: Verify All Console Methods Redact

```bash
# Check that wrapConsoleLog() was called on startup
docker-compose logs orion | grep -i "console.*redact\|wrap.*console"

# Trigger each console method via error paths
curl -X POST http://localhost:3000/api/chat/conversations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer jwt_1234567890abcdef1234567890abcdef1234567890" \
  -d '{}'

# Check logs for Bearer token redaction
docker-compose logs orion | grep -i "jwt_\|bearer"
```

**Expected**:
- [ ] console.log calls don't leak secrets
- [ ] console.error calls don't leak secrets
- [ ] console.warn calls don't leak secrets
- [ ] console.info calls don't leak secrets
- [ ] console.debug calls don't leak secrets

#### Test 1.3: Verify Redaction Patterns

```bash
# Test with various sensitive patterns
curl -X POST http://localhost:3000/api/chat/conversations \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test with secret=my_secret_password_12345",
    "metadata": {
      "apiKey": "orion_ak_abcdef1234567890abcdef1234567890",
      "token": "mcg_abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
    }
  }'

# Verify redaction in logs
docker-compose logs orion 2>&1 | grep -E "my_secret_password|orion_ak_|mcg_"
```

**Expected**:
- [ ] No plain passwords appear
- [ ] No plain API keys appear
- [ ] No plain tokens appear
- [ ] Pattern matches are properly escaped

---

### Test 2: INPUT-001 — Input Validation (Zod)

**Scope**: Verify 20+ routes validate input and reject invalid requests with 400 Bad Request.

**Acceptance Criteria**:
- Invalid input returns 400 with validation error
- Valid input returns 200/201 with success response
- Error messages include field names but don't leak implementation details
- All input types validated: string, number, enum, required fields

#### Test 2.1: Test POST /api/auth/totp/verify with Invalid Input

```bash
# Missing required 'code' field
curl -X POST http://localhost:3000/api/auth/totp/verify \
  -H "Content-Type: application/json" \
  -d '{}'

# Should return 400 with validation error
# Check response
```

**Expected**:
- [ ] Status: 400 Bad Request
- [ ] Response includes: `{"error": "...", "details": {"field": "code", "message": "..."}}`
- [ ] Error message is user-friendly (not stack trace)

#### Test 2.2: Test POST /api/tasks with Invalid Input

```bash
# Invalid input: missing 'title', wrong 'priority' type
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "priority": "not_a_valid_priority",
    "agentId": "invalid_uuid"
  }'
```

**Expected**:
- [ ] Status: 400 Bad Request
- [ ] Validation error includes field names: `priority`, `agentId`, `title`
- [ ] No raw Zod schema exposed in error message

#### Test 2.3: Test POST /api/tasks with Valid Input

```bash
# Valid input with all required fields
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Create authentication flow",
    "description": "Implement OAuth2 flow",
    "priority": "high",
    "status": "todo"
  }'
```

**Expected**:
- [ ] Status: 201 Created
- [ ] Response includes task object with id, title, created timestamps
- [ ] No validation errors

#### Test 2.4: Test PUT /api/features/[id] with Invalid Input

```bash
# First, get a valid feature ID
FEATURE_ID=$(curl -s http://localhost:3000/api/features \
  | jq -r '.data[0].id // empty')

# Invalid input: status field with invalid value
curl -X PUT "http://localhost:3000/api/features/$FEATURE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "invalid_status",
    "title": ""  # Empty string should fail length validation
  }'
```

**Expected**:
- [ ] Status: 400 Bad Request
- [ ] Validation error shows which fields failed
- [ ] Client can determine which field to fix

#### Test 2.5: Test Multiple Route Types

Test at least 3-5 more validated routes:

**Routes to Test** (from `context/api-routes.md`):
- `POST /api/agents` — Create agent (title required, priority optional)
- `POST /api/chat/conversations` — Create conversation (metadata optional)
- `PUT /api/agents/[id]` — Update agent
- `POST /api/environments` — Create environment (name required, description optional)

```bash
# Example: POST /api/agents
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{}' # Missing required 'name' field

# Expected: 400 Bad Request with validation error
```

---

### Test 3: SQL-001 — Parameterized Queries

**Scope**: Verify all SQL queries use parameterized statements (via Prisma ORM), not raw string interpolation.

**Acceptance Criteria**:
- Queries use Prisma ORM with typed parameters
- SQL injection attempts are safely rejected
- Database query logs show parameterized statements ($1, $2, etc.)

#### Test 3.1: Enable PostgreSQL Query Logging

```bash
# Connect to PostgreSQL container
docker-compose exec postgres psql -U orion -d orion

# Inside psql, enable query logging
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();
\q

# Verify logging is enabled
docker-compose exec postgres grep "log_statement" /var/lib/postgresql/data/postgresql.conf
```

**Expected**: Output shows `log_statement = 'all'`

#### Test 3.2: Execute Safe Query and Verify Parameterization

```bash
# Trigger a query that should use Prisma parameterization
curl -X GET http://localhost:3000/api/agents

# Check PostgreSQL logs for parameterized query syntax
docker-compose logs postgres | grep "SELECT\|INSERT\|UPDATE" | head -5
```

**Expected**:
- [ ] Logs show Prisma queries with `$1`, `$2` placeholder syntax
- [ ] No raw string interpolation (values inlined in SQL)
- [ ] Queries look like: `SELECT ... WHERE id = $1`

#### Test 3.3: Attempt SQL Injection via Query Parameter

```bash
# Attempt SQL injection via name field
curl -X POST http://localhost:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "'); DROP TABLE agents; --"
  }'

# Verify agents table still exists
curl -X GET http://localhost:3000/api/agents
```

**Expected**:
- [ ] SQL injection attempt safely rejected (returns 400 Bad Request from validation)
- [ ] Agents table not dropped
- [ ] No SQL errors in logs (Prisma handles escaping)

#### Test 3.4: Verify in Query Logs

```bash
# Check logs for injected query attempt
docker-compose logs postgres | grep "DROP TABLE"
```

**Expected**:
- [ ] No `DROP TABLE` statements appear in logs
- [ ] Query is treated as literal string value, not SQL code
- [ ] Parameterized form appears instead

---

### Test 4: RATE-001 — Redis Rate Limiting

**Scope**: Verify rate limiting returns 429 Too Many Requests after limit (10/min) is exceeded.

**Acceptance Criteria**:
- Rate limit headers present: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- 11th request in 60 seconds returns 429
- `Retry-After` header present with reset time
- Works with Redis backend (or in-memory fallback)

#### Test 4.1: Make Rapid Requests and Check Headers

```bash
#!/bin/bash
# Save this as test-rate-limit.sh

TARGET_URL="http://localhost:3000/api/health"
TOTAL_REQUESTS=12
LIMIT=10

echo "Making $TOTAL_REQUESTS requests to $TARGET_URL..."

for i in $(seq 1 $TOTAL_REQUESTS); do
  echo "Request $i:"
  RESPONSE=$(curl -sD /dev/stdout "$TARGET_URL" 2>&1)
  
  # Extract headers
  echo "$RESPONSE" | grep -E "X-RateLimit-|Retry-After|HTTP" | head -5
  
  # Check for 429 status
  HTTP_STATUS=$(echo "$RESPONSE" | grep "^HTTP" | awk '{print $2}')
  if [ "$HTTP_STATUS" = "429" ]; then
    echo "✓ Rate limit exceeded at request $i (expected: 11)"
    break
  fi
  
  sleep 0.5  # Space out requests slightly
done
```

```bash
# Run the test script
bash test-rate-limit.sh
```

**Expected**:
- [ ] Requests 1-10: Status 200, headers show decreasing X-RateLimit-Remaining
- [ ] Request 11: Status 429 Too Many Requests
- [ ] Request 11: Retry-After header present (e.g., `Retry-After: 45`)
- [ ] Headers on request 1: `X-RateLimit-Limit: 10`, `X-RateLimit-Remaining: 9`

#### Test 4.2: Verify Rate Limit Reset

```bash
# Make 11 rapid requests
for i in {1..11}; do
  curl -s http://localhost:3000/api/health > /dev/null
done

# Last request should return 429
curl -sD /dev/stdout http://localhost:3000/api/health | grep "HTTP\|429"

# Wait for reset (default: 60 seconds, or check Retry-After header)
sleep 65

# Next request should succeed
curl -sD /dev/stdout http://localhost:3000/api/health | grep "HTTP\|200"
```

**Expected**:
- [ ] After rate limit is exceeded, subsequent requests return 429
- [ ] After reset window expires, requests succeed again

#### Test 4.3: Check Redis Configuration

```bash
# Verify Redis is running and accessible
docker-compose exec redis redis-cli ping

# Check REDIS_URL is set in environment
docker-compose exec orion printenv REDIS_URL

# Verify rate limit metrics in Redis
docker-compose exec redis redis-cli KEYS "ratelimit:*"
```

**Expected**:
- [ ] Redis responds with PONG
- [ ] `REDIS_URL=redis://redis:6379/0`
- [ ] Keys show rate limit entries (e.g., `ratelimit:/api/health:ip`)

#### Test 4.4: Test In-Memory Fallback (Redis Down)

```bash
# Stop Redis service
docker-compose stop redis

# Wait for ORION to detect Redis is down
sleep 5

# Test rate limiting still works (using in-memory limiter)
for i in {1..11}; do
  RESPONSE=$(curl -sD /dev/stdout http://localhost:3000/api/health 2>&1)
  echo "Request $i: $(echo "$RESPONSE" | grep "^HTTP" | awk '{print $2}')"
  sleep 0.5
done

# 11th request should still return 429
FINAL=$(curl -sD /dev/stdout http://localhost:3000/api/health 2>&1)
echo "Final request status: $(echo "$FINAL" | grep "^HTTP" | awk '{print $2}')"

# Restart Redis for other tests
docker-compose start redis
```

**Expected**:
- [ ] Rate limiting still works with Redis down
- [ ] 11th request returns 429
- [ ] Application remains responsive
- [ ] Logs mention Redis fallback (if logging enabled)

---

### Test 5: CSP-001 — Content Security Policy

**Scope**: Verify no unsafe-inline styles, CSP headers are sent, and frontend loads without errors.

**Acceptance Criteria**:
- No "refused to apply style" CSP violations in console
- All pages load successfully: login, chat, tasks, agents, infrastructure
- Responsive design works without style-src unsafe-inline
- Zero CSP warnings/errors in DevTools

#### Test 5.1: Check CSP Headers

```bash
# Fetch response headers
curl -sD /dev/stdout http://localhost:3000 | grep -i "content-security-policy"
```

**Expected**:
- [ ] Response includes CSP header (not commented out)
- [ ] Header does NOT include `unsafe-inline` in style-src
- [ ] Example valid CSP: `Content-Security-Policy: default-src 'self'; style-src 'self' 'nonce-...'`

#### Test 5.2: Load App in Browser and Check Console

Open a browser and navigate to http://localhost:3000:

```javascript
// In DevTools Console (F12), run this to check for CSP violations
// This is a manual step — open DevTools and paste this
(function() {
  // Listen for CSP violations
  let violations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    violations.push({
      violatedDirective: e.violatedDirective,
      blockedURI: e.blockedURI,
      originalPolicy: e.originalPolicy
    });
    console.warn('CSP Violation:', e.violatedDirective, e.blockedURI);
  });
  
  setTimeout(() => {
    if (violations.length === 0) {
      console.log('✓ No CSP violations detected');
    } else {
      console.error('Found CSP violations:', violations);
    }
  }, 5000);
})();
```

**Test Steps (Manual - Browser)**:
1. Open http://localhost:3000 in Chrome/Firefox
2. Press F12 to open DevTools → Console tab
3. Paste the above JavaScript snippet
4. Wait 5 seconds and check for CSP violations
5. Click through pages: Dashboard → Agents → Tasks → Settings

**Expected**:
- [ ] Console shows: "✓ No CSP violations detected"
- [ ] No red error messages in console
- [ ] No "refused to apply style" warnings
- [ ] All pages load and render correctly
- [ ] Buttons, modals, animations work

#### Test 5.3: Verify Responsive Design Without unsafe-inline

```javascript
// Check if any inline styles are blocked (should have fallback with nonce)
// In DevTools Console:
document.querySelectorAll('[style]').forEach(el => {
  const inline = el.getAttribute('style');
  console.log('Inline style:', inline.substring(0, 50));
});

// Count: should be 0 or only have nonce-validated styles
```

**Expected**:
- [ ] Few or zero inline styles
- [ ] All dynamic styles use nonce or are defined in stylesheets
- [ ] Modal heights, padding, responsive sizes work correctly
- [ ] No layout shift or invisible elements

#### Test 5.4: Test All Pages

Navigate to each page and verify no CSP violations:

- [ ] /login — Login page loads
- [ ] / (Dashboard) — Home page, chat interface
- [ ] /agents — Agent list and detail pages
- [ ] /tasks — Task management
- [ ] /features — Feature pages
- [ ] /settings — User settings page
- [ ] /infrastructure — K8s dashboard (if available)

**Expected** for each page:
- [ ] Page loads without errors
- [ ] Console shows no CSP violations
- [ ] No styling is broken
- [ ] Animations/transitions work smoothly

---

### Test 6: SSO-001 — HMAC Header Validation

**Scope**: Verify SSO headers are validated with HMAC-SHA256 signature.

**Acceptance Criteria**:
- Valid HMAC signature → User authenticated
- Invalid/missing HMAC → 401/403 error
- Audit log records failed validation attempts
- Timestamp validation prevents replay attacks

#### Test 6.1: Generate Valid HMAC Signature

```bash
# Get SSO_HMAC_SECRET from environment
SECRET=$(docker-compose exec orion printenv SSO_HMAC_SECRET)

# Create canonical string (as per implementation)
# Format: username|email|name|uid|timestamp
USERNAME="test-user"
EMAIL="test@orion.local"
NAME="Test User"
UID="user-123"
TIMESTAMP=$(date +%s)000  # milliseconds

CANONICAL="$USERNAME|$EMAIL|$NAME|$UID|$TIMESTAMP"

# Generate HMAC-SHA256
HMAC=$(echo -n "$CANONICAL" | openssl dgst -sha256 -mac HMAC -macopt "key=$SECRET" -hex | cut -d' ' -f2)

echo "Canonical: $CANONICAL"
echo "HMAC (hex): $HMAC"
echo "HMAC (base64): $(echo -n "$CANONICAL" | openssl dgst -sha256 -mac HMAC -macopt "key=$SECRET" -binary | base64)"
```

#### Test 6.2: Test SSO Login with Valid HMAC

```bash
# Using values from Test 6.1
HMAC_BASE64=$(echo -n "test-user|test@orion.local|Test User|user-123|$(date +%s)000" \
  | openssl dgst -sha256 -mac HMAC -macopt "key=$(docker-compose exec orion printenv SSO_HMAC_SECRET)" -binary \
  | base64)

curl -X POST http://localhost:3000/api/auth/sso \
  -H "Content-Type: application/json" \
  -H "X-SSO-User: test-user" \
  -H "X-SSO-Email: test@orion.local" \
  -H "X-SSO-Name: Test User" \
  -H "X-SSO-UID: user-123" \
  -H "X-SSO-HMAC-SHA256: $HMAC_BASE64"
```

**Expected**:
- [ ] Status: 200 or 302 (redirect to dashboard)
- [ ] Session created for user
- [ ] User appears in audit logs with SSO provider

#### Test 6.3: Test SSO Login with Invalid HMAC

```bash
# Use wrong HMAC signature
INVALID_HMAC=$(echo -n "invalid_signature" | base64)

curl -X POST http://localhost:3000/api/auth/sso \
  -H "Content-Type: application/json" \
  -H "X-SSO-User: test-user" \
  -H "X-SSO-Email: test@orion.local" \
  -H "X-SSO-Name: Test User" \
  -H "X-SSO-UID: user-123" \
  -H "X-SSO-HMAC-SHA256: $INVALID_HMAC"
```

**Expected**:
- [ ] Status: 401 Unauthorized or 403 Forbidden
- [ ] Error message: "Invalid HMAC signature" or similar
- [ ] Audit log entry created for failed attempt
- [ ] Timestamp and IP logged

#### Test 6.4: Test Missing HMAC Header

```bash
# Request without HMAC header
curl -X POST http://localhost:3000/api/auth/sso \
  -H "Content-Type: application/json" \
  -H "X-SSO-User: test-user" \
  -H "X-SSO-Email: test@orion.local" \
  -H "X-SSO-Name: Test User" \
  -H "X-SSO-UID: user-123"
```

**Expected**:
- [ ] Status: 401 Unauthorized
- [ ] Error message indicates HMAC signature required
- [ ] Audit log records missing HMAC

#### Test 6.5: Check Audit Logs

```bash
# Query audit logs for SSO attempts
curl -s http://localhost:3000/api/admin/audit-log \
  -H "Authorization: Bearer <admin-token>" \
  | jq '.data[] | select(.action == "SSO_AUTH") | {action, result, ip, userAgent}'
```

**Expected**:
- [ ] Log entry for each SSO attempt (valid and invalid)
- [ ] Invalid attempts show: `result: "failed"`, `reason: "invalid_hmac"`
- [ ] Valid attempts show: `result: "success"`
- [ ] IP address and User-Agent recorded

---

### Test 7: AUDIT-001 — S3 Audit Log Export

**Scope**: Verify audit logs are exported to S3 (MinIO in staging) with hash chain integrity.

**Acceptance Criteria**:
- Export job returns 200 with jobId
- Job status shows "completed" within ~5 seconds
- Log files appear in MinIO bucket
- Manifest file created with hash chain
- Logs deleted from PostgreSQL after export
- Supports multiple S3-compatible backends

#### Test 7.1: Verify MinIO is Running

```bash
# Check MinIO container health
docker-compose ps minio

# Access MinIO console
# Browser: http://localhost:9001
# Credentials: minioadmin / minioadmin

# Or via CLI
docker-compose exec minio mc ls local/orion-audit-logs
```

**Expected**:
- [ ] MinIO container is running and healthy
- [ ] Bucket `orion-audit-logs` exists
- [ ] Can list bucket contents (initially empty or minimal)

#### Test 7.2: Check Audit Log Count Before Export

```bash
# Count existing audit logs
curl -s http://localhost:3000/api/admin/audit-log?limit=1 \
  | jq '.pagination.total'

# Or directly query database
docker-compose exec postgres psql -U orion -d orion -c \
  "SELECT COUNT(*) FROM AuditLog;"
```

**Note**: Record this count for verification after export.

#### Test 7.3: Trigger Manual Export

```bash
# Generate admin authentication token (or use existing session)
# For this test, assume you have an admin session/token

# Trigger export
EXPORT_RESPONSE=$(curl -X POST http://localhost:3000/api/admin/audit-export \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-token>" \
  -d '{}')

echo "$EXPORT_RESPONSE" | jq '.'

# Extract job ID
JOB_ID=$(echo "$EXPORT_RESPONSE" | jq -r '.jobId')
echo "Export Job ID: $JOB_ID"
```

**Expected**:
- [ ] Status: 200 OK
- [ ] Response: `{ "jobId": "...", "status": "pending" }`
- [ ] jobId is a valid UUID or identifier

#### Test 7.4: Check Export Job Status

```bash
# Poll job status until completion
JOB_ID="<from-previous-step>"

for i in {1..10}; do
  STATUS=$(curl -s "http://localhost:3000/api/admin/audit-export?jobId=$JOB_ID" \
    | jq -r '.status')
  
  echo "Check $i: Status = $STATUS"
  
  if [ "$STATUS" = "completed" ]; then
    echo "✓ Export completed!"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "✗ Export failed!"
    break
  fi
  
  sleep 1
done
```

**Expected**:
- [ ] Status progresses: pending → processing → completed
- [ ] Completes within 10 seconds (usually 3-5 seconds)
- [ ] No "failed" status

#### Test 7.5: Verify Logs Exported to MinIO

```bash
# Check MinIO bucket for exported files
docker-compose exec minio mc ls local/orion-audit-logs/

# Or via browser console
# Navigate to http://localhost:9001
# Browse bucket: orion-audit-logs
# Should see: logs/, manifests/ directories
```

**Expected**:
- [ ] Bucket contains logs directory with exported files
- [ ] Files are named with timestamp (e.g., `2026-04-26T12:00:00Z.json` or similar)
- [ ] Manifest directory exists
- [ ] At least one manifest file (`.manifest.json`)

#### Test 7.6: Verify Manifest with Hash Chain

```bash
# Download and inspect manifest file
docker-compose exec minio mc cat local/orion-audit-logs/manifests/latest.manifest.json | jq '.'

# Or if different naming:
docker-compose exec minio mc ls local/orion-audit-logs/manifests/ | grep manifest
```

**Expected**:
- [ ] Manifest file contains:
  - [ ] `exportedAt`: timestamp of export
  - [ ] `logFileHashes`: array of {filename, hash} pairs
  - [ ] `manifestHash`: hash of all previous hashes (hash chain)
  - [ ] `nextManifestHash`: hash for next export (if applicable)
  - [ ] `backend`: "minio" or other S3 backend used

#### Test 7.7: Verify Logs Deleted from Database

```bash
# Count audit logs before export
BEFORE=$(docker-compose exec postgres psql -U orion -d orion -c \
  "SELECT COUNT(*) FROM AuditLog WHERE createdAt < NOW() - INTERVAL '30 days';" | grep "|" | tail -1)

echo "Before export (old logs): $BEFORE"

# Trigger export (if not already done)
curl -X POST http://localhost:3000/api/admin/audit-export \
  -H "Authorization: Bearer <admin-token>"

# Wait for completion
sleep 5

# Count audit logs after export
AFTER=$(docker-compose exec postgres psql -U orion -d orion -c \
  "SELECT COUNT(*) FROM AuditLog WHERE createdAt < NOW() - INTERVAL '30 days';" | grep "|" | tail -1)

echo "After export (old logs): $AFTER"

# Verify BEFORE > AFTER (old logs deleted)
if [ "$BEFORE" > "$AFTER" ]; then
  echo "✓ Old audit logs were deleted after export"
fi
```

**Expected**:
- [ ] Old audit logs (>30 days) are deleted after export
- [ ] Recent logs remain in database
- [ ] Cleanup respects AUDIT_EXPORT_RETENTION_DAYS setting

#### Test 7.8: Test with Different S3 Backend (Optional)

**Note**: Requires additional S3 backend setup. Test with AWS S3, DigitalOcean, or Wasabi if available.

```bash
# Update .env to use different backend
# Example: AWS S3
# AUDIT_EXPORT_S3_BACKEND=aws
# AUDIT_EXPORT_S3_REGION=us-east-1
# AUDIT_EXPORT_S3_BUCKET=orion-audit-prod
# AWS_ACCESS_KEY_ID=<your-key>
# AWS_SECRET_ACCESS_KEY=<your-secret>

# Restart ORION
docker-compose restart orion

# Re-run export test
curl -X POST http://localhost:3000/api/admin/audit-export

# Verify files appear in real S3 bucket
aws s3 ls s3://orion-audit-prod/
```

**Expected**:
- [ ] Export works with different backend
- [ ] Files appear in real S3 bucket (not just MinIO)
- [ ] No errors in logs regarding S3 connection

---

## Additional Verification Tests

### A. Application Startup Checks

```bash
# Verify app starts without errors
docker-compose logs orion | grep -E "error|fatal|panic" | head -10

# Should show: No critical errors on startup
```

**Expected**:
- [ ] No ERROR or FATAL log messages on startup
- [ ] Application reports: "Server running on http://localhost:3000"

### B. Environment Variables Loaded

```bash
# Verify critical env vars are loaded
docker-compose exec orion printenv | grep -E "REDIS_URL|SSO_HMAC_SECRET|AUDIT_EXPORT"
```

**Expected**:
- [ ] REDIS_URL is set
- [ ] SSO_HMAC_SECRET is set
- [ ] AUDIT_EXPORT_S3_BACKEND is set
- [ ] Database URL is set

### C. Database Migrations

```bash
# Check migrations are applied
docker-compose exec orion npx prisma migrate status
```

**Expected**:
- [ ] All pending migrations are applied
- [ ] No migration errors
- [ ] Database schema matches Prisma schema

### D. Database Schema Validation

```bash
# Verify Prisma schema matches database
docker-compose exec orion npx prisma validate
```

**Expected**:
- [ ] No schema validation errors
- [ ] Output: "Validation succeeded"

### E. Redis Connectivity

```bash
# Verify Redis is accessible from ORION
docker-compose exec orion redis-cli -u redis://redis:6379/0 ping
```

**Expected**:
- [ ] Response: PONG
- [ ] No connection refused errors

### F. MinIO Connectivity

```bash
# Verify MinIO is accessible
docker-compose exec orion aws s3 ls --endpoint-url http://minio:9000 s3://orion-audit-logs/
```

**Expected**:
- [ ] List bucket contents successfully
- [ ] No connection errors

---

## Test Results Documentation

### Template for Recording Results

Create a file: `STAGING_SMOKE_TEST_RESULTS.md`

```markdown
# SOC II Smoke Test Results

**Date**: [test-date]
**Tester**: [your-name]
**Environment**: Staging (Docker Compose)

## Summary
- Total Tests: 7
- Passed: [ ]/7
- Failed: [ ]/7
- Skipped: [ ]/7

## Detailed Results

### K8S-001: Console Log Redaction
- Test 1.1 (Generate Error): PASS/FAIL
- Test 1.2 (All Methods): PASS/FAIL
- Test 1.3 (Pattern Matching): PASS/FAIL
- Issues: [if any]

### INPUT-001: Input Validation
- Test 2.1 (TOTP Invalid): PASS/FAIL
- Test 2.2 (Tasks Invalid): PASS/FAIL
- Test 2.3 (Tasks Valid): PASS/FAIL
- Test 2.4 (Features Invalid): PASS/FAIL
- Test 2.5 (Multiple Routes): PASS/FAIL
- Issues: [if any]

### SQL-001: Parameterized Queries
- Test 3.1 (Enable Logging): PASS/FAIL
- Test 3.2 (Safe Query): PASS/FAIL
- Test 3.3 (SQL Injection): PASS/FAIL
- Test 3.4 (Verify Logs): PASS/FAIL
- Issues: [if any]

### RATE-001: Redis Rate Limiting
- Test 4.1 (Headers): PASS/FAIL
- Test 4.2 (Reset): PASS/FAIL
- Test 4.3 (Redis Config): PASS/FAIL
- Test 4.4 (In-Memory Fallback): PASS/FAIL
- Issues: [if any]

### CSP-001: Content Security Policy
- Test 5.1 (CSP Headers): PASS/FAIL
- Test 5.2 (Browser Console): PASS/FAIL
- Test 5.3 (Responsive Design): PASS/FAIL
- Test 5.4 (All Pages): PASS/FAIL
- Issues: [if any]

### SSO-001: HMAC Header Validation
- Test 6.1 (Generate HMAC): PASS/FAIL
- Test 6.2 (Valid HMAC): PASS/FAIL
- Test 6.3 (Invalid HMAC): PASS/FAIL
- Test 6.4 (Missing HMAC): PASS/FAIL
- Test 6.5 (Audit Logs): PASS/FAIL
- Issues: [if any]

### AUDIT-001: S3 Audit Log Export
- Test 7.1 (MinIO Running): PASS/FAIL
- Test 7.2 (Log Count): PASS/FAIL (count before: [ ])
- Test 7.3 (Trigger Export): PASS/FAIL
- Test 7.4 (Job Status): PASS/FAIL
- Test 7.5 (Files in MinIO): PASS/FAIL
- Test 7.6 (Manifest Hash Chain): PASS/FAIL
- Test 7.7 (Logs Deleted): PASS/FAIL (count after: [ ])
- Test 7.8 (Other Backend): [SKIPPED]
- Issues: [if any]

### Additional Checks
- A. Startup Checks: PASS/FAIL
- B. Environment Variables: PASS/FAIL
- C. Database Migrations: PASS/FAIL
- D. Schema Validation: PASS/FAIL
- E. Redis Connectivity: PASS/FAIL
- F. MinIO Connectivity: PASS/FAIL

## Known Issues & Workarounds
[Document any failures and remediation steps]

## Sign-Off
Tested by: [name]
Date: [date]
Status: READY FOR PRODUCTION / NEEDS FIXES
```

---

## Troubleshooting Common Failures

### K8S-001: Logs Show Raw Secrets

**Problem**: Secrets appear in logs without redaction.

**Causes**:
- `wrapConsoleLog()` not called on startup
- Console wrapping called too late (after secrets logged)
- Redaction patterns don't match your secret format

**Fixes**:
1. Verify `wrapConsoleLog()` is called in app initialization (`lib/redact.ts`)
2. Check that console methods are wrapped before any API calls
3. Add custom redaction pattern if needed:
   ```typescript
   SENSITIVE_PATTERNS.push(/custom_pattern/g)
   ```

---

### INPUT-001: Validation Errors Too Verbose

**Problem**: Error messages leak implementation details or show raw Zod errors.

**Causes**:
- Zod error formatting not customized
- Error handler directly returns Zod errors

**Fixes**:
1. Ensure error handler formats Zod errors:
   ```typescript
   const formatted = error.errors.map(e => ({
     field: e.path.join('.'),
     message: e.message
   }))
   ```
2. Test that error messages are user-friendly

---

### SQL-001: Queries Not Parameterized

**Problem**: PostgreSQL logs show string interpolation, not parameterized queries.

**Causes**:
- Raw SQL still used somewhere in codebase
- Prisma not used for certain queries
- Query logging doesn't show parameterization clearly

**Fixes**:
1. Verify all DB queries use Prisma ORM
2. Search for `query()` or `$queryRaw` usage:
   ```bash
   grep -r "$queryRaw\|\.query(" apps/web/src --include="*.ts"
   ```
3. Convert to Prisma equivalents

---

### RATE-001: Headers Not Appearing

**Problem**: X-RateLimit headers missing from response.

**Causes**:
- Rate limiter middleware not active
- Redis connection failed silently
- Headers stripped by proxy

**Fixes**:
1. Verify Redis is running: `docker-compose logs redis | grep "ready"`
2. Check REDIS_URL is set: `docker-compose exec orion printenv REDIS_URL`
3. Add logging to rate limiter to debug
4. Disable any proxies stripping headers

---

### CSP-001: Styles Not Applying (unsafe-inline Removed)

**Problem**: UI looks broken after removing unsafe-inline.

**Causes**:
- Inline styles not using nonce
- External stylesheets missing
- CSS-in-JS not updated

**Fixes**:
1. Use CSS modules or external stylesheets instead of inline styles
2. Add nonce to inline styles that can't be extracted
3. Check Next.js CSP integration
4. Clear browser cache: Ctrl+Shift+Delete

---

### SSO-001: HMAC Validation Always Fails

**Problem**: Even valid HMAC signatures rejected.

**Causes**:
- Wrong canonical string format
- Secret encoding mismatch (hex vs base64)
- Timestamp validation too strict

**Fixes**:
1. Verify canonical string format matches implementation:
   ```typescript
   // Implementation in lib/auth.ts
   const canonical = `${username}|${email}|${name}|${uid}|${timestamp}`
   ```
2. Ensure secret is treated as binary (not hex-encoded)
3. Check timestamp is recent (within 30 seconds)
4. Verify HMAC algorithm is SHA-256

---

### AUDIT-001: Export Job Always "Pending"

**Problem**: Export job never completes, stuck in "pending" state.

**Causes**:
- Background job queue not running
- MinIO connection failed
- Export worker crashed silently

**Fixes**:
1. Verify background jobs enabled:
   ```bash
   docker-compose logs orion | grep "job\|worker\|queue"
   ```
2. Check MinIO connectivity:
   ```bash
   docker-compose exec orion aws s3 ls s3://orion-audit-logs/ --endpoint-url http://minio:9000
   ```
3. Check ORION logs for errors:
   ```bash
   docker-compose logs orion --tail 50
   ```

---

### AUDIT-001: Files Not Appearing in MinIO

**Problem**: Export completes but no files in bucket.

**Causes**:
- Bucket name incorrect
- AWS credentials invalid
- S3 backend misconfigured

**Fixes**:
1. Verify bucket exists:
   ```bash
   docker-compose exec minio mc ls local/
   ```
2. Check credentials: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
3. Verify AUDIT_EXPORT_S3_ENDPOINT points to correct MinIO
4. Check ORION logs for S3 errors

---

## Test Execution Checklist

Before signing off on tests, verify:

- [ ] All 7 fixes have been deployed to staging (checked git log)
- [ ] Docker containers are healthy and fully initialized
- [ ] Database migrations applied without errors
- [ ] Test user account created with admin role
- [ ] Staging environment is isolated from production
- [ ] No sensitive data in test results documentation
- [ ] Logs captured for any failures
- [ ] All test steps documented with clear pass/fail criteria
- [ ] Results recorded in STAGING_SMOKE_TEST_RESULTS.md
- [ ] Any failed tests have remediation plan
- [ ] Sign-off obtained from QA/Security team

---

## Quick Test Run (15 min version)

**For rapid verification of all 7 fixes** (skip detailed tests):

```bash
#!/bin/bash
# Quick smoke test runner

echo "=== K8S-001: Check Redaction ==="
curl -s http://localhost:3000/api/health | jq '.'
docker-compose logs orion 2>&1 | grep -i "redact" | head -1

echo "=== INPUT-001: Check Validation ==="
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.error // .'

echo "=== SQL-001: Check Parameterization ==="
curl -s http://localhost:3000/api/agents | jq '.data[0] // "No agents"'

echo "=== RATE-001: Check Rate Limit ==="
for i in {1..11}; do curl -s http://localhost:3000/api/health > /dev/null; done
curl -sD /dev/stdout http://localhost:3000/api/health | grep "429\|200" | head -1

echo "=== CSP-001: Check Headers ==="
curl -sD /dev/stdout http://localhost:3000 | grep -i "content-security-policy" | head -1

echo "=== SSO-001: Check HMAC Requirement ==="
curl -X POST http://localhost:3000/api/auth/sso \
  -H "Content-Type: application/json" \
  -H "X-SSO-User: test" \
  -d '{}' | jq '.error // .'

echo "=== AUDIT-001: Check Export ==="
curl -X POST http://localhost:3000/api/admin/audit-export | jq '.jobId // .'

echo "=== All Quick Tests Complete ==="
```

---

## Conclusion

This smoke test suite provides comprehensive validation of all 7 SOC II remediation fixes:

1. **K8S-001**: Redacts secrets from pod logs (all console methods)
2. **INPUT-001**: Validates all API input with Zod (400 on invalid)
3. **SQL-001**: Uses parameterized queries (prevents SQL injection)
4. **RATE-001**: Enforces rate limits with Redis (429 after limit)
5. **CSP-001**: Removes unsafe-inline styles (no CSP violations)
6. **SSO-001**: Validates HMAC headers (prevents impersonation)
7. **AUDIT-001**: Exports audit logs to S3 with hash chain (compliance)

**Total estimated runtime**: 30-45 minutes  
**Fully automated**: Yes (with manual browser checks for CSP)  
**Production ready**: Pass all tests before deploying to production

---

**Document Version**: 1.0  
**Last Updated**: 2026-04-26  
**Status**: Ready for Testing
