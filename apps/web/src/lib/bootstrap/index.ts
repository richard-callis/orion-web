/**
 * Cluster / host bootstrap, dispatched by environment type:
 *   cluster (K8s/Talos) → k8s.ts   (ArgoCD, gateway, monitoring, Vault + ESO)
 *   docker  (one host)  → docker.ts (git repo, compose over SSH)
 *   swarm               → swarm.ts  (git repo, swarm init/join, stack deploy)
 */
import { prisma } from '../db'
import { bootstrapK8sCluster } from './k8s'
import { bootstrapDockerEnvironment } from './docker'
import { bootstrapSwarmEnvironment } from './swarm'
import type { BootstrapEvent } from './types'

export type { BootstrapEvent } from './types'
export { deployMonitoringStack } from './monitoring'

// Module-level in-flight set: prevents concurrent bootstraps for the same environment
const bootstrapInFlight = new Set<string>()

export async function bootstrapCluster(
  environmentId: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  // MAJOR fix: no concurrency guard — concurrent POST /bootstrap calls for the same
  // environment raced on gateway creation, ArgoCD app setup, and Vault AppRole minting,
  // potentially producing duplicate infra. Use a module-level set as a lightweight lock.
  if (bootstrapInFlight.has(environmentId)) {
    emit({ type: 'error', message: 'Bootstrap already in progress for this environment' })
    throw new Error('Bootstrap already in progress')
  }
  bootstrapInFlight.add(environmentId)

  const env = await prisma.environment.findUnique({ where: { id: environmentId } })
  if (!env) { bootstrapInFlight.delete(environmentId); throw new Error('Environment not found') }
  console.log(`[bootstrap] Starting for environment ${environmentId} (${env.name}, type: ${env.type})`)

  try {
    const envType = env.type ?? 'cluster'

    if (envType === 'docker') {
      return await bootstrapDockerEnvironment(env, emit)
    } else if (envType === 'swarm') {
      return await bootstrapSwarmEnvironment(env, emit)
    } else {
      // Default: K8s/Talos (requires kubeconfig)
      if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')
      return await bootstrapK8sCluster(env, emit)
    }
  } catch (err) {
    console.error(`[bootstrap] Failed: ${err instanceof Error ? err.message : String(err)}`)
    emit({ type: 'error', message: `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}` })
    throw err
  }
}
