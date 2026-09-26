/**
 * M2: ArgoCD repository Secret for the credential ORION issues.
 */
import { describe, it, expect } from 'vitest'
import { buildRepoSecretYaml, type GitProviderInfo } from './argocd-bootstrap.js'

const base: GitProviderInfo = { type: 'gitea-bundled', url: '', token: '', org: 'orion' }

describe('buildRepoSecretYaml', () => {
  it('registers a scoped https credential as a repo-creds template for that repo only', () => {
    const { yaml, repoUrl } = buildRepoSecretYaml({
      ...base,
      url: 'http://10.0.0.5:3002/orion/prod.git',
      credential: { kind: 'https-token', repoUrl: 'http://10.0.0.5:3002/orion/prod.git', username: 'orion-env-prod-abc123', password: 'SCOPED' },
    })
    expect(repoUrl).toBe('http://10.0.0.5:3002/orion/prod.git')
    expect(yaml).toContain('name: orion-git-repo')
    expect(yaml).toContain('argocd.argoproj.io/secret-type: repo-creds')
    expect(yaml).toContain('url: "http://10.0.0.5:3002/orion/prod"')
    expect(yaml).toContain('username: "orion-env-prod-abc123"')
    expect(yaml).toContain('password: "SCOPED"')
    expect(yaml).not.toContain('sshPrivateKey')
  })

  it('registers an ssh deploy key with the private key escaped onto one line', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n'
    const { yaml } = buildRepoSecretYaml({
      ...base,
      type: 'github',
      credential: { kind: 'ssh-key', repoUrl: 'git@github.com:acme/prod.git', username: 'git', sshPrivateKey: key },
    })
    expect(yaml).toContain('url: "git@github.com:acme/prod"')
    expect(yaml).toContain(`sshPrivateKey: ${JSON.stringify(key)}`)
    expect(yaml).not.toContain('password:')
    expect(yaml.split('\n')).toHaveLength(11)
  })

  it('keeps the legacy repo-creds Secret for older ORION responses', () => {
    const { yaml, repoUrl } = buildRepoSecretYaml({ ...base, type: 'github', url: 'https://github.com', token: 'ORG-PAT' })
    expect(repoUrl).toBe('https://github.com')
    expect(yaml).toContain('argocd.argoproj.io/secret-type: repo-creds')
    expect(yaml).toContain('username: "x-access-token"')
  })

  it('cannot be used to inject extra YAML fields', () => {
    const { yaml } = buildRepoSecretYaml({
      ...base,
      credential: { kind: 'https-token', repoUrl: 'http://x/r.git', username: 'u', password: 'p"\n  insecure: "true' },
    })
    expect(yaml).not.toMatch(/^\s*insecure:/m)
  })
})
