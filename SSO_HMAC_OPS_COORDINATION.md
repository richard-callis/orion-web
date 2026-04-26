# SSO-001 Ops Coordination Guide: HMAC-SHA256 Validation for SSO Headers

**Issue**: P0 Header injection vulnerability in SSO authentication  
**Solution**: HMAC-SHA256 signature validation on SSO headers  
**Status**: Ready for production deployment  
**Timeline**: Pre-deployment config required; post-deployment verification needed  

---

## Overview

This document guides operations teams through deploying the HMAC-SHA256 validation feature for SSO headers. The implementation prevents header injection attacks if the reverse proxy is compromised.

**Key constraint**: The reverse proxy (Authentik, Traefik, or nginx) MUST be configured to compute and sign HMAC headers BEFORE the app is deployed. Without reverse proxy changes, SSO authentication will fail.

---

## Architecture

### Current Flow (Pre-Fix)
```
User → Reverse Proxy → [adds SSO headers] → App
                       x-authentik-username: alice (UNTRUSTED)
                       x-authentik-email: alice@example.com
```

**Vulnerability**: Headers are unsigned. If proxy is compromised, attacker can inject arbitrary headers.

### New Flow (Post-Fix)
```
User → Reverse Proxy → [signs headers with HMAC-SHA256] → App
                       x-authentik-username: alice
                       x-authentik-email: alice@example.com
                       x-authentik-hmac: <signature>
                       
                       App validates signature using SSO_HMAC_SECRET
                       (rejects if signature invalid or missing)
```

**Protection**: Only requests signed with the correct secret are accepted.

---

## Section 1: Reverse Proxy Configuration

### 1.1 Choose Your Proxy Type

Select the configuration that matches your environment:

#### Option A: Authentik (Recommended)

**What it does**: Authentik's "Custom Attributes" feature allows adding HMAC-signed headers.

**Setup Steps**:

1. **Generate HMAC secret** (on the app server or locally):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Example output:
   ```
   a1b2c3d4e5f6789abcdef0123456789a1b2c3d4e5f6789abcdef0123456789
   ```
   Save this securely.

2. **In Authentik Admin**: Navigate to **Flows & Stages** → **Stages** → Create or edit your authentication flow

3. **Add Custom Attributes stage**:
   - Name: "HMAC Sign Headers"
   - Add JavaScript code to compute HMAC:
   ```javascript
   // Compute HMAC-SHA256 of canonical string
   const crypto = require('crypto');
   const secret = context.request.environ.get('SSO_HMAC_SECRET'); // From Authentik env
   
   const username = user.username;
   const email = user.email;
   const name = user.name || '';
   const uid = user.pk;
   const timestamp = Math.floor(Date.now() / 1000) * 1000; // milliseconds
   
   const canonical = `${username}|${email}|${name}|${uid}|${timestamp}`;
   const hmac = crypto
     .createHmac('sha256', secret)
     .update(canonical)
     .digest('hex');
   
   // Store in context for header injection
   context.x_authentik_hmac = hmac;
   context.x_authentik_timestamp = timestamp;
   ```

4. **Configure header forwarding** in Authentik's proxy outbound:
   - Headers to inject:
     ```
     x-authentik-username: ${user.username}
     x-authentik-email: ${user.email}
     x-authentik-name: ${user.name}
     x-authentik-uid: ${user.pk}
     x-authentik-timestamp: ${x_authentik_timestamp}
     x-authentik-hmac: ${x_authentik_hmac}
     ```

5. **Test in staging first** — verify headers are present and HMAC validates in app logs.

---

#### Option B: Traefik with Custom Middleware

**What it does**: Traefik middleware can compute HMAC and add headers dynamically.

**Setup Steps**:

1. **Create a Traefik plugin or use a sidecar** to compute HMAC.
   
   Example middleware (as a standalone service):
   ```yaml
   # traefik-hmac-signer.yaml
   apiVersion: v1
   kind: Service
   metadata:
     name: traefik-hmac-signer
   spec:
     ports:
     - port: 8080
   ---
   apiVersion: apps/v1
   kind: Deployment
   metadata:
     name: traefik-hmac-signer
   spec:
     replicas: 1
     template:
       spec:
         containers:
         - name: signer
           image: your-registry/traefik-hmac-signer:latest
           env:
           - name: SSO_HMAC_SECRET
             valueFrom:
               secretKeyRef:
                 name: sso-hmac
                 key: secret
           ports:
           - containerPort: 8080
   ```

2. **In Traefik config**, add a ForwardAuth middleware:
   ```yaml
   apiVersion: traefik.containo.us/v1alpha1
   kind: Middleware
   metadata:
     name: hmac-sign
   spec:
     forwardAuth:
       address: http://traefik-hmac-signer:8080
       trustForwardHeader: true
   ```

3. **Apply to your IngressRoute**:
   ```yaml
   apiVersion: traefik.containo.us/v1alpha1
   kind: IngressRoute
   metadata:
     name: my-app
   spec:
     routes:
     - match: Host(`app.example.com`)
       middlewares:
       - name: hmac-sign
       services:
       - name: my-app
         port: 3000
   ```

4. **HMAC Signer service code** (reference implementation):
   ```typescript
   import express from 'express';
   import { createHmac } from 'crypto';
   
   const app = express();
   const HMAC_SECRET = process.env.SSO_HMAC_SECRET;
   
   app.use((req, res, next) => {
     // Traefik forwards the request; we add HMAC headers and return
     const username = req.headers['x-forwarded-user'] || 'unknown';
     const email = req.headers['x-forwarded-email'] || '';
     const name = req.headers['x-forwarded-name'] || '';
     const uid = req.headers['x-forwarded-id'] || '';
     const timestamp = Date.now();
     
     const canonical = `${username}|${email}|${name}|${uid}|${timestamp}`;
     const hmac = createHmac('sha256', HMAC_SECRET)
       .update(canonical)
       .digest('hex');
     
     // Return with HMAC headers (Traefik will forward these)
     res.set('x-authentik-username', username);
     res.set('x-authentik-email', email);
     res.set('x-authentik-name', name);
     res.set('x-authentik-uid', uid);
     res.set('x-authentik-timestamp', timestamp.toString());
     res.set('x-authentik-hmac', hmac);
     res.status(200).send('OK');
   });
   
   app.listen(8080);
   ```

---

#### Option C: nginx with Lua Module

**What it does**: nginx's Lua module can compute HMAC inline.

**Setup Steps**:

1. **Ensure nginx has lua module**:
   ```bash
   nginx -V 2>&1 | grep lua
   ```
   If not, recompile nginx with `--with-http_lua_module`.

2. **Create an HMAC signing location** in nginx.conf:
   ```nginx
   upstream my_app {
     server localhost:3000;
   }
   
   server {
     listen 443 ssl http2;
     server_name app.example.com;
   
     # Lua block to compute HMAC
     set $hmac_secret "YOUR_SECRET_HERE";
     
     location / {
       access_by_lua_block {
         local ngx = ngx
         local username = ngx.var.remote_user or "unknown"
         local timestamp = math.floor(ngx.now() * 1000)
         
         -- Compute HMAC-SHA256
         local hmac = require "resty.hmac"
         local sha256 = require "resty.sha256"
         local str = require "resty.string"
         
         local secret = os.getenv("SSO_HMAC_SECRET")
         local canonical = username .. "|" .. username .. "@example.com|User|" .. username .. "|" .. timestamp
         
         local h = hmac:new(secret, hmac.ALGOS.SHA256)
         local digest = h:final(canonical)
         local signature = str.to_hex(digest)
         
         ngx.req.set_header("x-authentik-username", username)
         ngx.req.set_header("x-authentik-email", username .. "@example.com")
         ngx.req.set_header("x-authentik-uid", username)
         ngx.req.set_header("x-authentik-timestamp", timestamp)
         ngx.req.set_header("x-authentik-hmac", signature)
       }
       
       proxy_pass http://my_app;
     }
   }
   ```

3. **Test the configuration**:
   ```bash
   nginx -t
   systemctl reload nginx
   ```

---

### 1.2 Secret Management

**Generate the HMAC secret** (if not already done):

```bash
# Option 1: Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Option 2: OpenSSL
openssl rand -hex 32

# Option 3: Python
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**Storage**:
- Store in your secret management system (HashiCorp Vault, AWS Secrets Manager, Kubernetes Secrets)
- **Do NOT** hardcode in git or config files
- **Do NOT** log or expose in error messages

**Example (Kubernetes Secret)**:
```bash
kubectl create secret generic sso-hmac \
  --from-literal=secret=a1b2c3d4e5f6789abcdef0123456789a1b2c3d4e5f6789abcdef0123456789 \
  -n my-app
```

---

## Section 2: Environment Setup

### 2.1 App Server: Set Environment Variables

The app requires `SSO_HMAC_SECRET` to be set before deployment.

**In Kubernetes** (recommended):
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-app
spec:
  containers:
  - name: app
    env:
    - name: SSO_HMAC_SECRET
      valueFrom:
        secretKeyRef:
          name: sso-hmac
          key: secret
```

**In Docker Compose**:
```yaml
services:
  app:
    environment:
      - SSO_HMAC_SECRET=${SSO_HMAC_SECRET}
```

**In a .env file** (development/staging only):
```bash
SSO_HMAC_SECRET=a1b2c3d4e5f6789abcdef0123456789a1b2c3d4e5f6789abcdef0123456789
```

### 2.2 Key Rotation (Optional)

For seamless secret rotation without downtime:

1. **Generate a new secret**:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **Set both old and new secrets on the app** (grace period):
   ```bash
   export SSO_HMAC_SECRET="new_secret_here"
   export SSO_HMAC_SECRET_PREVIOUS="old_secret_here"
   ```

3. **Update reverse proxy** to use the new secret.

4. **Wait 5 minutes** for all requests to clear.

5. **Remove `SSO_HMAC_SECRET_PREVIOUS`** and restart the app.

**Recommended rotation schedule**: Every 90 days (standard for symmetric keys)

---

## Section 3: Deployment Checklist

### 3.1 Pre-Deployment (Do Before Deploying App Code)

- [ ] **Reverse proxy configuration tested in staging**
  - HMAC computation verified
  - Headers are present in test requests
  - Secret is securely stored in proxy environment
  
- [ ] **HMAC secret generated and stored**
  - `SSO_HMAC_SECRET` created (32 bytes, hex or base64)
  - Stored in secret management system
  - Accessible to app deployment
  
- [ ] **Staging environment validated**
  - Deploy app code to staging
  - Set `SSO_HMAC_SECRET` in staging
  - Verify SSO users can login
  - Check logs for `user_login_failure` with reason `invalid_hmac` (should be 0)

### 3.2 Deployment (Production)

1. **Update reverse proxy** (if not already done):
   - Authentik: Add custom stage with HMAC computation
   - Traefik: Deploy HMAC signer service + middleware
   - nginx: Update config with Lua block
   - **Verify**: Test a request, check for `x-authentik-hmac` header

2. **Deploy app code**:
   ```bash
   git pull origin fix/sso-header-hmac-validation
   git merge fix/sso-header-hmac-validation main
   deploy.sh  # or equivalent
   ```

3. **Set environment variables**:
   - `SSO_HMAC_SECRET` (required)
   - `SSO_HMAC_SECRET_PREVIOUS` (optional, for rotation)
   - Restart app container/pod

### 3.3 Post-Deployment Verification (30 minutes after deployment)

- [ ] **SSO login works**
  - Test with a known SSO user
  - Verify they are authenticated
  - Check that `lastSeen` is updated in DB

- [ ] **Audit logs show successful logins**
  ```sql
  SELECT COUNT(*) FROM "AuditLog" 
  WHERE action = 'user_login' 
  AND target LIKE '%sso%'
  AND createdAt > NOW() - INTERVAL '5 minutes';
  ```

- [ ] **No HMAC validation failures in logs**
  ```bash
  # Check app logs for errors
  kubectl logs -f deployment/my-app | grep "invalid_hmac"
  # Should be empty (or very few, if proxy was being updated)
  ```

- [ ] **Monitoring alerts configured**
  - Alert if rate of `user_login_failure` with reason `invalid_hmac` > 1/min
  - Alert if rate of failed logins > 5% of all login attempts

### 3.4 Rollback Procedure (If Issues)

**If SSO authentication breaks immediately**:

1. **Quick fix (clock skew)**:
   - Check if reverse proxy and app server clocks are synchronized
   - Run `ntpd` or `chronyc makestep` to sync NTP

2. **Disable HMAC validation temporarily** (emergency only):
   ```bash
   unset SSO_HMAC_SECRET
   kubectl restart deployment/my-app
   # HMAC validation is skipped if secret is not set
   # This is backward-compatible but ONLY during rollout
   ```

3. **Revert app deployment** (if needed):
   ```bash
   git revert <commit-hash>
   deploy.sh
   ```

4. **Debug**:
   - Check if reverse proxy is sending HMAC headers
   - Verify secret matches between proxy and app
   - Check app logs for specific validation failures

---

## Section 4: Testing & Validation

### 4.1 Manual Testing (Staging/Dev)

**Test 1: Valid HMAC signature**

```bash
# Generate a valid signature
SECRET="a1b2c3d4e5f6..."
USERNAME="alice"
EMAIL="alice@example.com"
NAME="Alice Smith"
UID="user-123"
TIMESTAMP=$(date +%s000)  # milliseconds

CANONICAL="${USERNAME}|${EMAIL}|${NAME}|${UID}|${TIMESTAMP}"
HMAC=$(echo -n "$CANONICAL" | openssl dgst -sha256 -mac HMAC -macopt key="$SECRET" -hex | cut -d' ' -f2)

# Make request
curl -i http://localhost:3000/api/profile \
  -H "x-authentik-username: $USERNAME" \
  -H "x-authentik-email: $EMAIL" \
  -H "x-authentik-name: $NAME" \
  -H "x-authentik-uid: $UID" \
  -H "x-authentik-timestamp: $TIMESTAMP" \
  -H "x-authentik-hmac: $HMAC"

# Expected: 200 OK (user authenticated)
```

**Test 2: Invalid HMAC signature**

```bash
# Same headers, but wrong HMAC
curl -i http://localhost:3000/api/profile \
  -H "x-authentik-username: $USERNAME" \
  -H "x-authentik-email: $EMAIL" \
  -H "x-authentik-name: $NAME" \
  -H "x-authentik-uid: $UID" \
  -H "x-authentik-timestamp: $TIMESTAMP" \
  -H "x-authentik-hmac: deadbeefdeadbeefdeadbeef"

# Expected: 401 Unauthorized
```

**Test 3: Expired timestamp**

```bash
# Timestamp from 1 minute ago
OLD_TIMESTAMP=$(($(date +%s000) - 60000))

CANONICAL="${USERNAME}|${EMAIL}|${NAME}|${UID}|${OLD_TIMESTAMP}"
HMAC=$(echo -n "$CANONICAL" | openssl dgst -sha256 -mac HMAC -macopt key="$SECRET" -hex | cut -d' ' -f2)

curl -i http://localhost:3000/api/profile \
  -H "x-authentik-username: $USERNAME" \
  -H "x-authentik-email: $EMAIL" \
  -H "x-authentik-name: $NAME" \
  -H "x-authentik-uid: $UID" \
  -H "x-authentik-timestamp: $OLD_TIMESTAMP" \
  -H "x-authentik-hmac: $HMAC"

# Expected: 401 Unauthorized (timestamp too old)
```

### 4.2 Staging Validation

1. **SSO user login test**:
   - Log in via SSO provider in staging
   - User should be created/updated with SSO metadata
   - Check DB: `SELECT * FROM "User" WHERE provider = 'authentik' ORDER BY createdAt DESC LIMIT 1;`

2. **Audit log check**:
   ```sql
   SELECT userId, action, detail, createdAt FROM "AuditLog" 
   WHERE target = 'sso-header-auth' 
   ORDER BY createdAt DESC 
   LIMIT 5;
   ```
   Expected: All should have action `user_login` (or `user_login_failure` if testing invalid HMAC)

3. **Rate limiting test** (ensure RATE-001 is also deployed):
   ```bash
   for i in {1..20}; do
     curl -s http://localhost:3000/api/profile \
       -H "x-authentik-username: testuser" \
       -H "x-authentik-hmac: invalid$i" &
   done
   wait
   # Should see some 429 Too Many Requests responses
   ```

### 4.3 Production Monitoring

**Metrics to track**:
- Rate of `user_login` events (SSO authentications)
- Rate of `user_login_failure` with reason `invalid_hmac` (should be < 0.1% of login attempts)
- Latency of SSO authentication (should be < 100ms)
- Average age of timestamps in HMAC headers (clock skew indicator)

**Example Prometheus queries**:
```promql
# SSO login success rate
rate(audit_log_total{action="user_login", target="sso-header-auth"}[5m])

# HMAC validation failure rate
rate(audit_log_total{action="user_login_failure", detail_reason="invalid_hmac"}[5m])

# Alert if failure rate > 1 failure per minute
alert: SSO_HMAC_Failures
  for: 2m
  if: rate(audit_log_total{detail_reason="invalid_hmac"}[5m]) > 0.017
```

---

## Section 5: Troubleshooting

### Problem: "HMAC validation failed"

**Root causes**:
1. Reverse proxy is NOT computing HMAC (check proxy logs)
2. Secret mismatch (proxy has different secret than app)
3. Canonical string format mismatch (order of fields incorrect)
4. Timestamp format mismatch (proxy sends seconds, app expects milliseconds)

**Debug steps**:
```bash
# 1. Check if app is receiving HMAC header
kubectl exec pod/my-app -- curl http://localhost:3000/debug/headers | grep x-authentik

# 2. Check reverse proxy logs
kubectl logs deployment/authentik-proxy | grep "HMAC"
# or
docker logs traefik-container | grep "HMAC"

# 3. Verify secrets match
echo "$SSO_HMAC_SECRET"  # On app server
echo "$HMAC_SECRET"       # On proxy server
# Both should produce the same value

# 4. Test HMAC computation locally
node -e "
  const crypto = require('crypto');
  const secret = 'test_secret';
  const canonical = 'alice|alice@example.com|Alice|uid-123|1234567890000';
  const hmac = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  console.log('HMAC:', hmac);
"
```

### Problem: "Timestamp out of range" or "Clock skew"

**Root causes**:
1. Reverse proxy and app server clocks are not synchronized
2. Timestamp is in wrong units (seconds vs. milliseconds)

**Fix**:
```bash
# Sync NTP on both servers
sudo systemctl restart chrony  # or ntpd
sudo chronyc makestep

# Verify clocks are within 1 second
date +%s && kubectl exec pod/proxy -- date +%s
```

### Problem: "Key rotation failed" or "Old secret not working"

**Root causes**:
1. `SSO_HMAC_SECRET_PREVIOUS` not set or set to wrong value
2. Grace period too short (proxy already using new secret, app doesn't have it yet)

**Fix**:
```bash
# Verify the previous secret is set correctly
kubectl get secret sso-hmac -o jsonpath='{.data.secret_previous}' | base64 -d

# Set the correct previous secret
kubectl set env deployment/my-app SSO_HMAC_SECRET_PREVIOUS=oldkey123...

# Wait for rollout
kubectl rollout status deployment/my-app
```

---

## Deployment Template (Copy-Paste Ready)

### Kubernetes Deployment

```yaml
---
# Secret
apiVersion: v1
kind: Secret
metadata:
  name: sso-hmac
type: Opaque
stringData:
  secret: "a1b2c3d4e5f6..." # Generated secret

---
# Deployment with HMAC env var
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: app
        image: my-registry/my-app:latest
        env:
        - name: SSO_HMAC_SECRET
          valueFrom:
            secretKeyRef:
              name: sso-hmac
              key: secret
        # Optional: for key rotation
        # - name: SSO_HMAC_SECRET_PREVIOUS
        #   valueFrom:
        #     secretKeyRef:
        #       name: sso-hmac
        #       key: secret-previous
        ports:
        - containerPort: 3000
```

---

## Contacts & Escalation

- **Security team**: Review HMAC configuration (not required, just recommended)
- **Proxy team**: Implements reverse proxy changes
- **App team**: Deploys app code and sets environment variables
- **SRE/DevOps**: Monitors logs and handles rollback if needed

---

## Additional Resources

- [Implementation Documentation](./SSO_HMAC_DOCUMENTATION.md)
- [Code Changes](https://github.com/orion/pull/XXX)
- [Authentik Custom Headers](https://goauthentik.io/docs/features/custom-attributes)
- [OWASP: Header Injection](https://owasp.org/www-community/Injection/HTTP_Response_Splitting)

---

**Last Updated**: 2026-04-26  
**Status**: Ready for production deployment  
**Next Review**: After first rotation (90 days)
