# AUDIT-001: Deployment Checklist

**Document**: Pre-deployment and Post-deployment Verification  
**Audience**: DevOps Engineers, Release Managers, QA  
**Status**: Ready for deployment  
**Date**: 2026-04-26

---

## Overview

This checklist ensures the S3 audit log export feature (AUDIT-001) is safely deployed and operational. Complete each section in order before, during, and after deployment.

---

## Phase 1: Pre-Deployment (Infrastructure Setup)

These steps must be completed **before** code is deployed to the environment.

**Note**: This guide is backend-agnostic. Choose your backend first using `AUDIT_EXPORT_SETUP_WIZARD.md`:
- **MinIO**: Self-hosted S3-compatible (homelab)
- **AWS S3**: Production cloud (recommended)
- **DigitalOcean Spaces**: Budget cloud
- **Wasabi**: Cold storage (cheapest)
- **Custom**: Any S3-compatible provider

See provider-specific guides for detailed setup:
- `AUDIT_EXPORT_SETUP_MINIO.md`
- `AUDIT_EXPORT_SETUP_AWS.md`
- `AUDIT_EXPORT_SETUP_DIGITALOCEAN.md`
- `AUDIT_EXPORT_SETUP_WASABI.md`
- `AUDIT_EXPORT_SETUP_CUSTOM.md`

### Backend Selection

- [ ] **S3 Backend Chosen**: Select one of the following
  - [ ] MinIO (self-hosted, free)
  - [ ] AWS S3 (cloud production, recommended)
  - [ ] DigitalOcean Spaces (budget cloud)
  - [ ] Wasabi (cold storage, cheapest)
  - [ ] Custom/Other S3-compatible
  - Selected backend: _______________

### Infrastructure Setup

Follow the provider-specific setup guide:

**MinIO (if selected)**:
- [ ] Docker container running (`orion-minio`)
- [ ] Ports 9000 (API) and 9001 (Console) mapped
- [ ] Storage volume persistent
- [ ] Health check: `curl http://minio:9000/minio/health/live`

**AWS S3 (if selected)**:
- [ ] S3 bucket created with Object Lock enabled
- [ ] IAM user created with S3 access policy
- [ ] Versioning enabled
- [ ] Lifecycle policy configured (7-year retention)

**DigitalOcean Spaces (if selected)**:
- [ ] Space created in chosen region
- [ ] Access keys generated
- [ ] Bucket accessible via S3 API

**Wasabi (if selected)**:
- [ ] Account created
- [ ] API credentials generated
- [ ] Bucket created

**Custom (if selected)**:
- [ ] Provider account created
- [ ] API credentials obtained
- [ ] Bucket created
- [ ] Endpoint URL noted: _______________

### S3 Bucket Configuration

- [ ] **Bucket Created**: With name matching environment
  - Bucket name: _______________
  - Backend: _______________
  - Region/endpoint: _______________
  - Confirmation: Provider console or `aws s3 ls`

- [ ] **Versioning Enabled** (Recommended): Preserves export history
  - Verification: `aws s3api get-bucket-versioning --bucket <name>`
  - Status: [ ] Enabled / [ ] Not available for this provider

- [ ] **Lifecycle Policy Set** (if available): Auto-delete after 7 years
  - Verification: `aws s3api get-bucket-lifecycle-configuration --bucket <name>`
  - Status: [ ] Configured / [ ] Not available / [ ] Manual management

### Credentials Configuration

- [ ] **S3 Credentials Available**: To ORION application
  - Access Key ID: _______________
  - Secret Access Key: Set and secure
  - Verification: Backend console login or `aws s3 ls`

- [ ] **Credentials Stored Securely**:
  - Stored in: [ ] Environment / [ ] Secrets manager / [ ] Vault
  - Rotation policy: _______________

### AWS SDK Verification

- [ ] **AWS SDK Installed**: `@aws-sdk/client-s3` dependency added
  - File: `apps/web/package.json`
  - Verification: `grep "@aws-sdk/client-s3" package.json`
  - Command: `npm install` or equivalent

---

## Phase 2: Code Deployment

These steps cover the actual code deployment process.

### Branch & Code Review

- [ ] **Pull Request Created**: From `fix/audit-log-retention` to `main`
  - PR Number: _______________
  - PR URL: _______________

- [ ] **Code Review Approved**: All reviewers signed off
  - Reviewer 1: _______________
  - Reviewer 2: _______________

- [ ] **Security Review Completed**: Hash chain and S3 integration approved
  - Reviewer: _______________
  - Findings: _______________

- [ ] **Tests Passing**: CI/CD pipeline green
  - CI Status: _______________
  - No blocking issues

### Merge to Main

- [ ] **Branch Merged**: Code merged to `main`
  - Merge commit: _______________
  - Merge time: _______________

- [ ] **Tag Created** (optional): `release/audit-001` or similar
  - Tag: _______________

### Deployment to Environment

- [ ] **Environment**: Select target
  - [ ] Staging
  - [ ] Production
  - Environment: _______________

- [ ] **Code Deployed**: Latest `main` deployed
  - Deployment timestamp: _______________
  - Deployment hash: _______________

- [ ] **Dependencies Installed**: AWS SDK available
  - Verification: Check application startup logs
  - Expected: No import errors for `@aws-sdk/client-s3`

---

## Phase 3: Environment Configuration

These steps configure the deployment for audit log export.

### Environment Variables Set

- [ ] **AUDIT_EXPORT_S3_BACKEND**: Backend selection
  - Value: `auto` (auto-detect) or explicit: `minio` / `aws` / `digitalocean` / `wasabi` / `custom`
  - Set in: _______________
  - Recommended: `auto` (simplest, auto-detects from endpoint)

- [ ] **AUDIT_EXPORT_S3_ENDPOINT**: S3 endpoint URL
  - MinIO: `http://minio:9000`
  - AWS: (leave empty — uses default)
  - DigitalOcean: `https://nyc3.digitaloceanspaces.com`
  - Wasabi: `https://s3.us-east-1.wasabisys.com`
  - Custom: Provider URL
  - Value: _______________
  - Set in: _______________

- [ ] **AUDIT_EXPORT_S3_BUCKET**: Bucket name
  - Value: _______________
  - Set in: _______________

- [ ] **AUDIT_EXPORT_S3_REGION**: S3 region or region-like identifier
  - AWS: `us-east-1`, `eu-west-1`, etc.
  - MinIO: Any value (e.g., `us-east-1`)
  - DigitalOcean: `nyc3`, `sfo2`, `sfo3`, etc.
  - Wasabi: `us-east-1`, `us-west-1`, `eu-west-1`, etc.
  - Value: _______________
  - Set in: _______________

- [ ] **AWS_ACCESS_KEY_ID**: Access key for chosen backend
  - For MinIO: Root user or custom user
  - For AWS: IAM user access key
  - For others: Provider-specific key
  - Value: _______________
  - Set in: _______________

- [ ] **AWS_SECRET_ACCESS_KEY**: Secret access key
  - Value: _______________
  - Set in: _______________
  - Security: [ ] Stored securely / [ ] In environment / [ ] In secrets manager

- [ ] **AUDIT_EXPORT_S3_FORCE_PATH_STYLE** (custom backends only):
  - Set if provider requires path-style addressing
  - Value: `true` or `false`
  - Set in: _______________
  - Only needed for: Custom/non-standard backends

- [ ] **AUDIT_EXPORT_RETENTION_DAYS**: Log retention period (days)
  - Typical: `30` (minimum 0, maximum 2555)
  - Value: _______________
  - Set in: _______________

- [ ] **AUDIT_EXPORT_MANIFEST_PATH**: S3 prefix for manifests
  - Value: `manifests/`
  - Set in: _______________

### S3 Credentials Verification

- [ ] **S3 Credentials Available**: To app process
  - Verification: `aws s3 ls s3://<bucket> --endpoint-url <endpoint>`
  - Or provider-specific CLI test
  - Result: [ ] Success / [ ] Failed (debug and retry)

- [ ] **Credentials Secure** (for production):
  - Not using default/weak credentials: [ ] Yes / [ ] No
  - Credentials rotated if inherited: [ ] Yes / [ ] N/A
  - Stored securely: [ ] Secrets manager / [ ] Vault / [ ] Env (dev only)

### Database Connection Verified

- [ ] **Database Accessible**: From application
  - Verification: Check application logs
  - Expected: No connection errors

- [ ] **AuditLog Table Present**: Required for export
  - Verification: `SELECT COUNT(*) FROM "AuditLog";`
  - Expected: Rows present (or 0 for new deployment)

- [ ] **SystemSetting Table Present**: For storing state
  - Verification: `SELECT * FROM "SystemSetting" WHERE key LIKE 'audit.%';`

- [ ] **BackgroundJob Table Present**: For tracking job execution
  - Verification: `SELECT * FROM "BackgroundJob" LIMIT 1;`

---

## Phase 4: Post-Deployment Verification (First 24 Hours)

Complete these checks after deployment to ensure the feature is working.

### Application Startup

- [ ] **Application Starts Without Errors**: No crashes or warnings
  - Verification: Check application logs
  - Expected: No `AUDIT_EXPORT_S3_BUCKET` errors
  - Command: `grep -i "audit.*export" logs/* | head -20`

- [ ] **Background Job System Active**: Job runner initialized
  - Verification: Check application logs
  - Expected: "Background job system started" or similar

- [ ] **Audit Export Job Scheduled**: Daily 2 AM UTC job exists
  - Verification: `SELECT * FROM "BackgroundJob" WHERE type = 'audit-export-daily';`
  - Expected: At least 1 row with status `queued` or `completed`

### Manual Export Test

- [ ] **Trigger Manual Export**: Via admin API
  - Command: `curl -X POST https://{app}/api/admin/audit-export -H "Authorization: Bearer {token}"`
  - Expected: `{ "ok": true, "jobId": "..." }`
  - Job ID: _______________

- [ ] **Export Job Completes**: Verify job finishes
  - Command: `curl https://{app}/api/admin/audit-export?jobId={jobId} -H "Authorization: Bearer {token}"`
  - Expected: `"status": "completed"`
  - Time to complete: _______________
  - Logs show success: _______________

- [ ] **Files Uploaded to S3**: Verify logs file and manifest
  - Command: `aws s3 ls s3://orion-audit-logs-{env}/ --recursive`
  - Expected: Files in `YYYY-MM-DD/` and `manifests/` directories
  - Sample output: _______________

### Manifest Verification

- [ ] **Manifest Created**: Daily manifest file exists
  - Command: `aws s3 cp s3://orion-audit-logs-{env}/manifests/manifest-*.json - | jq`
  - Expected: Valid JSON with `exportDate`, `recordCount`, `hashChain`

- [ ] **Manifest Hash Chain Valid**: Logs hash matches file
  - Verify using steps in `AUDIT_EXPORT_GUIDE.md` § Manifest Format
  - Command: Compute SHA-256 of logs file, compare to `hashChain.logs`
  - Match: [ ] Yes / [ ] No
  - If no match, investigate: _______________

- [ ] **Object Lock Applied**: Files are immutable
  - Command: `aws s3api head-object --bucket orion-audit-logs-{env} --key 2026-04-26/audit-logs-*.json.gz`
  - Expected: `ObjectLockMode: COMPLIANCE`, `ObjectLockRetainUntilDate` set
  - Verified: [ ] Yes / [ ] No

### Audit Trail Logging

- [ ] **Export Logged to AuditLog**: Action recorded
  - Command: `SELECT * FROM "AuditLog" WHERE action = 'admin_action' AND target = 'audit_log_export' ORDER BY "createdAt" DESC LIMIT 1;`
  - Expected: Recent entry for export
  - Record count: _______________

- [ ] **Job Logs Stored**: BackgroundJob has logs
  - Command: `SELECT logs FROM "BackgroundJob" WHERE id = '{jobId}';`
  - Expected: Array with log messages
  - Sample logs: _______________

### Cleanup Flow Test (if not already tested in Phase 1)

- [ ] **Cleanup Endpoint Accessible**: GET returns stats
  - Command: `curl https://{app}/api/admin/audit-retention/cleanup -H "Authorization: Bearer {token}"`
  - Expected: `{ "retentionDays": 30, "expiredCount": ..., "lastExportTime": ... }`

- [ ] **Manual Cleanup Verifies Export**: POST triggers cleanup only after export
  - Command: `curl -X POST https://{app}/api/admin/audit-retention/cleanup -H "Authorization: Bearer {token}"`
  - Expected: `{ "ok": true, "deleted": ..., "exportedBefore": true }`
  - Deleted count: _______________

- [ ] **Logs Deleted from Database**: After export and cleanup
  - Command: `SELECT COUNT(*) FROM "AuditLog" WHERE "createdAt" < NOW() - INTERVAL '30 days';`
  - Expected: Much lower than before cleanup
  - Remaining count: _______________

### Performance & Monitoring

- [ ] **Export Duration Acceptable**: < 5 minutes for typical load
  - Actual duration: _______________
  - Threshold: < 5 minutes [ ] Pass / [ ] Fail

- [ ] **CPU/Memory Usage Normal**: No spikes during export
  - Verification: Check monitoring dashboard
  - Expected: Normal levels

- [ ] **Database Queries Efficient**: No long locks
  - Verification: Check slow query log
  - Expected: No entries for export operations

- [ ] **S3 Connectivity Stable**: No upload retries (or < 1 per 100 exports)
  - Verification: Check job logs
  - Expected: "Successfully uploaded" without "attempt 2 of 3"

---

## Phase 5: Scheduled Job Verification (24 Hours Later)

Complete these checks after the first automatic scheduled export at 2 AM UTC.

### Daily Job Execution

- [ ] **Job Ran on Schedule**: At 2 AM UTC
  - Command: `SELECT * FROM "BackgroundJob" WHERE type = 'audit-export-daily' ORDER BY "createdAt" DESC LIMIT 1;`
  - Expected: Recent entry with status `completed`
  - Execution time: _______________

- [ ] **Job Status Completed**: No failures
  - Status: [ ] completed / [ ] failed / [ ] running
  - If failed, error message: _______________

- [ ] **Job Logs Show Success**: Export ran without errors
  - Command: `SELECT logs FROM "BackgroundJob" WHERE type = 'audit-export-daily' ORDER BY "createdAt" DESC LIMIT 1;`
  - Expected: "Successfully exported X logs to s3://..."
  - Sample output: _______________

### Manifest Integrity

- [ ] **Second Manifest Created**: For day 2 export
  - Command: `aws s3 ls s3://orion-audit-logs-{env}/manifests/`
  - Expected: manifest files for 2 dates
  - Files: _______________

- [ ] **Hash Chain Links Manifests**: `previousManifest` hash points to day 1
  - Download day 2 manifest, check `hashChain.previousManifest`
  - Should equal SHA-256 of day 1 manifest
  - Verified: [ ] Yes / [ ] No

### Storage & Costs

- [ ] **S3 Bucket Size Reasonable**: Expected based on log volume
  - Command: `aws s3api list-objects-v2 --bucket orion-audit-logs-{env} --query 'sum(Contents[].Size)' --output text`
  - Expected size: _______________
  - Actual size: _______________

- [ ] **Compression Ratio Good**: Gzipped files are ~10-20% of original
  - Estimated uncompressed size: _______________
  - Actual compressed size: _______________
  - Ratio: _______________% (should be < 20%)

---

## Phase 6: Security & Compliance Review

Complete these checks to confirm security and compliance posture.

### Object Lock Compliance

**Note**: Object Lock COMPLIANCE mode is only available on AWS S3. Other backends must rely on other immutability mechanisms (versioning, lifecycle policies, access controls).

**AWS S3 Only**:
- [ ] **Object Lock COMPLIANCE Enabled**: Verified
  - Command: `aws s3api get-object-lock-configuration --bucket <bucket>`
  - Expected: `ObjectLockMode: COMPLIANCE`, retention days set
  - Result: [ ] Verified / [ ] Not available on this backend

- [ ] **Object Lock Cannot Be Disabled**: Verified
  - Attempt to disable and confirm it fails
  - Expected error: "Object Lock cannot be disabled"
  - Attempt result: _______________

- [ ] **Retention Cannot Be Shortened**: Verified
  - Attempt to change retention to 1 day and confirm it fails
  - Expected error: "Retention period cannot be shortened"
  - Attempt result: _______________

- [ ] **Objects Cannot Be Deleted**: Verified
  - Attempt to delete a log file and confirm it fails
  - Expected error: "Object is protected by an object retention"
  - Attempt result: _______________

**Other Backends**:
- [ ] **Immutability Strategy Documented**: How retention is enforced
  - Strategy: [ ] Versioning / [ ] Lifecycle policies / [ ] Access controls / [ ] Other
  - Documentation: _______________
  - Verified: [ ] Yes / [ ] No

### Hash Chain Integrity

- [ ] **Hash Chain Verification Documented**: Procedure clear
  - Documentation location: `AUDIT_EXPORT_GUIDE.md` § Manifest Format
  - Verified: [ ] Yes / [ ] No

- [ ] **Hash Verification Test Passed**: Manual verification works
  - Follow procedure in documentation
  - Result: [ ] Pass / [ ] Fail
  - Notes: _______________

### Audit Trail Completeness

- [ ] **All Exports Logged**: Every export has audit trail entry
  - Command: `SELECT COUNT(*) FROM "AuditLog" WHERE target = 'audit_log_export';`
  - Count: _______________
  - Expected: >= number of exports performed

- [ ] **User Identity Captured**: For manual exports
  - Command: `SELECT "userId" FROM "AuditLog" WHERE target = 'audit_log_export' ORDER BY "createdAt" DESC LIMIT 1;`
  - Expected: User ID of who triggered manual exports
  - Verified: [ ] Yes / [ ] No

- [ ] **Cleanup Actions Logged**: Every cleanup has audit trail entry
  - Command: `SELECT COUNT(*) FROM "AuditLog" WHERE target = 'audit_log_cleanup';`
  - Count: _______________

### SOC2 Compliance

- [ ] **Retention Policy Met**: Logs exported before TTL deletion
  - Retention days configured: _______________
  - Exports happening daily: [ ] Yes / [ ] No
  - Verified: [ ] Compliant / [ ] Non-compliant

- [ ] **Tamper-Evidence Enabled**: Hash chain verified
  - Implementation: `apps/web/src/lib/audit-export.ts`
  - Hash chain present: [ ] Yes / [ ] No

- [ ] **Immutability Enforced**: Object Lock COMPLIANCE mode
  - Bucket setting verified: [ ] Yes / [ ] No
  - Cannot be disabled: [ ] Confirmed / [ ] Not tested

- [ ] **Monitoring in Place**: Export job tracked
  - BackgroundJob table: [ ] Populated / [ ] Empty
  - Audit trail: [ ] Populated / [ ] Empty

---

## Phase 7: Sign-Off & Documentation

Final steps before marking deployment complete.

### Documentation Complete

- [ ] **Environment Details Documented**:
  - Bucket name: _______________
  - Region: _______________
  - S3 path structure: s3://bucket/YYYY-MM-DD/logs.json.gz
  - Manifest path: s3://bucket/manifests/manifest-YYYY-MM-DD.json

- [ ] **Access Procedures Documented**: How to access exports
  - S3 bucket access: [ ] Documented / [ ] Not needed
  - Manifest verification: [ ] Documented / [ ] Not needed

- [ ] **Runbook Created** (if needed):
  - Location: _______________
  - Covers: Emergency procedures, rollback, troubleshooting

### Team Notification

- [ ] **Operations Team Notified**: Deployment complete
  - Notified: _______________
  - Date/Time: _______________

- [ ] **Security Team Notified**: SOC2 control live
  - Notified: _______________
  - Acknowledged: _______________

- [ ] **Development Team Notified**: Ready for usage
  - Notified: _______________
  - Acknowledged: _______________

### Deployment Sign-Off

- [ ] **Deployment Lead**: Approves deployment complete
  - Name: _______________
  - Date/Time: _______________
  - Signature: _______________

- [ ] **Operations Lead**: Confirms infrastructure stable
  - Name: _______________
  - Date/Time: _______________
  - Signature: _______________

---

## Rollback Triggers

If any of the following occur, prepare to rollback (see `AUDIT_EXPORT_ROLLBACK.md`):

- [ ] Export job fails 3+ times in 24 hours
- [ ] S3 upload errors prevent logs from being exported
- [ ] Manifest corruption or hash chain breaks
- [ ] Database performance degrades due to export queries
- [ ] IAM permission issues prevent uploads
- [ ] Critical bugs found in export code

**If rollback triggered, document**:
- Trigger reason: _______________
- Time detected: _______________
- Rollback initiated by: _______________
- Rollback completed by: _______________

---

## Post-Deployment Monitoring (Ongoing)

After deployment, monitor these items daily for the first week:

### Daily Checks

- [ ] Export job status: `SELECT status FROM "BackgroundJob" WHERE type = 'audit-export-daily' ORDER BY "createdAt" DESC LIMIT 1;`
- [ ] Manifest in S3: `aws s3 ls s3://orion-audit-logs-{env}/manifests/ | tail -1`
- [ ] Error logs: Check application logs for any export errors
- [ ] Database size: Verify audit logs are being cleaned up

### Weekly Checks

- [ ] 7-day success rate: Count completed vs failed jobs
- [ ] Average export duration: Ensure no performance degradation
- [ ] S3 costs: Verify bucket storage costs are acceptable
- [ ] Team feedback: Ask ops/security if any issues

---

## References

- **Setup Guide**: `AUDIT_EXPORT_S3_SETUP.md`
- **Implementation Guide**: `AUDIT_EXPORT_GUIDE.md`
- **Rollback Procedure**: `AUDIT_EXPORT_ROLLBACK.md`
- **Final Report**: `FINAL_REPORT.md`
- **Code**: `apps/web/src/lib/audit-export.ts` and related files

---

**Document Created**: 2026-04-26  
**Last Updated**: 2026-04-26  
**Status**: Ready for Deployment

