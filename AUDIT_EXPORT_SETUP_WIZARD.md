# AUDIT-001: S3 Backend Setup Wizard

**Document**: Interactive Guide to Choosing and Configuring S3 Storage Backend  
**Audience**: DevOps Engineers, System Administrators  
**Status**: Ready for implementation  
**Date**: 2026-04-26

---

## Overview

ORION's audit log export system supports **5 different S3-compatible storage backends**. This wizard helps you choose the right one for your deployment and configure it correctly.

Each backend is fully supported with identical code — there is no need to choose at development time. Choose based on your operational needs: cost, self-hosting, scalability, or compliance.

---

## Quick Decision Tree

```
Does your organization have AWS?
├─ YES, cloud production
│  └─ → AWS S3 (Recommended for production)
│
├─ NO, prefer cloud anyway
│  ├─ Small production (<1TB/year)
│  │  └─ → DigitalOcean Spaces ($5/month flat)
│  │
│  └─ Archive/infrequent access
│     └─ → Wasabi (~$0.006/GB, very cheap)
│
└─ NO, self-host everything
   └─ → MinIO (Free, containerized)
```

---

## Option 1: MinIO (Homelab / Self-Hosted)

**Best for**: Organizations self-hosting everything, home labs, air-gapped networks  
**Cost**: Free (software license)  
**Setup time**: 10 minutes  
**Scalability**: Limited to single node (or cluster with Kubernetes)  
**Support**: Community

### When to Choose MinIO

- You already run Kubernetes or Docker Compose
- You want zero cloud dependencies
- You need air-gapped/offline storage
- You're comfortable managing infrastructure
- Cost is the primary concern
- You have network storage available (NAS, SAN)

### Setup Instructions

#### Step 1: Run MinIO Container

**Docker Compose**:

```yaml
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

**Run**:
```bash
docker-compose up -d minio
```

**Verify**:
```bash
curl http://localhost:9000/minio/health/live
# Expected: 200 OK
```

#### Step 2: Create Bucket

**Via Web Console**:
1. Open http://localhost:9001
2. Login with `minioadmin` / `change-me-securely`
3. Click "Create Bucket" → Name: `orion-audit-logs`
4. Leave all settings default

**Via AWS CLI**:
```bash
aws s3 mb s3://orion-audit-logs \
  --endpoint-url http://localhost:9000 \
  --region us-east-1
```

#### Step 3: Configure ORION

**File**: `deploy/.env`

```bash
AUDIT_EXPORT_S3_BACKEND=minio
AUDIT_EXPORT_S3_ENDPOINT=http://minio:9000
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs
AWS_ACCESS_KEY_ID=minioadmin
AWS_SECRET_ACCESS_KEY=change-me-securely
AUDIT_EXPORT_RETENTION_DAYS=30
```

#### Step 4: Test

```bash
# Check connection from ORION container
curl -u minioadmin:change-me-securely http://minio:9000/minio/health/live

# List bucket
aws s3 ls s3://orion-audit-logs \
  --endpoint-url http://minio:9000 \
  --region us-east-1
```

### Monitoring MinIO

**Check stats**:
```bash
# Container logs
docker logs orion-minio

# Disk usage
docker exec orion-minio df -h /data

# Via console: http://localhost:9001
```

### Storage Recommendations

For 30 days of audit logs (typical retention):

- **Small deployment** (1,000 logs/day): ~100MB gzipped
- **Medium deployment** (10,000 logs/day): ~1GB gzipped
- **Large deployment** (100,000 logs/day): ~10GB gzipped

**Storage allocation**: Allocate 2x estimated log volume + 10GB buffer

---

## Option 2: AWS S3 (Cloud Production)

**Best for**: Production systems, AWS-first organizations, unlimited scalability  
**Cost**: ~$0.023/GB (us-east-1)  
**Setup time**: 20 minutes  
**Scalability**: Unlimited  
**Support**: AWS Enterprise Support (paid)

### When to Choose AWS S3

- Your organization standardizes on AWS
- You need production-grade SLA
- You want unlimited scalability
- You have AWS IAM and organizational policies
- Compliance requires specific regions (e.g., eu-west-1)
- You want global distribution

### Setup Instructions

#### Step 1: Create S3 Bucket

**Via AWS Console**:

1. Go to S3 → Create Bucket
2. **Bucket name**: `orion-audit-logs-prod` (globally unique)
3. **Region**: `us-east-1`
4. **Object Lock**: Enable ✓ (required for COMPLIANCE mode)
5. **Versioning**: Enable ✓ (preserve export history)
6. Click "Create"

**Via AWS CLI**:

```bash
BUCKET_NAME="orion-audit-logs-prod"
AWS_REGION="us-east-1"

aws s3api create-bucket \
  --bucket ${BUCKET_NAME} \
  --region ${AWS_REGION} \
  --object-lock-enabled-for-bucket
```

#### Step 2: Configure IAM

**Create IAM User**:

```bash
aws iam create-user --user-name orion-s3-user
aws iam create-access-key --user-name orion-s3-user
# Save: Access Key ID and Secret Access Key
```

**Attach Policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListAuditBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::orion-audit-logs-prod"
    },
    {
      "Sid": "PutAuditLogs",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::orion-audit-logs-prod/*"
    }
  ]
}
```

#### Step 3: Configure ORION

**File**: `deploy/.env`

```bash
AUDIT_EXPORT_S3_BACKEND=aws
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-audit-logs-prod
AWS_ACCESS_KEY_ID=<from-iam-user>
AWS_SECRET_ACCESS_KEY=<from-iam-user>
AUDIT_EXPORT_RETENTION_DAYS=30
```

#### Step 4: Enable Compliance

```bash
aws s3api put-object-lock-configuration \
  --bucket orion-audit-logs-prod \
  --object-lock-configuration \
    'ObjectLockEnabled=Enabled,Rule={DefaultRetention={Mode=COMPLIANCE,Days=2555}}'
```

### Cost Estimation

| Volume | Monthly Cost |
|--------|-----------|
| 1 GB/month | $0.02 |
| 10 GB/month | $0.23 |
| 100 GB/month | $2.30 |
| 1 TB/month | $23.00 |

---

## Option 3: DigitalOcean Spaces (Budget-Friendly Cloud)

**Best for**: Small production deployments, budget-conscious organizations  
**Cost**: $5/month flat (250GB) + $0.02/GB overage  
**Setup time**: 10 minutes  
**Scalability**: Limited (250GB-5TB typical)  
**Support**: DigitalOcean Community

### When to Choose DigitalOcean Spaces

- Small production (<250GB audit logs)
- Want simple, flat-rate pricing
- Don't need AWS ecosystem
- Prefer simpler operations than AWS
- Cloud storage but cost-conscious
- Happy with DigitalOcean support level

### Setup Instructions

#### Step 1: Create Access Key

1. Go to DigitalOcean Control Panel
2. → Account → API → Spaces Keys
3. Click "Generate New Key"
4. Save: Access Key and Secret Key

#### Step 2: Create Space

1. Go to Spaces
2. Create new space: `orion-audit`
3. Choose region: `nyc3` (or closest to you)
4. Leave all settings default

**Via AWS CLI**:

```bash
aws s3 mb s3://orion-audit \
  --endpoint-url https://nyc3.digitaloceanspaces.com \
  --region nyc3 \
  --profile do
```

#### Step 3: Configure ORION

**File**: `deploy/.env`

```bash
AUDIT_EXPORT_S3_BACKEND=digitalocean
AUDIT_EXPORT_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
AUDIT_EXPORT_S3_REGION=nyc3
AUDIT_EXPORT_S3_BUCKET=orion-audit
AWS_ACCESS_KEY_ID=<spaces-key>
AWS_SECRET_ACCESS_KEY=<spaces-secret>
AUDIT_EXPORT_RETENTION_DAYS=30
```

### Monitoring

**View usage**:
- DigitalOcean Control Panel → Spaces → Space name → Info tab

### Cost Estimation

| Volume | Monthly Cost |
|--------|-----------|
| 50 GB | $5.00 (base) |
| 250 GB | $5.00 (base) |
| 300 GB | $5.00 + (50 × $0.02) = $6.00 |
| 500 GB | $5.00 + (250 × $0.02) = $10.00 |

---

## Option 4: Wasabi (Cold Storage, Cheapest)

**Best for**: Archive storage, infrequently-accessed logs, cost optimization  
**Cost**: ~$0.006/GB (very cheap, per-use)  
**Setup time**: 15 minutes  
**Scalability**: Unlimited  
**Support**: Wasabi Support (email, community)

### When to Choose Wasabi

- Archive/cold storage (accessed rarely)
- Very cost-conscious (<$10/month target)
- Don't need instant retrieval
- Want cheap backup for compliance
- Already comfortable with AWS-compatible APIs

### Setup Instructions

#### Step 1: Create Wasabi Account

1. Go to https://wasabi.com
2. Sign up for free account
3. Create root API credential

#### Step 2: Create Access Credentials

1. Account Dashboard → API
2. Create new access key
3. Save: Access Key and Secret Key

#### Step 3: Create Bucket

**Via AWS CLI**:

```bash
aws s3 mb s3://orion-backup \
  --endpoint-url https://s3.us-east-1.wasabisys.com \
  --region us-east-1 \
  --profile wasabi
```

#### Step 4: Configure ORION

**File**: `deploy/.env`

```bash
AUDIT_EXPORT_S3_BACKEND=wasabi
AUDIT_EXPORT_S3_ENDPOINT=https://s3.us-east-1.wasabisys.com
AUDIT_EXPORT_S3_REGION=us-east-1
AUDIT_EXPORT_S3_BUCKET=orion-backup
AWS_ACCESS_KEY_ID=<wasabi-key>
AWS_SECRET_ACCESS_KEY=<wasabi-secret>
AUDIT_EXPORT_RETENTION_DAYS=30
```

### Cost Estimation

| Volume | Monthly Cost |
|--------|-----------|
| 10 GB | $0.06 |
| 100 GB | $0.60 |
| 1 TB | $6.00 |
| 10 TB | $60.00 |

---

## Option 5: Custom S3-Compatible Provider

**For**: Other providers (Linode, Backblaze, etc.)

### Setup Instructions

1. Get endpoint URL from provider documentation
2. Create access credentials
3. Create bucket
4. Configure ORION:

```bash
AUDIT_EXPORT_S3_BACKEND=custom
AUDIT_EXPORT_S3_ENDPOINT=https://s3.example.com
AUDIT_EXPORT_S3_REGION=us-east-1  # Check with provider
AUDIT_EXPORT_S3_BUCKET=my-logs
AUDIT_EXPORT_S3_FORCE_PATH_STYLE=false  # Check with provider
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
```

---

## Decision Matrix

| Factor | MinIO | AWS S3 | DO Spaces | Wasabi | Custom |
|--------|-------|--------|-----------|--------|--------|
| **Cost** | $0 | $0.023/GB | $5/mo flat | $0.006/GB | Varies |
| **Setup** | 10 min | 20 min | 10 min | 15 min | Varies |
| **Complexity** | Low | Medium | Low | Low | Medium |
| **Scalability** | Limited | Unlimited | Limited | Limited | Varies |
| **SLA** | Community | 99.99% | 99.95% | 99.5% | Varies |
| **Support** | Community | AWS | DigitalOcean | Email | N/A |
| **Best For** | Homelab | Production | Small cloud | Archive | Specialized |
| **Ops Load** | Medium | High | Low | Low | Medium |

---

## Migration Between Backends

You can migrate between backends at any time by:

1. **Export all logs to target backend** using temporary export job
2. **Update .env** with new backend credentials
3. **Restart ORION** application
4. **Verify** first export succeeds on new backend

No code changes needed — the abstraction layer handles all backend differences.

### Migration Example

```bash
# Step 1: Stop existing exports temporarily
# (Pause scheduled job or let current one finish)

# Step 2: Update .env
AUDIT_EXPORT_S3_BACKEND=aws
AUDIT_EXPORT_S3_ENDPOINT=  # Remove this for AWS
AWS_ACCESS_KEY_ID=<new-aws-key>
AWS_SECRET_ACCESS_KEY=<new-aws-secret>

# Step 3: Restart
docker restart orion

# Step 4: Trigger manual export to test
curl -X POST https://orion.example.com/api/admin/audit-export \
  -H "Authorization: Bearer <token>"

# Step 5: Verify in S3
aws s3 ls s3://orion-audit-logs-prod/ --recursive
```

---

## Troubleshooting

### "Cannot connect to S3 endpoint"

**MinIO**:
```bash
# Check MinIO is running
docker ps | grep minio

# Check endpoint is accessible
curl http://minio:9000/minio/health/live
```

**AWS**:
```bash
# Check IAM credentials
aws s3 ls --profile default

# Check region
echo $AWS_DEFAULT_REGION
```

### "Access Denied" errors

**Verify credentials**:
```bash
# MinIO
aws s3 ls s3://orion-audit-logs \
  --endpoint-url http://minio:9000 \
  --region us-east-1

# AWS
aws s3 ls --profile default

# DigitalOcean
aws s3 ls s3://orion-audit \
  --endpoint-url https://nyc3.digitaloceanspaces.com \
  --region nyc3
```

**Check IAM policy** (AWS only):
```bash
aws iam get-user-policy \
  --user-name orion-s3-user \
  --policy-name S3Access
```

### "Bucket does not exist"

```bash
# List buckets
aws s3 ls --endpoint-url <endpoint>

# Create bucket
aws s3 mb s3://bucket-name --endpoint-url <endpoint>
```

### Performance Issues

- **MinIO**: Ensure storage device has fast I/O
- **AWS**: Check CloudWatch metrics for throttling
- **DigitalOcean**: Check space isn't at 250GB limit
- **Wasabi**: Expect slower retrieval (cold storage)

---

## Next Steps

After choosing your backend:

1. **Complete setup** using instructions above
2. **Test connectivity** from ORION container
3. **Deploy ORION** with configured .env
4. **Trigger manual export** to verify end-to-end
5. **Monitor first scheduled export** (2 AM UTC daily)
6. **Review manifests** in S3 to verify hash chain integrity

See `AUDIT_EXPORT_DEPLOYMENT_CHECKLIST.md` for detailed verification steps.

---

## References

- **MinIO Docs**: https://min.io/docs/minio/container/index.html
- **AWS S3**: https://docs.aws.amazon.com/s3/
- **DigitalOcean Spaces**: https://docs.digitalocean.com/products/spaces/
- **Wasabi**: https://wasabi-support.zendesk.com/hc/en-us
- **ORION Implementation**: See `audit-export.ts` and `s3-backends.ts`

---

**Document Created**: 2026-04-26  
**Last Updated**: 2026-04-26  
**Status**: Ready for Use
