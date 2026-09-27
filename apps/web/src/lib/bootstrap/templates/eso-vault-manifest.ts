/**
 * ESO → ORION Vault manifests: the AppRole Secret, optional mTLS client-cert
 * Secret, and the ClusterSecretStore. Pure function of its inputs.
 */

export interface TLSConfig {
  caBundleB64: string
  clientCertPem: string
  clientKeyPem: string
}

export function esoVaultManifest(
  roleId: string,
  secretId: string,
  vaultAddr: string,
  tls?: TLSConfig,
): string {
  const hasMTLS = tls && tls.clientCertPem && tls.clientKeyPem

  const tlsSection = tls ? `
      caBundle: "${tls.caBundleB64}"` + (hasMTLS ? `
      tls:
        certSecretRef:
          name: orion-vault-client-tls
          namespace: external-secrets
          key: tls.crt
        keySecretRef:
          name: orion-vault-client-tls
          namespace: external-secrets
          key: tls.key` : '') : ''

  const clientCertSecret = hasMTLS ? `---
apiVersion: v1
kind: Secret
metadata:
  name: orion-vault-client-tls
  namespace: external-secrets
stringData:
  tls.crt: |
${tls.clientCertPem.split('\n').map(l => `    ${l}`).join('\n')}
  tls.key: |
${tls.clientKeyPem.split('\n').map(l => `    ${l}`).join('\n')}
` : ''

  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: external-secrets
---
apiVersion: v1
kind: Secret
metadata:
  name: orion-vault-approle
  namespace: external-secrets
stringData:
  roleId: "${roleId}"
  secretId: "${secretId}"
${clientCertSecret}---
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: orion-vault
spec:
  provider:
    vault:
      server: "${vaultAddr}"
      path: "secret"
      version: "v2"${tlsSection}
      auth:
        appRole:
          path: "approle"
          roleId: "${roleId}"
          secretRef:
            name: orion-vault-approle
            namespace: external-secrets
            key: secretId
`
}
