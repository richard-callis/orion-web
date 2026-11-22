import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const m = vi.hoisted(() => ({
  runQuiet: vi.fn(), runCommand: vi.fn(), runCapture: vi.fn(), envFind: vi.fn(),
  config: vi.fn(), knownHosts: vi.fn(), credential: vi.fn(), sshOn: vi.fn(),
}))
vi.mock('./shell', () => ({ runQuiet: m.runQuiet, runCommand: m.runCommand, runCapture: m.runCapture }))
vi.mock('../db', () => ({ prisma: { environment: { findUnique: m.envFind } } }))
vi.mock('../git-provider', () => ({ getGitProviderConfig: m.config }))
vi.mock('../git-provider/known-hosts', () => ({ providerKnownHosts: m.knownHosts }))
vi.mock('../environment-git-credentials', () => ({ bundledGiteaSshEnabled: m.sshOn, getGatewayGitCredential: m.credential }))

import { argocdRepoSecret, ensureInClusterArgoCD, findArgoCD, mergeKnownHosts, refreshArgoCDRepo, registerArgoCDRepo } from './argocd-install'

const K = { KUBECONFIG: '/tmp/k' }
const HOST = '[10.0.0.5]:2222'
const ENV = { id: 'env-1', name: 'lab', gitOwner: 'orion', gitRepo: 'lab' }
const SSH = { kind: 'ssh-key', username: 'git', secret: 'PRIVATE-KEY', repoUrl: 'ssh://git@10.0.0.5:2222/orion/lab.git', orgTokenFallback: false } as const
const HTTPS = { kind: 'https-token', username: 'bot', secret: 'TOKEN', repoUrl: 'https://g/o/r.git', orgTokenFallback: false } as const
const SERVING = { metadata: { name: 'argocd-server' }, status: { availableReplicas: 1 } }
const events: string[] = []
const emit = (e: { message: string }) => { events.push(e.message) }
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' })

/** The fake cluster. `argocd`: namespaces with ArgoCD Deployments; `label`: the install label. */
function cluster(c: { deployments?: unknown[]; argocd?: string[]; label?: string; secret?: boolean; configMap?: boolean; written?: (verb: string, text: string, mode: number) => { ok: boolean; out: string } }) {
  m.runCapture.mockImplementation(async (_c: string, a: string[]) => {
    if (a[1] === 'deployments,statefulsets') return ok(JSON.stringify({ items: c.deployments ?? [] }))
    if (a[1] === 'deployments') return ok((c.argocd ?? []).join('\n'))
    if (a[1] === 'namespace') return ok(c.label ?? '')
    if (a[1] === 'secrets') return ok(c.secret && a.includes('orion/registered-by=orion') ? 'secret/orion-git-repo' : '')
    if (a[1] === 'configmap') return c.configMap === false ? { ok: false, stdout: '', stderr: 'boom' } : { ...ok(JSON.stringify({ data: { ssh_known_hosts: 'github.com ssh-ed25519 GH\n' } })), stderr: 'E1122 memcache.go: metrics.k8s.io unavailable' }
    throw new Error(`unexpected ${a.join(' ')}`)
  })
  m.runQuiet.mockImplementation(async (_c: string, a: string[]) => {
    if ((a[0] === 'replace' || (a[0] === 'create' && a[1] === '-f')) && c.written) {
      const path = a[a.length - 1]
      return c.written(a[0], await readFile(path, 'utf8'), (await stat(path)).mode & 0o777)
    }
    return { ok: true, out: '' }
  })
}

beforeEach(() => {
  events.length = 0
  for (const f of Object.values(m)) f.mockReset()
  m.runCommand.mockResolvedValue(undefined)
  m.config.mockResolvedValue({ type: 'gitea-bundled' })
  m.sshOn.mockResolvedValue(true)
  m.knownHosts.mockResolvedValue([`${HOST} ssh-ed25519 KEY`])
  m.credential.mockResolvedValue(SSH)
})

describe('findArgoCD', () => {
  it.each([[[], null], [['argocd', 'argocd'], 'argocd'], [['gitops'], 'gitops'], [['gitops', 'argocd'], 'argocd']])('%j → %s', async (argocd, expected) => {
    cluster({ argocd })
    expect(await findArgoCD(K)).toBe(expected)
  })
  it('throws when it cannot tell', async () => {
    m.runCapture.mockResolvedValue({ ok: false, stdout: '', stderr: 'connection refused' })
    await expect(findArgoCD(K)).rejects.toThrow('connection refused')
    cluster({ argocd: ['a', 'b'] })
    await expect(findArgoCD(K)).rejects.toThrow('more than one')
  })
})

describe('ensureInClusterArgoCD', () => {
  const verbs = () => m.runCommand.mock.calls.map(c => c[1].slice(0, 2).join(' '))

  it('leaves an existing ArgoCD alone, in any namespace', async () => {
    cluster({ argocd: ['gitops'] })
    expect(await ensureInClusterArgoCD(K, emit)).toBe('gitops')
    cluster({ argocd: ['argocd'], label: 'complete' })
    expect(await ensureInClusterArgoCD(K, emit)).toBe('argocd')
    expect(m.runCommand).not.toHaveBeenCalled()
  })
  it('never installs when it cannot tell whether ArgoCD exists', async () => {
    m.runCapture.mockResolvedValue({ ok: false, stdout: '', stderr: 'connection refused' })
    expect(await ensureInClusterArgoCD(K, emit)).toBeNull()
    expect(m.runCommand).not.toHaveBeenCalled()
  })
  it('marks its install incomplete until it has finished', async () => {
    cluster({})
    expect(await ensureInClusterArgoCD(K, emit)).toBe('argocd')
    expect(verbs()).toEqual(['label namespace', 'apply --server-side', 'wait --for=condition=available', 'label namespace'])
    expect(m.runCommand.mock.calls[0][1]).toContain('orion/argocd-install=incomplete')
    expect(m.runCommand.mock.calls[3][1]).toContain('orion/argocd-install=complete')
  })
  it('resumes its own unfinished install, even with some Deployments there', async () => {
    cluster({ argocd: ['argocd'], label: 'incomplete' })
    expect(await ensureInClusterArgoCD(K, emit)).toBe('argocd')
    expect(verbs()).toContain('apply --server-side')
  })
  it.each([
    ['Helm installed it since', [{ metadata: { name: 'argocd-server', labels: { 'app.kubernetes.io/managed-by': 'Helm' } } }]],
    ['it came up after the wait timed out', [SERVING, { metadata: { name: 'argocd-application-controller' } }]],
  ])('does not resume when %s', async (_n, deployments) => {
    cluster({ argocd: ['argocd'], label: 'incomplete', deployments })
    expect(await ensureInClusterArgoCD(K, emit)).toBe('argocd')
    expect(verbs()).toEqual(['label namespace'])
    expect(m.runCommand.mock.calls[0][1]).toContain('orion/argocd-install=complete')
  })
  it('resumes when the server is up but the controller is missing', async () => {
    cluster({ argocd: ['argocd'], label: 'incomplete', deployments: [SERVING] })
    expect(await ensureInClusterArgoCD(K, emit)).toBe('argocd')
    expect(verbs()).toContain('apply --server-side')
  })
  it('reports a failed install without throwing', async () => {
    cluster({})
    m.runCommand.mockRejectedValue(new Error('no route to host'))
    expect(await ensureInClusterArgoCD(K, emit)).toBeNull()
    expect(events.join('\n')).toContain('no route to host')
  })
})

describe('argocdRepoSecret', () => {
  it('carries only the fields of its kind, for the repo prefix', () => {
    expect(JSON.parse(argocdRepoSecret(SSH, 'argocd')).stringData).toEqual({ type: 'git', url: 'ssh://git@10.0.0.5:2222/orion/lab', sshPrivateKey: 'PRIVATE-KEY' })
    expect(JSON.parse(argocdRepoSecret(HTTPS, 'gitops'))).toMatchObject({ metadata: { namespace: 'gitops', labels: { 'orion/registered-by': 'orion' } }, stringData: { type: 'git', url: 'https://g/o/r', username: 'bot', password: 'TOKEN' } })
    expect(JSON.parse(argocdRepoSecret(HTTPS, 'gitops')).stringData).not.toHaveProperty('sshPrivateKey')
  })
})

describe('mergeKnownHosts', () => {
  it('replaces a rotated key, keeps everything else, and is idempotent', () => {
    const before = `# comment\ngithub.com ssh-ed25519 GH\n${HOST} ssh-ed25519 OLD note\n`
    const after = mergeKnownHosts(before, [`${HOST} ssh-ed25519 NEW`])
    expect(after).toBe(`# comment\ngithub.com ssh-ed25519 GH\n${HOST} ssh-ed25519 NEW\n`)
    expect(mergeKnownHosts(after, [`${HOST} ssh-ed25519 NEW`])).toBe(after)
    expect(mergeKnownHosts('', [`${HOST} ssh-ed25519 NEW`])).toBe(`${HOST} ssh-ed25519 NEW\n`)
    expect(mergeKnownHosts(before, [])).toBe(before)
  })
})

describe('registerArgoCDRepo', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argocd-test-'))
    return () => rm(dir, { recursive: true, force: true })
  })
  const register = (ns = 'argocd') => registerArgoCDRepo(ENV, ns, K, dir, emit)

  it('pins the host keys, mints, then writes the Secret 0600 and removes the file', async () => {
    const order: string[] = []
    let mode = 0
    cluster({ written: (verb, text, md) => { order.push(`${verb} ${JSON.parse(text).metadata.namespace}`); mode = md; return { ok: true, out: '' } } })
    m.credential.mockImplementation(async () => { order.push('mint'); return SSH })
    const quiet = m.runQuiet.getMockImplementation()!
    m.runQuiet.mockImplementation(async (c: string, a: string[], e: unknown) => { if (a[0] === 'patch') order.push('pin'); return quiet(c, a, e) })
    await register('gitops')
    expect(order).toEqual(['pin', 'mint', 'replace gitops', 'mint'])
    expect(mode).toBe(0o600)
    expect(await readdir(dir)).not.toContain('argocd-repo.json')
    expect(events.join('\n')).toContain('Registered ssh://')
    expect(events.join('\n')).not.toContain('PRIVATE-KEY')
  })
  it('creates the Secret when there is none', async () => {
    const verbs: string[] = []
    cluster({ written: verb => { verbs.push(verb); return verb === 'replace' ? { ok: false, out: 'Error from server (NotFound): secrets "orion-git-repo" not found' } : { ok: true, out: '' } } })
    await register()
    expect(verbs).toEqual(['replace', 'create'])
  })
  it("never creates after another failure, nor logs kubectl's output about the Secret", async () => {
    const verbs: string[] = []
    cluster({ written: (verb, text) => { verbs.push(verb); return { ok: false, out: `invalid object: ${text}` } } })
    await register()
    expect(verbs).toEqual(['replace'])
    expect(events.join('\n')).toContain('could not write the argocd/orion-git-repo Secret')
    expect(events.join('\n')).not.toContain('PRIVATE-KEY')
    expect(await readdir(dir)).not.toContain('argocd-repo.json')
  })
  it('writes again when a join replaced the credential meanwhile', async () => {
    const secrets: string[] = []
    cluster({ written: (_v, text) => { secrets.push(JSON.parse(text).stringData.sshPrivateKey); return { ok: true, out: '' } } })
    m.credential.mockResolvedValueOnce(SSH).mockResolvedValue({ ...SSH, secret: 'NEW-KEY' })
    await register()
    expect(secrets).toEqual(['PRIVATE-KEY', 'NEW-KEY'])
  })
  it('does not touch the credential when the host keys cannot be read or pinned', async () => {
    cluster({})
    m.knownHosts.mockRejectedValueOnce(new Error('ssh-keyscan failed'))
    await register()
    cluster({ configMap: false })
    await register()
    expect(m.credential).not.toHaveBeenCalled()
  })
  it('handles HTTPS and the org-token fallback', async () => {
    cluster({ written: () => ({ ok: true, out: '' }) })
    m.knownHosts.mockResolvedValue([])
    m.credential.mockResolvedValue({ ...HTTPS, orgTokenFallback: true })
    await register()
    expect(events.join('\n')).toContain('not scoped to this repo')
    expect(m.runCapture).not.toHaveBeenCalled() // no ConfigMap
  })
  it('skips without a git provider', async () => {
    cluster({})
    m.config.mockResolvedValue(null)
    await register()
    expect(m.credential).not.toHaveBeenCalled()
  })
})

describe('refreshArgoCDRepo', () => {
  const row = { ...ENV, type: 'cluster', kubeconfig: Buffer.from('kc').toString('base64') }
  let writes: number
  const run = async (c: Parameters<typeof cluster>[0], env: unknown = row) => {
    writes = 0
    cluster({ ...c, written: () => { writes++; return { ok: true, out: '' } } })
    m.envFind.mockResolvedValue(env)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await refreshArgoCDRepo('env-1')
    return error
  }

  it('rewrites an existing registration', async () => {
    await run({ argocd: ['argocd'], secret: true })
    expect(writes).toBe(1)
  })
  it('leaves a cluster alone that ORION never registered, or has no ArgoCD or kubeconfig', async () => {
    for (const [c, env] of [[{ argocd: ['argocd'] }, row], [{}, row], [{ argocd: ['argocd'], secret: true }, { ...row, kubeconfig: null }], [{ argocd: ['argocd'], secret: true }, { ...row, type: 'docker' }], [{}, null]] as const) {
      await run({ ...c, argocd: 'argocd' in c ? [...c.argocd] : [] }, env)
      expect(writes).toBe(0)
      expect(m.credential).not.toHaveBeenCalled()
    }
  })
  it('reports a missing git provider as a failure, not a success', async () => {
    m.config.mockResolvedValue(null)
    const error = await run({ argocd: ['argocd'], secret: true })
    expect(error.mock.calls[0][0]).toContain('git provider not configured')
  })
  it('never throws, and removes the kubeconfig it wrote', async () => {
    const before = (await readdir(tmpdir())).filter(f => f.startsWith('orion-argocd-'))
    m.credential.mockRejectedValue(new Error('gitea down'))
    const error = await run({ argocd: ['argocd'], secret: true })
    expect(error.mock.calls[0][0]).toContain('gitea down')
    expect((await readdir(tmpdir())).filter(f => f.startsWith('orion-argocd-'))).toEqual(before)
  })
})
