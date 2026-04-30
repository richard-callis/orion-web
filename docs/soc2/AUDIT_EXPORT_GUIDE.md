# AUDIT-001: S3 Log Export Implementation Guide

## Overview

This guide documents the S3 audit log export feature for SOC2 [L-001] compliance. Audit logs older than the retention period (default 30 days) are automatically exported to S3 with tamper-evidence (hash chain) before deletion from the database.

**Status**: Implementation complete, pending S3 bucket setup by ops

## Architecture

### Components

1. **`lib/audit-export.ts`** — Core export logic
   - `exportAuditLogs()` — Main orchestration function
   - `exportLogsToFile()` — Query and gzip logs
   - `generateManifest()` — Create manifest with hash chain
   - `uploadToS3()` — S3 upload with retry logic
   - `deleteExportedLogs()` — Clean up database

2. **`jobs/audit-export-daily.ts`** — Daily scheduled job
   - `runAuditExportJob()` — Job execution with logging
   - `getNextExportSchedule()` — Calculate 2 AM UTC
   - `isTimeForExport()` — Check if it's export time
   - `ensureAuditExportJobScheduled()` — Initialize job

3. **`app/api/admin/audit-export/route.ts`** — Manual export endpoint
   - `POST /api/admin/audit-export` — Trigger export
   - `GET /api/admin/audit-export?jobId=<id>` — Check job status

4. **Updated: `app/api/admin/audit-retention/cleanup/route.ts`**
   - Verifies S3 export succeeded before allowing deletion
   - Auto-triggers export if none recent (< 24 hours)
   - Logs all cleanup actions to audit trail

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Scheduled Job (2 AM UTC daily) OR Manual Trigger            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
         ┌──────────────────────────┐
         │ exportAuditLogs()        │
         │ - Load config            │
         │ - Query DB for old logs  │
         │ - Create gzip JSON file  │
         │ - Generate manifest      │
         │ - Upload to S3           │
         │ - Delete from DB         │
         │ - Store manifest hash    │
         └──────────────────────────┘
                     │
         ┌───────────┴───────────┐
         v                       v
    Logs File              Manifest File
    (gzipped JSON)         (JSON + hash chain)
         │                       │
         └───────────┬───────────┘
                     v
         ┌──────────────────────────┐
         │ S3 Bucket with Object    │
         │ Lock (COMPLIANCE mode)   │
         │ Immutable for 7 years    │
         └──────────────────────────┘
```

## Configuration

### Environment Variables

Required:
```bash
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs-prod
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_RETENTION_DAYS=30
AUDIT_EXPORT_MANIFEST_PATH=manifests/
```

### S3 Bucket Setup (Ops)

The S3 bucket must be pre-configured with:

1. **Object Lock**: COMPLIANCE mode
   - Immutable for 7 years (max retention)
   - Cannot be disabled or shortened
   - Ensures tamper-evidence

2. **Versioning**: Enabled
   - Prevents accidental overwrites
   - Preserves entire history

3. **Encryption**: AES-256 (default)
   - Server-side encryption at rest
   - No customer-managed keys needed

4. **Bucket Policy**: Allow ORION app to write
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "AWS": "arn:aws:iam::ACCOUNT_ID:role/orion-app"
         },
         "Action": [
           "s3:PutObject",
           "s3:PutObjectAcl",
           "s3:GetObject"
         ],
         "Resource": "arn:aws:s3:::orion-audit-logs-prod/*"
       }
     ]
   }
   ```

5. **Lifecycle Policy**: Delete after 7 years
   - Automates cleanup after Object Lock expiry
   - Reduces storage costs long-term

### AWS Credentials

ORION reads AWS credentials from standard sources (in order):
1. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` environment variables
2. `~/.aws/credentials` file (IAM role)
3. EC2 instance IAM role (production)

Recommended: Use EC2 instance IAM role in production for key rotation.

## Usage

### Automatic Daily Export (2 AM UTC)

The export runs automatically every day at 2 AM UTC. No configuration needed.

To verify:
1. Check `BackgroundJob` table for jobs with type `audit-export-daily`
2. Verify status is `completed` and logs show success
3. Confirm manifest in S3 with hash chain

### Manual Export (On-Demand)

Trigger an immediate export:

```bash
curl -X POST http://localhost:3000/api/admin/audit-export \
  -H "Authorization: Bearer <session>" \
  -H "Content-Type: application/json"
```

Response:
```json
{
  "ok": true,
  "jobId": "a1b2c3d4e5f6g7h8",
  "message": "Export job started",
  "checkStatusUrl": "/api/admin/audit-export?jobId=a1b2c3d4e5f6g7h8"
}
```

Check status:
```bash
curl http://localhost:3000/api/admin/audit-export?jobId=a1b2c3d4e5f6g7h8
```

Response:
```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "type": "audit-export",
  "title": "Manual Audit Log Export to S3",
  "status": "completed",
  "logs": [
    "Starting audit log export...",
    "Configuration: bucket=orion-audit-logs-prod, region=us-east-1, retention=30d",
    "Successfully exported 1523 logs to s3://orion-audit-logs-prod/2026-04-26/...",
    "Manifest: s3://orion-audit-logs-prod/manifests/manifest-2026-04-26.json"
  ],
  "metadata": {
    "triggeredBy": "user-id",
    "triggeredAt": "2026-04-26T12:00:00Z"
  },
  "createdAt": "2026-04-26T12:00:00Z",
  "updatedAt": "2026-04-26T12:00:15Z",
  "completedAt": "2026-04-26T12:00:15Z"
}
```

### Manual Cleanup (With Export Verification)

Trigger cleanup (triggers export first if needed):

```bash
curl -X POST http://localhost:3000/api/admin/audit-retention/cleanup \
  -H "Authorization: Bearer <session>" \
  -H "Content-Type: application/json"
```

Response (if export ran first):
```json
{
  "ok": true,
  "deleted": 1523,
  "retentionDays": 30,
  "cutoff": "2026-02-25T00:00:00Z",
  "exportedBefore": false
}
```

Check cleanup stats before deletion:

```bash
curl http://localhost:3000/api/admin/audit-retention/cleanup
```

Response:
```json
{
  "retentionDays": 30,
  "cutoff": "2026-02-25T00:00:00Z",
  "totalAuditLogs": 50000,
  "expiredCount": 1523,
  "lastExportTime": "2026-04-26T02:00:00Z",
  "canCleanupWithoutExport": true
}
```

## Manifest Format

Each export includes a JSON manifest with metadata and hash chain:

```json
{
  "exportDate": "2026-04-26T02:00:00Z",
  "recordCount": 1523,
  "dateRange": {
    "start": "2026-02-25",
    "end": "2026-04-25"
  },
  "s3Path": "s3://orion-audit-logs-prod/2026-04-26/logs.json.gz",
  "hashChain": {
    "logs": "sha256_of_exported_logs_file",
    "manifest": "sha256_of_this_manifest",
    "previousManifest": "sha256_of_previous_manifest"
  },
  "checksums": {
    "recordCount": 1523,
    "fileSize": 2048576,
    "algorithm": "sha256"
  },
  "compression": "gzip",
  "version": "1.0"
}
```

### Hash Chain Verification

To verify manifest integrity:

1. Download manifest from S3
2. Extract `manifest` hash
3. Remove `manifest` and `previousManifest` fields from JSON
4. Compute SHA-256 of remaining JSON
5. Compare to extracted hash — if equal, manifest is unmodified

To verify log file integrity:

1. Download gzipped log file from S3
2. Gunzip to JSON
3. Compute SHA-256 of JSON
4. Compare to `hashChain.logs` — if equal, logs are unmodified

Link to previous manifest via `hashChain.previousManifest` for full chain.

## Error Handling

### Common Issues

**S3 bucket not configured**
- Error: `AUDIT_EXPORT_S3_BUCKET not set`
- Fix: Add environment variable to deployment

**S3 upload fails**
- Error: `Failed to upload logs to S3 after 3 attempts`
- Cause: Network, credentials, or permissions
- Fix: Check AWS credentials, bucket policy, region

**No logs to export**
- Error: `No audit logs older than retention period to export`
- Cause: All logs are newer than retention period
- Status: Not an error — returns success with 0 records

**Manual cleanup without recent export**
- Error: `S3 export not configured`
- Flow: Auto-triggers export → waits for completion → then deletes
- Result: Both export and cleanup happen atomically

## Testing

### Unit Tests (to add)

```typescript
// Test exportLogsToFile with mock data
// Test generateManifest hash chain
// Test uploadToS3 with mock S3Client
// Test deleteExportedLogs with real DB
```

### Integration Tests (to add)

```typescript
// Test full exportAuditLogs() workflow
// Test S3 bucket with real credentials (staging)
// Test manifest integrity via hash verification
// Test daily scheduled job execution
```

### Manual Testing

1. Create test environment with S3 bucket:
   ```bash
   aws s3 mb s3://orion-audit-logs-test --region us-east-1
   aws s3api put-object-lock-configuration \
     --bucket orion-audit-logs-test \
     --object-lock-configuration 'ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=COMPLIANCE,Days=2555}}'
   ```

2. Configure ORION:
   ```bash
   export AUDIT_EXPORT_S3_BUCKET=orion-audit-logs-test
   export AUDIT_EXPORT_S3_REGION=us-east-1
   export AUDIT_EXPORT_RETENTION_DAYS=0  # Export all logs
   ```

3. Create sample audit logs:
   ```bash
   # Normal operations will create logs, or manually insert:
   INSERT INTO "AuditLog" (id, "userId", action, target, "createdAt", detail)
   VALUES (gen_random_uuid(), 'test-user', 'test_action', 'test_target', NOW(), '{}');
   ```

4. Trigger export:
   ```bash
   curl -X POST http://localhost:3000/api/admin/audit-export
   ```

5. Verify in S3:
   ```bash
   aws s3 ls s3://orion-audit-logs-test/ --recursive
   aws s3 cp s3://orion-audit-logs-test/manifests/manifest-*.json - | jq
   ```

## Monitoring & Alerts

### Metrics to Monitor

1. **Export Success Rate**
   - Track `BackgroundJob` with type `audit-export-daily`
   - Alert if more than 2 consecutive failures

2. **Export Duration**
   - Expected: < 1 minute for typical deployments
   - Alert if > 5 minutes (possible network issue)

3. **Exported Record Count**
   - Monitor trend over time
   - Alert if 0 records for > 7 days (possible configuration issue)

4. **S3 Upload Success**
   - Verify manifest exists for each export date
   - Alert if manifest missing or corrupted

### Log Locations

- Job logs: `BackgroundJob.logs` (in database)
- System logs: stdout/stderr from worker process
- Audit trail: `AuditLog` with action `admin_action`, target `audit_log_export`

## Troubleshooting

### Export job queued but not running

Check:
1. Worker process is running: `ps aux | grep worker`
2. Database connection works: Check `BackgroundJob` table
3. Background job status: `SELECT status FROM "BackgroundJob" ORDER BY "createdAt" DESC LIMIT 1`

### S3 upload hangs

Check:
1. AWS credentials valid: `aws s3 ls`
2. Network connectivity: `curl https://s3.amazonaws.com`
3. Bucket policy allows PutObject: `aws s3api get-bucket-policy --bucket <name>`

### Hash chain verification fails

Check:
1. Manifest was not modified after upload
2. S3 bucket has Object Lock enabled
3. Manifest JSON formatting (spaces matter for hash)

## Compliance Notes

### SOC2 [L-001] — Log Retention

✅ Retention Policy: 30 days (configurable, min 90 days)
✅ Archival: Exported to S3 before deletion
✅ Tamper-Evidence: Hash chain for integrity
✅ Immutability: Object Lock COMPLIANCE mode (7 years)
✅ Audit Trail: Export logged to AuditLog
✅ Monitoring: Job execution tracked in BackgroundJob

### Next Steps

1. **Ops**: Create S3 bucket with Object Lock
2. **Dev**: Run integration tests against staging bucket
3. **Security**: Review hash chain implementation
4. **Deployment**: Add environment variables to production
5. **Monitoring**: Set up alerts for export failures
6. **Verification**: Run first export and verify manifest integrity

## References

- Implementation: `apps/web/src/lib/audit-export.ts`
- Daily job: `apps/web/src/jobs/audit-export-daily.ts`
- API endpoint: `apps/web/src/app/api/admin/audit-export/route.ts`
- Cleanup route: `apps/web/src/app/api/admin/audit-retention/cleanup/route.ts`
- Config: `deploy/.env.example`
- Audit logging: `apps/web/src/lib/audit.ts`
- Job runner: `apps/web/src/lib/job-runner.ts`

---

**Last Updated**: 2026-04-26  
**Status**: Implementation complete, pending S3 setup
