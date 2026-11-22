import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomBytes } from 'crypto'
import { prisma } from '../db'
import { isPrivateUrl } from '../ssrf-guard'
import { ensureInClusterArgoCD, registerArgoCDRepo } from './argocd-install'
import { argocdLogin, argocdRegisterCluster, argocdConfigureApp, extractKubeconfigServer } from './argocd'
import { ensureGitRepo } from './git-repo'
import { deployBootstrapMonitoring } from './monitoring'
import { runCapture, runCommand, runQuiet } from './shell'
import { gatewayManifest } from './templates'
import { bootstrapK8sVaultAndEso } from './vault-eso'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

const OLD_BINDING = 'orion-gateway-admin'
const IN_CLUSTER_GATEWAY_URL = 'http://orion-gateway.orion-management.svc.cluster.local:3001'

/**
 * The ClusterRoleBindings that make this gateway's ServiceAccount cluster-admin, and
 * whether each binds nothing else. Throws when that can't be told, so "couldn't
 * check" is never taken for "read-only".
 */
async function clusterAdminBindings(kenv: Record<string, string>): Promise<Array<{ name: string; only: boolean }>> {
  const r = await runCapture('kubectl', ['get', 'clusterrolebindings', '-o', 'json'], kenv)
  if (!r.ok) throw new Error(`Could not check the gateway's permissions: ${r.stderr}`)
  type Subject = { kind: string; name: string; namespace?: string }
  const items = (JSON.parse(r.stdout) as { items: Array<{ metadata: { name: string }; roleRef: { kind: string; name: string }; subjects?: Subject[] }> }).items
  const ours = (s: Subject) =>
    (s.kind === 'ServiceAccount' && s.namespace === 'orion-management' && s.name === 'orion-gateway') ||
    (s.kind === 'User' && s.name === 'system:serviceaccount:orion-management:orion-gateway') ||
    (s.kind === 'Group' && ['system:serviceaccounts', 'system:serviceaccounts:orion-management', 'system:authenticated'].includes(s.name))
  return items
    .filter(i => i.roleRef.kind === 'ClusterRole' && i.roleRef.name === 'cluster-admin' && (i.subjects ?? []).some(ours))
    .map(i => ({ name: i.metadata.name, only: (i.subjects ?? []).length === 1 }))
}

const isForeign = (b: { name: string; only: boolean }) => b.name !== OLD_BINDING || !b.only
const names = (bindings: Array<{ name: string }>) => bindings.map(b => b.name).join(', ')

/**
 * Before this change bootstrap bound the gateway to cluster-admin. Remove that binding;
 * any other one is someone else's, and deploying would silently inherit it, so stop.
 */
async function dropClusterAdmin(kenv: Record<string, string>, log: (m: string) => void): Promise<void> {
  const bindings = await clusterAdminBindings(kenv)
  const foreign = bindings.filter(isForeign)
  if (foreign.length) {
    throw new Error(`The gateway's ServiceAccount (orion-management/orion-gateway) is bound to cluster-admin by ${names(foreign)}. Remove it from there and re-run bootstrap: the gateway must be read-only.`)
  }
  if (bindings.length) await runCommand('kubectl', ['delete', 'clusterrolebinding', OLD_BINDING], kenv, log)
}

/**
 * The URL this gateway tells ORION, or '' to leave ORION's as it is: the environment's own, else
 * the in-cluster Service when ORION runs in this cluster. The join refuses a URL the
 * SSRF guard blocks, which would leave the gateway unable to join at all.
 */
async function gatewayUrlFor(env: BootstrapEnvironment): Promise<string> {
  const url = env.gatewayUrl || IN_CLUSTER_GATEWAY_URL
  return (await isPrivateUrl(url)) ? '' : url
}

/** Bootstrap a K8s/Talos cluster environment (original flow). */
export async function bootstrapK8sCluster(
  env: BootstrapEnvironment,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')
  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const kubeconfigYaml = Buffer.from(env.kubeconfig, 'base64').toString('utf8')
  const kubeconfigPath = join(tmpDir, 'kubeconfig')
  await writeFile(kubeconfigPath, kubeconfigYaml, { mode: 0o600 })

  const kenv = { KUBECONFIG: kubeconfigPath, KUBECTL_CACHE_DIR: join(tmpDir, 'kubectl-cache') }
  const slug = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  try {
    // 1. Verify cluster connectivity
    emit({ type: 'step', message: 'Verifying cluster connectivity...' })
    await runCommand('kubectl', ['cluster-info'], kenv, msg => emit({ type: 'log', message: msg }))

    // 2. Ensure git repo
    const gitInfo = await ensureGitRepo(env, emit)
    if (!gitInfo) return

    // Stored now: the join re-registers the git credential from this record.
    await prisma.environment.update({ where: { id: env.id }, data: { gitOwner: gitInfo.owner, gitRepo: gitInfo.repo } })

    // 3. Register with local ArgoCD
    emit({ type: 'step', message: 'Registering with ArgoCD hub...' })
    const argocdToken = await argocdLogin()
    if (argocdToken) {
      const clusterServer = extractKubeconfigServer(kubeconfigYaml)
      if (clusterServer) {
        await argocdRegisterCluster(argocdToken, env.name, kubeconfigYaml)
        if (gitInfo.healthy && argocdToken) {
          await argocdConfigureApp(argocdToken, env.name, gitInfo.url, clusterServer)
        }
      } else {
        emit({ type: 'log', message: 'Could not determine cluster API server — ArgoCD registration skipped' })
      }
    } else {
      emit({ type: 'log', message: 'ArgoCD not configured — skipping (will retry on next bootstrap)' })
    }

    // 4. ArgoCD in the cluster. The gateway is read-only, so bootstrap installs it.
    const argocdNamespace = await ensureInClusterArgoCD(kenv, emit)

    // 4.1. Deploy Gateway
    emit({ type: 'step', message: 'Deploying ORION Gateway...' })
    const log = (message: string) => emit({ type: 'log', message })
    const gwCheck = await runCapture(
      'kubectl', ['get', 'deployment', 'orion-gateway', '-n', 'orion-management', '--ignore-not-found', '-o', 'name'],
      kenv,
    )
    if (!gwCheck.ok) throw new Error(`Could not check for an existing gateway: ${gwCheck.stderr}`)
    const gatewayUrl = await gatewayUrlFor(env)
    if (gwCheck.stdout) {
      log('Gateway already deployed — skipping')
      const redeploy = 'delete Deployment orion-management/orion-gateway and re-run bootstrap.'
      try {
        const bindings = await clusterAdminBindings(kenv)
        const foreign = bindings.filter(isForeign)
        if (foreign.length) log(`WARNING: this gateway is bound to cluster-admin by ${names(foreign)}. Remove it from there, then ${redeploy}`)
        else if (bindings.length) log(`WARNING: this gateway is still bound to cluster-admin (${OLD_BINDING}). To make it read-only, ${redeploy}`)
      } catch (err) {
        log(`WARNING: this gateway may be bound to cluster-admin. ${err instanceof Error ? err.message : err} Fix that and re-run bootstrap to find out.`)
      }
    } else {
      await dropClusterAdmin(kenv, log)
      // A fresh join: left over credentials would make the new pod skip it, keeping the
      // old gateway's token valid and this join token usable by anyone who reads it.
      await runCommand('kubectl', ['delete', 'secret', 'orion-gateway-credentials', '-n', 'orion-management', '--ignore-not-found'], kenv, log)
      await prisma.environmentJoinToken.deleteMany({ where: { environmentId: env.id, usedAt: null } })
      const token = `orion_${randomBytes(24).toString('hex')}`
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      await prisma.environmentJoinToken.create({
        // Only the hash, as generate-join stores it.
        data: { token: createHash('sha256').update(token).digest('hex'), environmentId: env.id, expiresAt },
      })
      await writeFile(join(tmpDir, 'gateway.yaml'), gatewayManifest(env.name, token, gatewayUrl), { mode: 0o600 })
      await runCommand('kubectl', ['apply', '-f', join(tmpDir, 'gateway.yaml')], kenv, log)
    }

    // 4.2. Give ArgoCD the repo credential. The gateway's join replaces it, and
    // re-registers it then (refreshArgoCDRepo), so this doesn't wait for the join.
    if (argocdNamespace) {
      await registerArgoCDRepo({ id: env.id, name: env.name, gitOwner: gitInfo.owner, gitRepo: gitInfo.repo }, argocdNamespace, kenv, tmpDir, emit)
    }

    // 4.5. Deploy monitoring stack (if configured)
    await deployBootstrapMonitoring(env, kenv, emit)

    // 5. Configure Vault + ESO
    await bootstrapK8sVaultAndEso(env, slug, kenv, tmpDir, emit)

    // 6. Resolve ArgoCD URL
    emit({ type: 'step', message: 'Resolving ArgoCD URL...' })
    let argoCdUrl: string | null = null
    const portResult = await runQuiet(
      'kubectl',
      ['get', 'svc', 'argocd-server', '-n', 'argocd',
       '-o', 'jsonpath={.spec.ports[?(@.name=="https")].nodePort}'],
      kenv,
    )
    const nodePort = portResult.out.trim()
    const nodeIpResult = await runQuiet(
      'kubectl',
      ['get', 'nodes', '-o', 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}'],
      kenv,
    )
    const nodeIp = nodeIpResult.out.trim()
    if (nodePort && nodeIp) {
      argoCdUrl = `https://${nodeIp}:${nodePort}`
      emit({ type: 'log', message: `ArgoCD available at ${argoCdUrl}` })
    }

    // 7. Update environment record
    await prisma.environment.update({
      where: { id: env.id },
      data: {
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
        argoCdUrl,
        status: 'connected',
      },
    })

    emit({
      type: 'done',
      message: env.gatewayUrl || gatewayUrl
        ? 'Bootstrap complete! Gateway will connect to ORION within ~30 seconds.'
        : "Bootstrap complete! The gateway will report to ORION within ~30 seconds, but ORION has no URL to call it at. Its Service is ClusterIP: give it a route (an ingress, say) and set that as the environment's gateway URL.",
    })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
