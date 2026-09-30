/**
 * Vault Proxy — TLS certificate management for the Envoy sidecar.
 *
 * Called automatically during Vault initialisation (setup wizard).
 * Generates a self-signed CA and server cert for the vault-proxy container.
 * Per-cluster client certs are generated separately in cluster-bootstrap.ts.
 */

import { spawn } from 'child_process'
import { writeFile, rm, mkdir, access, chmod } from 'fs/promises'
import { mkdtemp } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const CERTS_DIR   = process.env.VAULT_PROXY_CERTS_DIR ?? '/vault-proxy-certs'

function runOpenssl(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => resolve({ ok: code === 0, out: out.trim() }))
    proc.on('error', (err) => resolve({ ok: false, out: err.message }))
  })
}

/**
 * Generate CA + server cert for vault-proxy.
 * Idempotent — skips silently if certs already exist.
 */
export async function generateVaultProxyCerts(): Promise<void> {
  const caCertPath  = join(CERTS_DIR, 'ca.crt')
  const caKeyPath   = join(CERTS_DIR, 'ca.key')
  const tlsCertPath = join(CERTS_DIR, 'tls.crt')
  const tlsKeyPath  = join(CERTS_DIR, 'tls.key')

  const alreadyExists = await access(caCertPath).then(() => true).catch(() => false)
  if (alreadyExists) return

  // Deployment-specific — must come from the environment (deploy/.env), never a baked-in default.
  const managementIp = process.env.MANAGEMENT_IP
  const vaultDomain  = process.env.VAULT_DOMAIN
  if (!managementIp) throw new Error('MANAGEMENT_IP is not set — required for the vault-proxy certificate SAN')
  if (!vaultDomain)  throw new Error('VAULT_DOMAIN is not set — required for the vault-proxy certificate SAN')

  await mkdir(CERTS_DIR, { recursive: true })

  const tmpDir  = await mkdtemp(join(tmpdir(), 'vault-proxy-certs-'))
  const csrPath = join(tmpDir, 'tls.csr')
  const extPath = join(tmpDir, 'san.ext')

  try {
    await writeFile(extPath, [
      '[req_ext]',
      'subjectAltName = @alt_names',
      '[alt_names]',
      `IP.1  = ${managementIp}`,
      `DNS.1 = ${vaultDomain}`,
      'DNS.2 = vault',
      'DNS.3 = localhost',
    ].join('\n'))

    const steps: Array<[string, string[]]> = [
      ['genrsa', ['-out', caKeyPath,   '4096']],
      ['req',    ['-new', '-x509', '-days', '3650',
                  '-key', caKeyPath, '-out', caCertPath,
                  '-subj', '/CN=ORION Vault Proxy CA/O=ORION']],
      ['genrsa', ['-out', tlsKeyPath,  '4096']],
      ['req',    ['-new', '-key', tlsKeyPath, '-out', csrPath,
                  '-subj', '/CN=vault-proxy/O=ORION']],
      ['x509',   ['-req', '-days', '3650',
                  '-in', csrPath, '-CA', caCertPath, '-CAkey', caKeyPath,
                  '-CAcreateserial', '-out', tlsCertPath,
                  '-extfile', extPath, '-extensions', 'req_ext']],
    ]

    for (const [subcmd, args] of steps) {
      const result = await runOpenssl([subcmd, ...args])
      if (!result.ok) throw new Error(`openssl ${subcmd} failed: ${result.out}`)
    }

    await Promise.all([
      chmod(caKeyPath,  0o600),
      chmod(tlsKeyPath, 0o600),
    ])
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
