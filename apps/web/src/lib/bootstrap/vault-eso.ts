import { writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { decrypt } from '../encryption'
import { VAULT_ADDR, vaultFetch } from '../vault'
import { MANAGEMENT_IP, VAULT_PROXY_CERTS_DIR } from './config'
import { runCommand, runQuiet } from './shell'
import { esoVaultManifest, type TLSConfig } from './templates'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

// ── Vault helpers ─────────────────────────────────────────────────────────────

async function vaultRequest(
  path: string,
  token: string,
  method: string = 'GET',
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await vaultFetch(`${VAULT_ADDR}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = res.status !== 204 ? await res.json().catch(() => ({})) : {}
  return { ok: res.ok, status: res.status, data }
}

// ── mTLS client cert generation ───────────────────────────────────────────────

/** Generate a per-cluster client cert signed by the vault-proxy CA. */
async function generateClientCert(
  envName: string,
  tmpDir: string,
): Promise<{ certPem: string; keyPem: string } | null> {
  const caKeyPath  = join(VAULT_PROXY_CERTS_DIR, 'ca.key')
  const caCertPath = join(VAULT_PROXY_CERTS_DIR, 'ca.crt')

  // Check CA key is accessible (proxy may not be set up yet)
  const caKey = await readFile(caKeyPath, 'utf8').catch(() => null)
  if (!caKey) return null

  const keyPath  = join(tmpDir, `${envName}-client.key`)
  const csrPath  = join(tmpDir, `${envName}-client.csr`)
  const certPath = join(tmpDir, `${envName}-client.crt`)
  const extPath  = join(tmpDir, `${envName}-client.ext`)
  // Use a random serial number rather than a serial file — avoids any writes to the
  // read-only /vault-proxy-certs mount that holds the CA key/cert.
  const serial   = randomBytes(8).toString('hex')

  await writeFile(extPath, [
    '[req_ext]',
    'subjectAltName = @alt_names',
    '[alt_names]',
    `DNS.1 = eso-${envName}`,
  ].join('\n'))

  const steps: Array<[string, string[]]> = [
    ['openssl', ['genrsa', '-out', keyPath, '4096']],
    ['openssl', ['req', '-new', '-key', keyPath, '-out', csrPath, '-subj', `/CN=eso-${envName}/O=ORION`]],
    ['openssl', ['x509', '-req', '-days', '3650',
      '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath,
      '-set_serial', `0x${serial}`, '-out', certPath, '-extfile', extPath, '-extensions', 'req_ext']],
  ]

  for (const [cmd, args] of steps) {
    const result = await runQuiet(cmd, args, {})
    if (!result.ok) throw new Error(`Client cert generation failed (${cmd}): ${result.out}`)
  }

  const [certPem, keyPem] = await Promise.all([
    readFile(certPath, 'utf8'),
    readFile(keyPath, 'utf8'),
  ])
  return { certPem, keyPem }
}

// ── Vault AppRole + ESO ───────────────────────────────────────────────────────

/** Vault + ESO configuration (shared K8s logic). */
export async function bootstrapK8sVaultAndEso(
  env: BootstrapEnvironment,
  slug: string,
  kenv: Record<string, string>,
  tmpDir: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const [vaultAdminSetting, vaultRootSetting, vaultInitSetting] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: 'vault.adminToken' } }),
    prisma.systemSetting.findUnique({ where: { key: 'vault.rootToken' } }),
    prisma.systemSetting.findUnique({ where: { key: 'vault.initialized' } }),
  ])

  const rawToken = vaultAdminSetting?.value ?? vaultRootSetting?.value
  if (vaultRootSetting?.value && !vaultAdminSetting?.value) {
    emit({ type: 'log', message: 'WARNING: Vault is using a root token. Re-initialize Vault in ORION settings to rotate to a scoped admin token.' })
  }

  if (vaultInitSetting?.value && rawToken) {
    const rootToken = decrypt(String(rawToken))
    const policyName = `orion-cluster-${slug}`
    const roleName   = `orion-cluster-${slug}`

    emit({ type: 'step', message: 'Configuring Vault AppRole for this cluster...' })

    await vaultRequest('sys/mounts/secret', rootToken, 'POST', { type: 'kv', options: { version: '2' } })
    await vaultRequest('sys/auth/approle', rootToken, 'POST', { type: 'approle' })

    const policyRes = await vaultRequest(`sys/policies/acl/${policyName}`, rootToken, 'PUT', {
      policy: [
        // MAJOR fix: env.name was used directly in Vault policy paths without slugification.
        // An env name containing '*' or '/' (e.g. '*') would widen the policy to all secrets.
        // Use the same slug used for policyName/roleName — consistent and safe.
        `path "secret/data/${policyName}/*" { capabilities = ["read", "list"] }`,
        `path "secret/metadata/${policyName}/*" { capabilities = ["read", "list"] }`,
      ].join('\n'),
    })
    if (!policyRes.ok) throw new Error(`Vault policy creation failed (${policyRes.status})`)

    const roleRes = await vaultRequest(`auth/approle/role/${roleName}`, rootToken, 'POST', {
      policies: [policyName],
      token_ttl: '1h',
      token_max_ttl: '24h',
    })
    if (!roleRes.ok) throw new Error(`Vault AppRole role creation failed (${roleRes.status})`)

    const roleIdRes = await vaultRequest(`auth/approle/role/${roleName}/role-id`, rootToken)
    if (!roleIdRes.ok) throw new Error(`Could not fetch Vault role-id (${roleIdRes.status})`)
    const roleId = (roleIdRes.data as { data: { role_id: string } }).data.role_id

    const secretCheck = await runQuiet(
      'kubectl', ['get', 'secret', 'orion-vault-approle', '-n', 'external-secrets', '--ignore-not-found'],
      kenv,
    )
    let secretId: string
    if (secretCheck.out.includes('orion-vault-approle')) {
      emit({ type: 'log', message: 'Vault AppRole secret already exists in cluster — skipping secret-id generation' })
      const secretIdFetch = await runQuiet(
        'kubectl', ['get', 'secret', 'orion-vault-approle', '-n', 'external-secrets',
                    '-o', 'jsonpath={.data.secretId}'],
        kenv,
      )
      secretId = Buffer.from(secretIdFetch.out.trim(), 'base64').toString('utf8')
    } else {
      const secretIdRes = await vaultRequest(`auth/approle/role/${roleName}/secret-id`, rootToken, 'POST', {})
      if (!secretIdRes.ok) throw new Error(`Could not generate Vault secret-id (${secretIdRes.status})`)
      secretId = (secretIdRes.data as { data: { secret_id: string } }).data.secret_id
    }

    emit({ type: 'log', message: `Vault AppRole '${roleName}' ready` })

    // Install ESO
    emit({ type: 'step', message: 'Installing External Secrets Operator...' })
    await runCommand('helm', ['repo', 'add', 'external-secrets', 'https://charts.external-secrets.io', '--force-update'], kenv, msg => emit({ type: 'log', message: msg }))
    await runCommand('helm', ['repo', 'update', 'external-secrets'], kenv, msg => emit({ type: 'log', message: msg }))
    await runCommand('helm', ['upgrade', '--install', 'external-secrets', 'external-secrets/external-secrets', '--namespace', 'external-secrets', '--create-namespace', '--wait', '--timeout', '5m', '--set', 'installCRDs=true'], kenv, msg => emit({ type: 'log', message: msg }))

    emit({ type: 'log', message: 'Waiting for ESO CRDs...' })
    await runCommand('kubectl', ['wait', '--for=condition=established', '--timeout=120s', 'crd/clustersecretstores.external-secrets.io', 'crd/externalsecrets.external-secrets.io'], kenv, msg => emit({ type: 'log', message: msg }))

    // Apply ClusterSecretStore
    emit({ type: 'step', message: 'Configuring ClusterSecretStore → ORION Vault...' })
    const caCertPem = await readFile(join(VAULT_PROXY_CERTS_DIR, 'ca.crt'), 'utf8').catch(() => null)
    let vaultExtAddr: string
    let tlsConfig: TLSConfig | undefined

    if (caCertPem) {
      vaultExtAddr = `https://${MANAGEMENT_IP}:8200`
      const clientCert = await generateClientCert(env.name, tmpDir)
      if (clientCert) {
        tlsConfig = {
          caBundleB64: Buffer.from(caCertPem).toString('base64'),
          clientCertPem: clientCert.certPem,
          clientKeyPem: clientCert.keyPem,
        }
        emit({ type: 'log', message: 'mTLS enabled' })
      } else {
        tlsConfig = { caBundleB64: Buffer.from(caCertPem).toString('base64'), clientCertPem: '', clientKeyPem: '' }
        emit({ type: 'log', message: 'One-way TLS — client cert skipped' })
      }
    } else {
      vaultExtAddr = `http://${MANAGEMENT_IP}:8200`
    }

    await writeFile(join(tmpDir, 'eso-vault.yaml'), esoVaultManifest(roleId, secretId, vaultExtAddr, tlsConfig))
    await runCommand('kubectl', ['apply', '-f', join(tmpDir, 'eso-vault.yaml')], kenv, msg => emit({ type: 'log', message: msg }))
  } else {
    emit({ type: 'log', message: 'Vault not initialized — skipping ESO setup' })
  }
}
