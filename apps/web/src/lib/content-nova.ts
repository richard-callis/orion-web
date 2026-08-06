/**
 * Content Nova installer.
 *
 * A content-type Nova doesn't deploy a service — it delivers files. The
 * install step below emits the same three manifests that make up the
 * delivery mechanism, wherever it's been hand-built for a given app (see
 * deployments/apps/technical-training/{content-pvc,content-sync-cronjob}.yaml
 * in the talos-cluster repo for the reference implementation this mirrors):
 *
 *   1. A PVC the target Deployment mounts read-only at contentTarget.mountPath
 *   2. A CronJob that periodically shallow-clones contentSource.gitUrl and
 *      copies contentSource.path into that PVC — no image rebuild needed to
 *      pick up a content change, just a merge to the source repo
 *   3. The target Deployment's manifest, with a volume + volumeMount added
 *      for the PVC (parsed and re-serialized with the `yaml` package rather
 *      than text-patched, so it's correct regardless of the file's current
 *      formatting)
 *
 * Convention: manifests live at `${repoPath}/apps/${deployment}/*.yaml` in
 * the environment's GitOps repo — matches every existing app under
 * deployments/apps/ in talos-cluster. A future environment with a different
 * layout would need this convention made configurable; not needed yet.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getGitProvider } from './git-provider'
import type { ManifestChange } from './gitops'
import type { Nova } from './nebula'

export interface ContentNovaTargetEnv {
  gitOwner: string
  gitRepo: string
  gitBranch?: string
  /** ArgoCD-watched sub-directory, e.g. "deployments". Defaults to "deployments". */
  repoPath?: string
}

function appDir(env: ContentNovaTargetEnv, deployment: string): string {
  return `${env.repoPath ?? 'deployments'}/apps/${deployment}`
}

function pvcManifest(pvcName: string, namespace: string, pvcSizeGi: number): string {
  return stringifyYaml({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName, namespace },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'longhorn',
      resources: { requests: { storage: `${pvcSizeGi}Gi` } },
    },
  })
}

function cronJobManifest(
  cronJobName: string,
  namespace: string,
  pvcName: string,
  source: NonNullable<Nova['config']['contentSource']>,
): string {
  const syncScript = [
    'set -e',
    'rm -rf /tmp/repo',
    `git clone --depth=1 --filter=blob:none --sparse --branch ${source.branch} ${source.gitUrl} /tmp/repo`,
    'cd /tmp/repo',
    `git sparse-checkout set ${source.path}`,
    'rm -rf /content/*',
    `cp -r ${source.path}/. /content/`,
    'echo "content synced: $(find /content -type f | wc -l) files"',
  ].join('\n')

  return stringifyYaml({
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name: cronJobName, namespace },
    spec: {
      schedule: '*/15 * * * *',
      concurrencyPolicy: 'Forbid',
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 3,
      jobTemplate: {
        spec: {
          backoffLimit: 2,
          template: {
            spec: {
              restartPolicy: 'OnFailure',
              containers: [
                {
                  name: 'sync',
                  image: 'alpine/git:latest',
                  command: ['sh', '-c'],
                  args: [syncScript],
                  volumeMounts: [{ name: 'content', mountPath: '/content' }],
                },
              ],
              volumes: [
                { name: 'content', persistentVolumeClaim: { claimName: pvcName } },
              ],
            },
          },
        },
      },
    },
  })
}

/** Splices a content volume + volumeMount into an existing Deployment's first container. */
function patchDeploymentYaml(currentYaml: string, pvcName: string, mountPath: string): string {
  const doc = parseYaml(currentYaml) as {
    spec: { template: { spec: { containers: Array<{ volumeMounts?: unknown[] }>; volumes?: unknown[] } } }
  }
  const podSpec = doc.spec.template.spec
  const container = podSpec.containers[0]

  const volumes = (podSpec.volumes ?? []).filter(
    (v): v is { name: string } => typeof v === 'object' && v !== null && 'name' in v && (v as { name: string }).name !== 'content',
  )
  volumes.push({ name: 'content', persistentVolumeClaim: { claimName: pvcName } } as unknown as { name: string })
  podSpec.volumes = volumes

  const volumeMounts = (container.volumeMounts ?? []).filter(
    (m): m is { name: string } => typeof m === 'object' && m !== null && 'name' in m && (m as { name: string }).name !== 'content',
  )
  volumeMounts.push({ name: 'content', mountPath, readOnly: true } as unknown as { name: string })
  container.volumeMounts = volumeMounts

  return stringifyYaml(doc)
}

/**
 * Builds the ManifestChange[] to pass to proposeChange() for installing a
 * content-type Nova into a target environment. Reads the target Deployment's
 * current manifest first so the volume/volumeMount splice is correct
 * regardless of what else is already in that file.
 */
export async function buildContentManifests(nova: Nova, env: ContentNovaTargetEnv): Promise<ManifestChange[]> {
  const config = nova.config
  if (config.type !== 'content' || !config.contentSource || !config.contentTarget) {
    throw new Error(`Nova "${nova.name}" is not a valid content Nova (missing contentSource/contentTarget)`)
  }

  const { deployment, namespace, mountPath, pvcSizeGi } = config.contentTarget
  const pvcName = `${deployment}-content`
  const cronJobName = `${deployment}-content-sync`
  const dir = appDir(env, deployment)

  const provider = await getGitProvider()
  const currentDeploymentYaml = await provider.readFile(
    env.gitOwner,
    env.gitRepo,
    `${dir}/deployment.yaml`,
    env.gitBranch ?? 'main',
  )

  return [
    { path: `${dir}/content-pvc.yaml`, content: pvcManifest(pvcName, namespace, pvcSizeGi) },
    { path: `${dir}/content-sync-cronjob.yaml`, content: cronJobManifest(cronJobName, namespace, pvcName, config.contentSource) },
    { path: `${dir}/deployment.yaml`, content: patchDeploymentYaml(currentDeploymentYaml, pvcName, mountPath) },
  ]
}
