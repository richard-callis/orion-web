# S3 Backends Decision Matrix

**Quick Reference**: Comparing ORION's S3-compatible storage options

---

## Feature Comparison

| Feature | MinIO | AWS S3 | DO Spaces | Wasabi | Custom |
|---------|-------|--------|-----------|--------|--------|
| **Self-Hosted** | ✓ | ✗ | ✗ | ✗ | Depends |
| **Cloud** | ✗ | ✓ | ✓ | ✓ | Depends |
| **Free Option** | ✓ | ✗ | ✗ | ✗ | Depends |
| **Pay-per-GB** | ✓ | ✓ | ✗ | ✓ | Depends |
| **Flat-rate Pricing** | ✓ | ✗ | ✓ | ✗ | Depends |
| **Object Lock (COMPLIANCE)** | Limited | ✓ | ✗ | ✗ | Limited |
| **Versioning** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Encryption** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **ACLs** | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## Cost Analysis

### Small Deployment (100GB/month)

| Provider | Monthly Cost | Annual Cost |
|----------|-----------|------------|
| MinIO | $0 (infrastructure) | $0* |
| AWS S3 | $2.30 | $27.60 |
| DigitalOcean | $5.00 | $60.00 |
| Wasabi | $0.60 | $7.20 |
| Custom | Varies | Varies |

*MinIO costs: storage device (amortized)

### Medium Deployment (1TB/month)

| Provider | Monthly Cost | Annual Cost |
|----------|-----------|------------|
| MinIO | ~$100 (infrastructure) | ~$1,200* |
| AWS S3 | $23.00 | $276.00 |
| DigitalOcean | $25.00 (5x$5) | $300.00 |
| Wasabi | $6.00 | $72.00 |
| Custom | Varies | Varies |

*MinIO: NAS device + power (approximate)

### Large Deployment (10TB/month)

| Provider | Monthly Cost | Annual Cost |
|----------|-----------|------------|
| MinIO | ~$500 (infrastructure) | ~$6,000* |
| AWS S3 | $230.00 | $2,760.00 |
| DigitalOcean | $225.00 | $2,700.00 |
| Wasabi | $60.00 | $720.00 |
| Custom | Varies | Varies |

---

## Operational Load

### Setup Complexity

| Provider | Time | Difficulty | Automation |
|----------|------|------------|-----------|
| MinIO | 10 min | Low | Ansible/Terraform |
| AWS S3 | 20 min | Medium | CloudFormation/Terraform |
| DigitalOcean | 10 min | Low | Terraform |
| Wasabi | 15 min | Low | AWS CLI |
| Custom | 20+ min | Medium | Case-by-case |

### Ongoing Operations

| Provider | Monitoring | Maintenance | Learning Curve |
|----------|----------|-----------|--------------|
| MinIO | Self | Self | Medium |
| AWS S3 | CloudWatch | AWS handles | High (AWS) |
| DigitalOcean | Control Panel | DO handles | Low |
| Wasabi | Dashboard | Wasabi handles | Low |
| Custom | Provider-specific | Provider | Medium |

### Infrastructure Requirements

| Provider | Hardware | Network | Scaling |
|----------|----------|---------|---------|
| MinIO | NAS/SSD | Local/VPN | Horizontal (Kubernetes) |
| AWS S3 | None | Public | Automatic |
| DigitalOcean | None | Public | Automatic |
| Wasabi | None | Public | Automatic |
| Custom | Depends | Depends | Depends |

---

## Performance Characteristics

### Request Latency

| Provider | Upload | Download | Retrieval Type |
|----------|--------|----------|-----------------|
| MinIO | <10ms | <10ms | Instant (hot) |
| AWS S3 | 50-100ms | 50-100ms | Instant (hot) |
| DigitalOcean | 50-100ms | 50-100ms | Instant (hot) |
| Wasabi | 100-200ms | 100-200ms | Slow (cold) |

### Throughput

| Provider | Concurrent Uploads | Peak Throughput | Throttling |
|----------|------------------|-----------------|-----------|
| MinIO | Limited by storage | 1-10 Gbps | No |
| AWS S3 | Unlimited | Unlimited | After 3,500 RPS |
| DigitalOcean | Limited | 250GB max space | Hard limit |
| Wasabi | Unlimited | Varies | Rare |

### Retention / Archival

| Provider | Cold Storage | Lifecycle Rules | Min Retention |
|----------|-------------|-----------------|--------------|
| MinIO | Manual | Bucket policies | None |
| AWS S3 | Glacier tiers | Automatic | 30 days (Glacier) |
| DigitalOcean | None | Manual | None |
| Wasabi | Default (cold) | Limited | None |

---

## Compliance & Security

### SOC2 Relevant Features

| Feature | MinIO | AWS S3 | DO Spaces | Wasabi |
|---------|-------|--------|-----------|--------|
| **Server Encryption** | ✓ | ✓ | ✓ | ✓ |
| **HTTPS/TLS** | ✓ | ✓ | ✓ | ✓ |
| **Object Lock** | Limited | ✓ (COMPLIANCE) | ✗ | ✗ |
| **Versioning** | ✓ | ✓ | ✓ | ✓ |
| **Audit Logging** | ✓ | ✓ (CloudTrail) | ✗ | ✗ |
| **Access Controls** | IAM-like | IAM | Tokens | Tokens |
| **Compliance Certs** | Community | SOC2, PCI-DSS | SOC2 | SOC2 |

### Immutability (for AUDIT-001)

| Provider | COMPLIANCE Mode | Object Lock | Duration |
|----------|-----------------|------------|----------|
| MinIO | Limited | Basic | Customizable |
| AWS S3 | ✓ Full | ✓ COMPLIANCE | 2555 days max |
| DigitalOcean | ✗ None | ✗ None | N/A |
| Wasabi | ✗ None | ✗ None | N/A |

---

## Use Case Recommendations

### Production (Cloud + SLA)

**Tier 1 (Standard)**: AWS S3
- Unlimited scalability
- SOC2 + PCI-DSS compliance
- Object Lock COMPLIANCE mode
- CloudTrail audit logging
- AWS Enterprise Support

**Tier 2 (Alternative)**: DigitalOcean Spaces
- Simpler operations
- Cost-effective for <250GB
- Good for small deployments
- SOC2 compliance

### Production (Self-Hosted)

**MinIO + Kubernetes**
- Full control of data
- Compliance with air-gap requirements
- Scalable to multi-node cluster
- Requires Kubernetes expertise

### Archive / Cold Storage

**Wasabi**
- Lowest cost per GB
- Good for infrequently-accessed logs
- Cold storage by design
- Perfect for 7-year retention archives

### Development / Testing

**MinIO (local)**
- Quick local setup
- No AWS account needed
- Free to run
- Identical S3 API to production

---

## Migration Paths

```
MinIO ←→ AWS S3 ←→ DigitalOcean
  ↓        ↓          ↓
  └←──→ Wasabi ←──→ Custom
```

All backends are interchangeable — migrate anytime by:
1. Update `.env` with new credentials
2. Restart ORION
3. New exports go to new backend
4. Old logs remain in old backend (or migrate manually)

---

## Total Cost of Ownership (3-year outlook)

### Scenario: 500GB/month audit logs

| Provider | Year 1 | Year 2 | Year 3 | 3-Year Total |
|----------|--------|--------|--------|-------------|
| **MinIO** | $5,000 | $4,000 | $4,000 | **$13,000** |
| **AWS S3** | $1,380 | $1,380 | $1,380 | **$4,140** |
| **DigitalOcean** | $1,200 | $1,200 | $1,200 | **$3,600** |
| **Wasabi** | $360 | $360 | $360 | **$1,080** |

*MinIO: Hardware amortization + maintenance labor*
*DigitalOcean: 5x spaces @ $5/month each*

---

## Decision Flow

```
START
  │
  ├─→ Do you have AWS? ──YES──→ AWS S3 ✓
  │                      (production standard)
  │
  └─→ DO──NO──→ Need self-hosted?
              │
              ├─→ YES ──→ MinIO ✓
              │          (homelab/air-gap)
              │
              └─→ NO ──→ Budget < $10/mo?
                         │
                         ├─→ YES ──→ Wasabi ✓
                         │          (archive)
                         │
                         └─→ NO ──→ DigitalOcean ✓
                                   (small cloud)
```

---

## Key Takeaways

1. **All backends are fully supported** by ORION (no code changes needed)
2. **AWS S3** is the standard for production (immutability + compliance)
3. **MinIO** is ideal for homelab/self-hosted (free + local control)
4. **DigitalOcean** is best for small cloud deployments ($5/mo)
5. **Wasabi** is cheapest for archive (cold storage)
6. **You can switch** between backends anytime
7. **Object Lock COMPLIANCE** only available on AWS S3 (for SOC2)

---

**Document Created**: 2026-04-26  
**Last Updated**: 2026-04-26  
**Status**: Ready for Reference
