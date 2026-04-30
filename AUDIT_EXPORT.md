# AUDIT-001: S3 Audit Log Export

**Status**: Implementation complete, pending S3 bucket setup by ops  
**Branch**: `fix/audit-log-retention`  
**Commit**: `d44d781`  
**Date**: 2026-04-26

---

## Overview

The S3 audit log export feature implements SOC2 [L-001] compliance. Audit logs older than the retention period (default 30 days) are automatically exported to S3 with tamper-evidence (hash chain) before deletion from the database. Exports run automatically daily at 2 AM UTC or on-demand via admin API.

---

## Architecture

### Components

1. **`apps/web/src/lib/audit-export.ts`** — Core export library (437 lines)
   - `exportAuditLogs()` — Main orchestration function
   - `exportLogsToFile()` — Query and gzip logs
   - `generateManifest()` — Create manifest with hash chain
   - `uploadToS3()` — S3 upload with 3-attempt retry + exponential backoff (1s, 2s, 4s)
   - `deleteExportedLogs()` — Batch database cleanup (1000 records/batch)
   - `loadAuditExportConfig()` — Environment variable loading

2. **`apps/web/src/jobs/audit-export-daily.ts`** — Daily scheduled job (155 lines)
   - `runAuditExportJob()` — Job execution with audit trail logging
   - `getNextExportSchedule()` — Calculate 2 AM UTC
   - `isTimeForExport()` — Check 2:00–2:30 AM UTC window
   - `ensureAuditExportJobScheduled()` — Startup initialization

3. **`apps/web/src/app/api/admin/audit-export/route.ts`** — Manual export API (134 lines)
   - `POST /api/admin/audit-export` — Trigger on-demand export
   - `GET /api/admin/audit-export?jobId=<id>` — Check job status

4. **`apps/web/src/app/api/admin/audit-retention/cleanup/route.ts`** — Enhanced cleanup route (188 lines)
   - Verifies S3 export succeeded before allowing deletion
   - Auto-triggers export if none within last 24 hours
   - Logs all cleanup actions to audit trail

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ Scheduled Job (2 AM UTC daily) OR Manual Trigger (API)      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     v
         ┌──────────────────────────┐
         │ exportAuditLogs()        │
         │ 1. Load config           │
         │ 2. Query logs (createdAt)│
         │ 3. Export to JSON.gz     │
         │ 4. Generate manifest     │
         │ 5. Upload to S3 (retry)  │
         │ 6. Delete from DB        │
         │ 7. Store manifest hash   │
         │ 8. Log to audit trail    │
         └──────────┬───────────────┘
                    │
          ┌─────────┴──────────┐
          v                    v
    Logs File            Manifest File
    (JSON.gz)            (JSON + hash chain)
          │                    │
          └────────────┬───────┘
                       v
         ┌──────────────────────────────┐
         │    S3 Bucket                 │
         │  Object Lock: COMPLIANCE     │
         │  Versioning: Enabled         │
         │  Encryption: AES-256         │
         │  Retention: 7 years          │
         └──────────────────────────────┘
```

---

## Configuration

### Environment Variables

```bash
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs-prod    # Required: S3 bucket name
AUDIT_EXPORT_S3_REGION=us-east-1                # Required: AWS region
AUDIT_EXPORT_RETENTION_DAYS=30                  # Age cutoff in days
AUDIT_EXPORT_MANIFEST_PATH=manifests/           # S3 prefix for manifests
AWS_ACCESS_KEY_ID=<key>                         # AWS/provider credentials
AWS_SECRET_ACCESS_KEY=<secret>                  # AWS/provider credentials
AUDIT_EXPORT_S3_ENDPOINT=                       # Non-AWS providers only
AUDIT_EXPORT_S3_BACKEND=auto                    # auto|minio|aws|digitalocean|wasabi|custom
AUDIT_EXPORT_S3_FORCE_PATH_STYLE=false          # Custom backends only
```

---

## S3 Backend Selection

ORION supports 5 S3-compatible backends. Choose based on your deployment:

```
Does your organization have AWS?
├─ YES → AWS S3 (recommended for production)
├─ NO, prefer cloud
│  ├─ Small (<1TB/year) → DigitalOcean Spaces ($5/month flat)
│  └─ Archive/infrequent access → Wasabi (~$0.006/GB)
└─ NO, self-host → MinIO (free, containerized)
```

### Decision Matrix

| Factor | MinIO | AWS S3 | DO Spaces | Wasabi | Custom |
|--------|-------|--------|-----------|--------|--------|
| **Cost** | $0 | $0.023/GB | $5/mo flat | $0.006/GB | Varies |
| **Setup** | 10 min | 20 min | 10 min | 15 min | Varies |
| **Scalability** | Limited | Unlimited | Limited | Limited | Varies |
| **SLA** | Community | 99.99% | 99.95% | 99.5% | Varies |
| **Best For** | Homelab | Production | Small cloud | Archive | Specialized |

### MinIO (Self-Hosted)

```yaml
# docker-compose.yml
services:
  minio:
    image: minio/minio:latest
    container_name: orion-minio
    ports:
      - "9000:9000"  # S3 API
      - "9001:9001"  # Web Console
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: change-me-securely
    volumes:
      - minio_data:/data
    command: minio server /data
volumes:
  minio_data:
```

```bash
# Create bucket
aws s3 mb s3://orion-audit-logs \
  --endpoint-url http://localhost:9000 --region us-east-1

# ORION .env
AUDIT_EXPORT_S3_BACKEND=minio
AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=change-me-securely
```

### AWS S3 (Production)

```bash
# Create bucket with Object Lock
BUCKET_NAME="orion-audit-logs-prod"
aws s3api create-bucket --bucket ${BUCKET_NAME} --region us-east-1 \
  --object-lock-enabled-for-bucket

# Enable COMPLIANCE mode (7-year retention)
aws s3api put-object-lock-configuration \
  --bucket ${BUCKET_NAME} \
  --object-lock-configuration \
    'ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=COMPLIANCE,Days=2555}}'

# Create IAM user
aws iam create-user --user-name orion-s3-user
aws iam create-access-key --user-name orion-s3-user
```

IAM policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::orion-audit-logs-prod"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::orion-audit-logs-prod/*"
    }
  ]
}
```

```bash
# ORION .env
AUDIT_EXPORT_S3_BACKEND=aws
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs-prod
AWS_ACCESS_KEY_ID=<from-iam-user>
AWS_SECRET_ACCESS_KEY=<from-iam-user>
```

### DigitalOcean Spaces

```bash
# ORION .env
AUDIT_EXPORT_S3_BACKEND=digitalocean
AUDIT_EXPORT_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
AUDIT_EXPORT_S3_REGION=nyc3
AUDIT_EXPORT_S3_BUCKET=orion-audit
AWS_ACCESS_KEY_ID=<spaces-key>
AWS_SECRET_ACCESS_KEY=<spaces-secret>
```

Cost: $5/month flat for 250GB, $0.02/GB overage.

### Wasabi

```bash
# ORION .env
AUDIT_EXPORT_S3_BACKEND=wasabi
AUDIT_EXPORT_S3_ENDPOINT=https://s3.us-east-1.wasabisys.com
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-backup
AWS_ACCESS_KEY_ID=<wasabi-key>
AWS_SECRET_ACCESS_KEY=<wasabi-secret>
```

Cost: ~$0.006/GB. Best for archive/cold storage.

### Custom S3-Compatible

```bash
AUDIT_EXPORT_S3_BACKEND=custom
AUDIT_EXPORT_S3_ENDPOINT=https://s3.example.com
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=my-logs
AUDIT_EXPORT_S3_FORCE_PATH_STYLE=false  # Check with provider
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
```

---

## Usage

### Automatic Daily Export (2 AM UTC)

Runs automatically every day. No action needed.

To verify:
```sql
SELECT * FROM "BackgroundJob"
WHERE type = 'audit-export-daily'
ORDER BY "createdAt" DESC LIMIT 1;
```

### Manual Export (On-Demand)

```bash
# Trigger
curl -X POST https://{app}/api/admin/audit-export \
  -H "Authorization: Bearer {token}"
# Response: { "ok": true, "jobId": "...", "checkStatusUrl": "..." }

# Check status
curl "https://{app}/api/admin/audit-export?jobId={jobId}" \
  -H "Authorization: Bearer {token}"
```

### Cleanup with Export Verification

```bash
# Get stats before cleanup
curl https://{app}/api/admin/audit-retention/cleanup \
  -H "Authorization: Bearer {token}"
# Response: { "retentionDays": 30, "expiredCount": ..., "lastExportTime": ... }

# Trigger cleanup (auto-exports if needed first)
curl -X POST https://{app}/api/admin/audit-retention/cleanup \
  -H "Authorization: Bearer {token}"
# Response: { "ok": true, "deleted": ..., "exportedBefore": true }
```

---

## Manifest Format

Each export includes a JSON manifest with metadata and hash chain:

```json
{
  "exportDate": "2026-04-26T02:00:00Z",
  "recordCount": 1523,
  "dateRange": { "start": "2026-02-25", "end": "2026-04-25" },
  "s3Path": "s3://orion-audit-logs-prod/2026-04-26/audit-logs-2026-04-26.json.gz",
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

**Verify manifest integrity:**
1. Download manifest from S3
2. Extract the `manifest` hash
3. Remove `manifest` and `previousManifest` fields from JSON
4. Compute SHA-256 of remaining JSON
5. Compare — if equal, manifest is unmodified

**Verify log file integrity:**
1. Download gzipped log file from S3
2. Compute SHA-256 of the gzip file
3. Compare to `hashChain.logs` — if equal, logs are unmodified

The `hashChain.previousManifest` field links to the prior day's manifest, forming a tamper-evident chain.

### S3 Object Paths

- **Logs**: `s3://bucket/YYYY-MM-DD/audit-logs-YYYY-MM-DD.json.gz`
- **Manifest**: `s3://bucket/manifests/manifest-YYYY-MM-DD.json`

---

## Deployment Checklist

### Phase 1: Pre-Deployment (Infrastructure)

**Backend Selection**
- [ ] S3 backend chosen: _______________

**Infrastructure Setup** (see Backend Setup section above for provider-specific steps)
- [ ] Bucket created: _______________ (region/endpoint: _______________)
- [ ] Versioning enabled: `aws s3api get-bucket-versioning --bucket <name>`
- [ ] Lifecycle policy configured (7-year retention)
- [ ] Credentials obtained and stored securely

**AWS SDK**
- [ ] `@aws-sdk/client-s3` in `apps/web/package.json`
- [ ] `npm install` run

### Phase 2: Code Deployment

- [ ] PR from `fix/audit-log-retention` reviewed and approved
- [ ] Security review completed (hash chain and S3 integration)
- [ ] Tests passing
- [ ] Branch merged to `main`
- [ ] Code deployed, dependencies installed

### Phase 3: Environment Configuration

- [ ] `AUDIT_EXPORT_S3_BACKEND` set
- [ ] `AUDIT_EXPORT_S3_ENDPOINT` set (if non-AWS)
- [ ] `AUDIT_EXPORT_S3_BUCKET` set
- [ ] `AUDIT_EXPORT_S3_REGION` set
- [ ] `AWS_ACCESS_KEY_ID` set
- [ ] `AWS_SECRET_ACCESS_KEY` set (stored securely)
- [ ] `AUDIT_EXPORT_RETENTION_DAYS` set (e.g., `30`)
- [ ] `AUDIT_EXPORT_MANIFEST_PATH` set (e.g., `manifests/`)
- [ ] S3 connectivity verified: `aws s3 ls s3://<bucket> --endpoint-url <endpoint>`
- [ ] Database tables present: `AuditLog`, `SystemSetting`, `BackgroundJob`

### Phase 4: Post-Deployment Verification (First 24 Hours)

**Application Startup**
- [ ] Application starts without errors (no `AUDIT_EXPORT_S3_BUCKET` errors)
- [ ] Background job system active
- [ ] Audit export job scheduled: `SELECT * FROM "BackgroundJob" WHERE type = 'audit-export-daily';`

**Manual Export Test**
- [ ] Trigger export: `curl -X POST https://{app}/api/admin/audit-export -H "Authorization: Bearer {token}"`
- [ ] Job completes: status = `completed`
- [ ] Files in S3: `aws s3 ls s3://orion-audit-logs-{env}/ --recursive`
- [ ] Manifest valid JSON with `exportDate`, `recordCount`, `hashChain`
- [ ] Manifest hash chain verifies correctly
- [ ] Object Lock applied (AWS only): check `ObjectLockMode: COMPLIANCE`

**Audit Trail**
- [ ] Export logged: `SELECT * FROM "AuditLog" WHERE target = 'audit_log_export' ORDER BY "createdAt" DESC LIMIT 1;`
- [ ] Job logs stored in `BackgroundJob.logs`

**Cleanup Flow**
- [ ] GET cleanup endpoint returns stats
- [ ] POST cleanup triggers export first (if no recent export), then deletes

**Performance**
- [ ] Export duration < 5 minutes
- [ ] CPU/memory usage normal during export
- [ ] No S3 upload retries or database slow queries

### Phase 5: Scheduled Job Verification (24 Hours Later)

- [ ] Job ran at 2 AM UTC: `SELECT * FROM "BackgroundJob" WHERE type = 'audit-export-daily' ORDER BY "createdAt" DESC LIMIT 1;`
- [ ] Status = `completed`
- [ ] Second manifest created in S3
- [ ] `hashChain.previousManifest` in day 2 manifest equals SHA-256 of day 1 manifest
- [ ] S3 bucket size matches expected volume

### Phase 6: Security & Compliance Review

**Object Lock (AWS S3 only)**
- [ ] COMPLIANCE mode enabled: `aws s3api get-object-lock-configuration --bucket <bucket>`
- [ ] Cannot be disabled (attempt and confirm error)
- [ ] Retention cannot be shortened (attempt and confirm error)
- [ ] Objects cannot be deleted (attempt and confirm error)

**Other backends**
- [ ] Immutability strategy documented (versioning/lifecycle/access controls)

**Audit Trail Completeness**
- [ ] All exports logged: `SELECT COUNT(*) FROM "AuditLog" WHERE target = 'audit_log_export';`
- [ ] User identity captured for manual exports
- [ ] Cleanup actions logged

**SOC2 Compliance**
- [ ] Retention policy met (logs exported before TTL deletion)
- [ ] Tamper-evidence enabled (hash chain verified)
- [ ] Immutability enforced (Object Lock COMPLIANCE)
- [ ] Monitoring in place (BackgroundJob + AuditLog populated)

### Phase 7: Sign-Off

- [ ] Environment details documented (bucket, region, S3 paths)
- [ ] Operations team notified
- [ ] Security team notified (SOC2 control live)
- [ ] Deployment lead sign-off

---

## Rollback Triggers

If any of the following occur, rollback (see `AUDIT_EXPORT_ROLLBACK.md`):
- Export job fails 3+ times in 24 hours
- S3 upload errors prevent logs from being exported
- Manifest corruption or hash chain breaks
- Database performance degrades due to export queries
- Critical bugs found in export code

---

## Post-Deployment Monitoring

**Daily checks:**
```bash
# Job status
SELECT status FROM "BackgroundJob" WHERE type = 'audit-export-daily'
ORDER BY "createdAt" DESC LIMIT 1;

# Latest manifest in S3
aws s3 ls s3://orion-audit-logs-{env}/manifests/ | tail -1
```

**Weekly checks:** 7-day success rate, average export duration, S3 storage costs.

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Query Time | < 100ms (indexed `createdAt`) |
| Export Time | < 5 min typical |
| Compression | 80–90% reduction (gzip on JSON) |
| Memory Usage | < 50MB (streaming writes) |
| S3 Retries | 3 attempts, exponential backoff |
| Batch Delete | 1000 records/batch |

---

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `AUDIT_EXPORT_S3_BUCKET not set` | Missing env var | Add to deployment config |
| `Failed to upload logs to S3 after 3 attempts` | Network/credentials/permissions | Check AWS credentials, bucket policy, region |
| `No audit logs older than retention period` | All logs within retention window | Not an error — returns success with 0 records |
| Export job queued but not running | Worker process down | Check `ps aux | grep worker`, DB connection |
| S3 upload hangs | Credentials/network | `aws s3 ls`, `curl https://s3.amazonaws.com` |
| Hash chain verification fails | Manifest modified after upload or Object Lock not set | Verify manifest, confirm Object Lock enabled |

---

## Troubleshooting

### "Cannot connect to S3 endpoint"

**MinIO:**
```bash
docker ps | grep minio
curl http://minio:9000/minio/health/live
```

**AWS:**
```bash
aws s3 ls --profile default
echo $AWS_DEFAULT_REGION
```

### "Access Denied"

```bash
# MinIO
aws s3 ls s3://orion-audit-logs --endpoint-url http://minio:9000 --region us-east-1

# AWS — check IAM policy
aws iam get-user-policy --user-name orion-s3-user --policy-name S3Access
```

### "Bucket does not exist"

```bash
aws s3 ls --endpoint-url <endpoint>
aws s3 mb s3://bucket-name --endpoint-url <endpoint>
```

---

## Migration Between Backends

No code changes needed — the abstraction layer handles all backend differences.

1. Update `.env` with new backend credentials
2. Restart ORION: `docker restart orion`
3. Trigger manual export to verify: `curl -X POST https://orion.example.com/api/admin/audit-export -H "Authorization: Bearer <token>"`
4. Verify files in new S3 bucket

---

## Compliance: SOC2 [L-001]

| Requirement | Status | Implementation |
|-------------|--------|----------------|
| Retention Policy (30 days) | ✅ | Configurable, enforced via `AUDIT_EXPORT_RETENTION_DAYS` |
| Archival before deletion | ✅ | Export runs before `deleteExportedLogs()` |
| Tamper-evidence | ✅ | SHA-256 hash chain: logs → manifest → previous |
| Immutability | ✅ | S3 Object Lock COMPLIANCE mode, 7 years |
| Audit trail | ✅ | Every export/cleanup logged to `AuditLog` |
| Monitoring | ✅ | `BackgroundJob` table tracks execution |

---

## Known Limitations

1. **AWS SDK Only**: Currently S3-specific; GCS/Azure Blob would require an abstraction layer
2. **No Resume**: S3 upload retries from scratch on failure (no multipart resume)
3. **No Hash Verification CLI**: Manual verification requires downloading manifests and computing SHA-256
4. **Single Worker Assumption**: Multiple workers could cause race conditions on the scheduled job

---

## References

- **Core export logic**: `apps/web/src/lib/audit-export.ts`
- **Daily job**: `apps/web/src/jobs/audit-export-daily.ts`
- **Manual API**: `apps/web/src/app/api/admin/audit-export/route.ts`
- **Cleanup route**: `apps/web/src/app/api/admin/audit-retention/cleanup/route.ts`
- **Config**: `deploy/.env.example`
- **Rollback**: `AUDIT_EXPORT_ROLLBACK.md`
- **MinIO Docs**: https://min.io/docs/minio/container/index.html
- **AWS S3 Docs**: https://docs.aws.amazon.com/s3/

---

**Created**: 2026-04-26  
**Status**: Implementation complete, pending S3 bucket setup by ops
