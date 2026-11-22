/**
 * In-cluster ArgoCD for a bootstrapped environment: install it, and register the
 * environment's read-only git credential.
 *
 * The in-cluster gateway used to do this with cluster-admin. It is read-only now
 * (infra-manager design §5.1), so ORION does it with the environment's admin
 * kubeconfig. Nothing here is fatal: a failure is reported, the rest of the
 * bootstrap continues, and re-running bootstrap retries it.
 */
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { prisma } from '../db'
import { getGitProviderConfig } from '../git-provider'
import { providerKnownHosts } from '../git-provider/known-hosts'
import { bundledGiteaSshEnabled, getGatewayGitCredential, type GatewayGitCredential } from '../environment-git-credentials'
import { runCapture, runCommand, runQuiet } from './shell'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

type Emit = (event: BootstrapEvent) => void
type Kenv = Record<string, string>
type GitEnv = Pick<BootstrapEnvironment, 'id' | 'name' | 'gitOwner' | 'gitRepo'>

const NAMESPACE = 'argocd'
const REPO_SECRET = 'orion-git-repo'
/** On the namespace while ORION's own install is unfinished, so a re-run resumes it. */
const INSTALL_LABEL = 'orion/argocd-install'

/** On the Secret ORION itself writes, so only those are kept up to date. */
const REGISTERED_LABEL = 'orion/registered-by'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Same default as the gateway's installer; set ARGOCD_VERSION (e.g. "v2.14.11") to pin it. */
function argocdInstallUrl(): string {
  return `https://raw.githubusercontent.com/argoproj/argo-cd/${process.env.ARGOCD_VERSION || 'stable'}/manifests/install.yaml`
}

/**
 * The namespace of the cluster's ArgoCD, however installed (the upstream manifests
 * and the Helm chart both set this label), or null when there is none. Throws when
 * that can't be told: not knowing is not the same as absent.
 */
export async function findArgoCD(kenv: Kenv): Promise<string | null> {
  const r = await runCapture('kubectl', ['get', 'deployments', '-A', '-l', 'app.kubernetes.io/part-of=argocd', '-o', 'jsonpath={range .items[*]}{.metadata.namespace}{"\\n"}{end}'], kenv)
  if (!r.ok) throw new Error(`could not look for ArgoCD: ${r.stderr}`)
  const found = [...new Set(r.stdout.split('\n').map(l => l.trim()).filter(Boolean))]
  if (found.length > 1 && !found.includes(NAMESPACE)) throw new Error(`more than one ArgoCD (${found.join(', ')}), none in ${NAMESPACE}`)
  return found.includes(NAMESPACE) ? NAMESPACE : found[0] ?? null
}

/**
 * Is what's in `argocd` ORION's own interrupted install? Not once its server is
 * available and it has a controller (a slow start, finished since), nor when Helm put it there after ORION's attempt
 * failed: applying over either would upgrade or take over someone's ArgoCD.
 */
async function isUnfinishedInstall(kenv: Kenv): Promise<boolean> {
  const r = await runCapture('kubectl', ['get', 'deployments,statefulsets', '-n', NAMESPACE, '-l', 'app.kubernetes.io/part-of=argocd', '-o', 'json'], kenv)
  if (!r.ok) throw new Error(`could not read ArgoCD's workloads: ${r.stderr}`)
  type Workload = { metadata: { name: string; labels?: Record<string, string> }; status?: { availableReplicas?: number } }
  const items = (JSON.parse(r.stdout) as { items: Workload[] }).items
  const helm = items.some(d => d.metadata.labels?.['app.kubernetes.io/managed-by'] === 'Helm' || d.metadata.labels?.['helm.sh/chart'])
  const serving = items.some(d => d.metadata.name.endsWith('argocd-server') && (d.status?.availableReplicas ?? 0) > 0)
  // A StatefulSet, or a Deployment in some setups; without it ArgoCD syncs nothing.
  const controller = items.some(d => d.metadata.name.endsWith('application-controller'))
  return !helm && !(serving && controller)
}

/** Install ArgoCD unless the cluster has one. Returns its namespace, or null. */
export async function ensureInClusterArgoCD(kenv: Kenv, emit: Emit): Promise<string | null> {
  emit({ type: 'step', message: 'Installing ArgoCD...' })
  const log = (message: string) => emit({ type: 'log', message })
  try {
    const found = await findArgoCD(kenv)
    const label = await runCapture('kubectl', ['get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', `jsonpath={.metadata.labels.${INSTALL_LABEL.replace('/', '\\/')}}`], kenv)
    if (!label.ok) throw new Error(`could not read the ${NAMESPACE} namespace: ${label.stderr}`)
    if (found && !(found === NAMESPACE && label.stdout === 'incomplete' && await isUnfinishedInstall(kenv))) {
      log(`ArgoCD already installed (namespace ${found}) — skipping`)
      if (found === NAMESPACE && label.stdout === 'incomplete') await runCommand('kubectl', ['label', 'namespace', NAMESPACE, `${INSTALL_LABEL}=complete`, '--overwrite'], kenv, log)
      return found
    }

    const ns = await runQuiet('kubectl', ['create', 'namespace', NAMESPACE], kenv)
    if (!ns.ok && !/AlreadyExists|already exists/.test(ns.out)) throw new Error(ns.out)
    await runCommand('kubectl', ['label', 'namespace', NAMESPACE, `${INSTALL_LABEL}=incomplete`, '--overwrite'], kenv, log)
    // Server-side: ArgoCD's CRDs are too large for client-side apply's annotation.
    await runCommand('kubectl', ['apply', '--server-side', '--force-conflicts', '-n', NAMESPACE, '-f', argocdInstallUrl()], kenv, log)
    await runCommand('kubectl', ['wait', '--for=condition=available', 'deployment/argocd-server', '-n', NAMESPACE, '--timeout=300s'], kenv, log)
    await runCommand('kubectl', ['label', 'namespace', NAMESPACE, `${INSTALL_LABEL}=complete`, '--overwrite'], kenv, log)
    return NAMESPACE
  } catch (err) {
    log(`ArgoCD install failed (continuing; re-run bootstrap to retry): ${errText(err)}`)
    return null
  }
}

/**
 * The ArgoCD `repo-creds` Secret the gateway used to write: same name, same URL
 * prefix rule (the repo without `.git`). JSON, so no value can break out of it.
 */
export function argocdRepoSecret(cred: GatewayGitCredential, namespace: string): string {
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: REPO_SECRET,
      namespace,
      labels: { 'argocd.argoproj.io/secret-type': 'repo-creds', [REGISTERED_LABEL]: 'orion' },
    },
    stringData: {
      type: 'git',
      url: cred.repoUrl.replace(/\.git$/, ''),
      ...(cred.kind === 'ssh-key' ? { sshPrivateKey: cred.secret } : { username: cred.username, password: cred.secret }),
    },
  })
}

/**
 * Merge host-key lines into ArgoCD's ssh_known_hosts text: a key replaces the one
 * for the same host and key type, every other line is kept in order. Unchanged
 * text is returned as is. (apps/gateway/src/argocd-bootstrap.ts has the same rule.)
 */
export function mergeKnownHosts(existing: string, add: string[]): string {
  if (add.length === 0) return existing
  const id = (line: string) => /^(\S+ \S+) \S/.exec(line.trim())?.[1] ?? null
  const replacing = new Set(add.map(id))
  const lines = existing.split('\n')
  const kept = lines.filter(l => { const k = l.trim().startsWith('#') ? null : id(l); return k === null || !replacing.has(k) || add.includes(l.trim()) })
  const missing = add.filter(a => !kept.some(l => l.trim() === a))
  if (missing.length === 0 && kept.length === lines.length) return existing
  const body = kept.join('\n').replace(/\n+$/, '')
  return `${body}${body ? '\n' : ''}${missing.join('\n')}\n`
}

async function pinKnownHosts(lines: string[], namespace: string, kenv: Kenv, tmpDir: string): Promise<void> {
  const cm = await runCapture('kubectl', ['get', 'configmap', 'argocd-ssh-known-hosts-cm', '-n', namespace, '-o', 'json'], kenv)
  if (!cm.ok) throw new Error(`could not read argocd-ssh-known-hosts-cm: ${cm.stderr}`)
  const current: string = JSON.parse(cm.stdout)?.data?.ssh_known_hosts ?? ''
  const merged = mergeKnownHosts(current, lines)
  if (merged === current) return
  const path = join(tmpDir, 'known-hosts.json')
  await writeFile(path, JSON.stringify({ data: { ssh_known_hosts: merged } }), { mode: 0o600 })
  const patched = await runQuiet('kubectl', ['patch', 'configmap', 'argocd-ssh-known-hosts-cm', '-n', namespace, '--type', 'merge', '--patch-file', path], kenv)
  if (!patched.ok) throw new Error(`could not pin the git host's SSH keys: ${patched.out}`)
}

/**
 * Replaced whole: applying over an older Secret would keep its other fields (an old
 * password beside a new SSH key). kubectl's output is never reported, since its
 * errors can quote the Secret.
 */
async function writeRepoSecret(cred: GatewayGitCredential, namespace: string, kenv: Kenv, tmpDir: string): Promise<void> {
  const path = join(tmpDir, 'argocd-repo.json')
  try {
    await writeFile(path, argocdRepoSecret(cred, namespace), { mode: 0o600 })
    const replaced = await runQuiet('kubectl', ['replace', '-f', path], kenv)
    if (replaced.ok) return
    const created = /NotFound|not found/.test(replaced.out) && await runQuiet('kubectl', ['create', '-f', path], kenv)
    if (!created || !created.ok) throw new Error(`kubectl could not write the ${namespace}/${REPO_SECRET} Secret`)
  } finally {
    await rm(path, { force: true })
  }
}

/**
 * Give the cluster's ArgoCD the environment's current git credential. Throws on
 * failure. A join or a token rotation can revoke the credential at any moment, so
 * the write is repeated until the credential it wrote is still the current one.
 */
async function writeArgoCDRepo(env: GitEnv, namespace: string, kenv: Kenv, tmpDir: string): Promise<GatewayGitCredential | null> {
  const config = await getGitProviderConfig()
  if (!config) return null
  const opts = { bundledGiteaSsh: config.type === 'gitea-bundled' && await bundledGiteaSshEnabled() }
  // Host keys before the credential: getGatewayGitCredential may revoke the one ArgoCD
  // is using, which must not happen when the new one can't be used.
  const knownHosts = await providerKnownHosts(config, opts)
  if (knownHosts.length) await pinKnownHosts(knownHosts, namespace, kenv, tmpDir)

  let cred = await getGatewayGitCredential(env, opts)
  for (let attempt = 0; attempt < 3; attempt++) {
    await writeRepoSecret(cred, namespace, kenv, tmpDir)
    const current = await getGatewayGitCredential(env, opts)
    if (current.secret === cred.secret && current.repoUrl === cred.repoUrl) return cred
    cred = current
  }
  throw new Error('the credential kept changing while it was being registered')
}

/** Bootstrap step: register the credential, reporting instead of throwing. */
export async function registerArgoCDRepo(env: GitEnv, namespace: string, kenv: Kenv, tmpDir: string, emit: Emit): Promise<void> {
  emit({ type: 'step', message: 'Registering the git repository with ArgoCD...' })
  const log = (message: string) => emit({ type: 'log', message })
  try {
    const cred = await writeArgoCDRepo(env, namespace, kenv, tmpDir)
    if (!cred) { log('Git provider not configured — skipping git registration'); return }
    if (cred.orgTokenFallback) log('Using the org-wide git token (fallback enabled) — not scoped to this repo')
    log(`Registered ${cred.repoUrl} with ArgoCD (${cred.kind})`)
  } catch (err) {
    log(`Git registration failed (continuing; re-run bootstrap to retry): ${errText(err)}`)
  }
}

/**
 * After the environment's git credential was revoked (a gateway joined, its token was
 * rotated): give ArgoCD the new one, since a read-only gateway can't. Only replaces a
 * registration ORION wrote, so a cluster whose ArgoCD has its own key, or whose gateway
 * wrote the Secret, is left alone.
 * Never throws; a failure is logged and re-running bootstrap repairs it.
 */
export async function refreshArgoCDRepo(environmentId: string): Promise<void> {
  let tmpDir: string | null = null
  try {
    const env = await prisma.environment.findUnique({ where: { id: environmentId } })
    if (!env?.kubeconfig || env.type !== 'cluster') return
    tmpDir = await mkdtemp(join(tmpdir(), 'orion-argocd-'))
    const kubeconfig = join(tmpDir, 'kubeconfig')
    await writeFile(kubeconfig, Buffer.from(env.kubeconfig, 'base64').toString('utf8'), { mode: 0o600 })
    const kenv = { KUBECONFIG: kubeconfig, KUBECTL_CACHE_DIR: join(tmpDir, 'kubectl-cache') }

    const namespace = await findArgoCD(kenv)
    if (!namespace) return
    const existing = await runCapture('kubectl', ['get', 'secrets', '-n', namespace, '-l', `${REGISTERED_LABEL}=orion`, '-o', 'name'], kenv)
    if (!existing.ok) throw new Error(existing.stderr)
    if (!existing.stdout) return
    const cred = await writeArgoCDRepo(env, namespace, kenv, tmpDir)
    if (!cred) throw new Error('git provider not configured')
    console.log(`[argocd-repo] re-registered the git credential of "${env.name}" with its ArgoCD`)
  } catch (err) {
    console.error(`[argocd-repo] could not re-register the git credential of environment ${environmentId}; ArgoCD can't sync until bootstrap is re-run: ${errText(err)}`)
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
