import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { argocdLogin, argocdRegisterCluster, argocdConfigureApp, extractKubeconfigServer } from './argocd'
import { ensureGitRepo } from './git-repo'
import { deployBootstrapMonitoring } from './monitoring'
import { runCommand, runQuiet } from './shell'
import { gatewayManifest } from './templates'
import { bootstrapK8sVaultAndEso } from './vault-eso'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

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

    // 3. Register with local ArgoCD
    emit({ type: 'step', message: 'Registering with local ArgoCD...' })
    const argocdToken = await argocdLogin()
    if (argocdToken) {
      const clusterServer = extractKubeconfigServer(kubeconfigYaml)
      if (clusterServer) {
        await argocdRegisterCluster(argocdToken, env.name)
        if (gitInfo.healthy && argocdToken) {
          await argocdConfigureApp(argocdToken, env.name, gitInfo.url, clusterServer)
        }
      } else {
        emit({ type: 'log', message: 'Could not determine cluster API server — ArgoCD registration skipped' })
      }
    } else {
      emit({ type: 'log', message: 'ArgoCD not configured — skipping (will retry on next bootstrap)' })
    }

    // 4. Deploy Gateway
    emit({ type: 'step', message: 'Deploying ORION Gateway...' })
    const gwCheck = await runQuiet(
      'kubectl', ['get', 'deployment', 'orion-gateway', '-n', 'orion-management', '--ignore-not-found'],
      kenv,
    )
    if (gwCheck.out.includes('orion-gateway')) {
      emit({ type: 'log', message: 'Gateway already deployed — skipping' })
    } else {
      const token = `orion_${randomBytes(24).toString('hex')}`
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      await prisma.environmentJoinToken.create({
        data: { token, environmentId: env.id, expiresAt },
      })
      await writeFile(join(tmpDir, 'gateway.yaml'), gatewayManifest(env.name, token))
      await runCommand(
        'kubectl', ['apply', '-f', join(tmpDir, 'gateway.yaml')],
        kenv, msg => emit({ type: 'log', message: msg }),
      )
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

    emit({ type: 'done', message: 'Bootstrap complete! Gateway will connect to ORION within ~30 seconds.' })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
