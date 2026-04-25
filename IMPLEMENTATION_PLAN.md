# K8s Pod Logs Redaction Plan — SOC2 [CR-003]

## Problem
Pod logs may contain secrets, tokens, passwords in plaintext. The `/api/k8s/pods/[ns]/[pod]/logs` endpoint returns raw logs without redaction.

## Implementation Plan

### Implementation
- Add redaction patterns (same as `lib/redact.ts` but for K8s log output)
- Patterns to redact:
  - API keys (orion_ak_*, mcg_*, mcga_*)
  - Bearer tokens
  - JWT tokens
  - Passwords in command-line args
  - Kubernetes secrets (base64-encoded known-secret patterns)
  - Vault tokens

### Changes
- `apps/web/src/app/api/k8s/pods/[ns]/[pod]/logs/route.ts`: Apply redaction to log content
- Reuse patterns from `lib/redact.ts`

### SOC 2 Reference
- AICAA SOC 2 Type II — Confidentiality [CR-003]
