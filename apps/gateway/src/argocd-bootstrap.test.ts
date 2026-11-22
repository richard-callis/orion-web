/**
 * M2: ArgoCD repository Secret for the credential ORION issues.
 */
import { describe, it, expect } from 'vitest'
import { buildRepoSecretYaml, mergeKnownHosts, sshKnownHostsName, knownHostsForRepo, type GitProviderInfo } from './argocd-bootstrap.js'

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

describe('mergeKnownHosts', () => {
  const NEW = '[10.0.0.5]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINEW'
  const OLD = '[10.0.0.5]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLD'
  const GH = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

  it('appends a missing host key, keeping every existing line and comment', () => {
    expect(mergeKnownHosts(`# defaults\n${GH}\n`, [NEW])).toBe(`# defaults\n${GH}\n${NEW}\n`)
  })
  it('is a no-op when the key is already pinned', () => {
    const text = `${GH}\n${NEW}\n`
    expect(mergeKnownHosts(text, [NEW])).toBe(text)
  })
  it('replaces a rotated key for the same host and type', () => {
    expect(mergeKnownHosts(`${GH}\n${OLD}\n`, [NEW])).toBe(`${GH}\n${NEW}\n`)
  })
  it('ignores anything that is not a plain key line', () => {
    const text = `${GH}\n`
    expect(mergeKnownHosts(text, ['@cert-authority * ssh-ed25519 AAAA', 'x ssh-ed25519 AAAA\nevil y', ''])).toBe(text)
  })
  it('works on an empty ConfigMap', () => {
    expect(mergeKnownHosts('', [NEW])).toBe(`${NEW}\n`)
  })
})

describe('known hosts are limited to the credential repo host', () => {
  const GITEA = '[10.0.0.5]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINEW'
  const GH = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEVIL'

  it('names the host the way ssh looks it up', () => {
    expect(sshKnownHostsName('ssh://git@10.0.0.5:2222/o/r.git')).toBe('[10.0.0.5]:2222')
    expect(sshKnownHostsName('ssh://git@git.example.com/o/r.git')).toBe('git.example.com')
    expect(sshKnownHostsName('ssh://git@git.example.com:22/o/r.git')).toBe('git.example.com')
    expect(sshKnownHostsName('git@github.com:acme/prod.git')).toBe('github.com')
    expect(sshKnownHostsName('https://git.example.com/o/r.git')).toBeNull()
  })
  it('drops keys for any other host (ORION may not re-key github.com)', () => {
    expect(knownHostsForRepo('ssh://git@10.0.0.5:2222/o/r.git', [GITEA, GH])).toEqual([GITEA])
    expect(knownHostsForRepo('https://x/o/r.git', [GITEA])).toEqual([])
  })
  it('replaces a rotated key whose old line carries a comment, and ignores duplicate input', () => {
    const OLD = '[10.0.0.5]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLD pinned 2026'
    expect(mergeKnownHosts(`${OLD}\n`, [GITEA, GITEA])).toBe(`${GITEA}\n`)
  })
})
