/** Process-level settings shared by the bootstrap flows (resolved at module load). */

export const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? 'http://host.docker.internal:8083'
export const ARGOCD_PASSWORD = process.env.ARGOCD_AUTH_TOKEN

export const ORION_URL       = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  'http://localhost:3000'
).replace(/\/$/, '')
export const MANAGEMENT_IP   = process.env.MANAGEMENT_IP ?? 'localhost'

/** Read-only mount holding the vault-proxy CA used to sign per-cluster ESO client certs. */
export const VAULT_PROXY_CERTS_DIR = '/vault-proxy-certs'
