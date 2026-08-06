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
 *      for the PVC
 *
 * Convention: manifests live at `${repoPath}/apps/${deployment}/*.yaml` in
 * the environment's GitOps repo — matches every existing app under
 * deployments/apps/ in talos-cluster. A future environment with a different
 * layout would need this convention made configurable; not needed yet.
 *
 * Both contentSource and contentTarget come from a Nova's config, which is
 * ultimately sourced from whatever git repo a Nebula points at — treat it as
 * untrusted input from an operator's point of view (a compromised or
 * careless Nebula source shouldn't be able to do anything beyond "sync some
 * files into a PVC"), hence the validation below.
 */

import { parseAllDocuments, isMap, isSeq, stringify as stringifyYaml, type Document } from 'yaml'
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

// ── Validation ──────────────────────────────────────────────────────────────
//
// contentSource values end up inside a shell script (as quoted env vars, not
// interpolated directly — see cronJobManifest) and contentTarget values end
// up inside file paths and Kubernetes name/namespace fields. Reject anything
// that doesn't look like the narrow shape we actually need, rather than
// trying to enumerate every way a stray value could cause trouble.

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const SAFE_GIT_REF = /^[\w./-]+$/

function validateContentSource(source: NonNullable<Nova['config']['contentSource']>): void {
  if (!/^https:\/\/[a-zA-Z0-9._-]+\/[\w.-]+\/[\w.-]+(\.git)?$/.test(source.gitUrl)) {
    throw new Error(`Invalid contentSource.gitUrl "${source.gitUrl}": must be an https:// URL like https://github.com/<owner>/<repo>.git`)
  }
  if (!SAFE_GIT_REF.test(source.branch) || source.branch.startsWith('-')) {
    throw new Error(`Invalid contentSource.branch "${source.branch}": unsafe characters`)
  }
  // Must be a relative path within the cloned repo — a leading '/' would
  // make the CronJob's `cp -r "$GIT_PATH"/. /content/` step read from the
  // sync pod's own filesystem instead of the checkout (e.g.
  // /var/run/secrets/kubernetes.io/serviceaccount), landing that pod's
  // ServiceAccount token in the PVC the target app serves as static
  // content. A leading '-' is rejected too, so the value can't be
  // misread as a flag by `cp`/`git sparse-checkout`.
  if (!SAFE_GIT_REF.test(source.path) || source.path.includes('..') || source.path.startsWith('/') || source.path.startsWith('-')) {
    throw new Error(`Invalid contentSource.path "${source.path}": must be a relative path within the repo, no leading "/" or "-", no ".."`)
  }
}

function validateContentTarget(target: NonNullable<Nova['config']['contentTarget']>): void {
  if (!DNS_LABEL.test(target.deployment) || target.deployment.length > 63) {
    throw new Error(`Invalid contentTarget.deployment "${target.deployment}": must be a valid DNS label (max 63 chars)`)
  }
  if (!DNS_LABEL.test(target.namespace) || target.namespace.length > 63) {
    throw new Error(`Invalid contentTarget.namespace "${target.namespace}": must be a valid DNS label (max 63 chars)`)
  }
  // A Kubernetes volumeMount.mountPath is an absolute path inside the
  // container's rootfs (it has nothing to do with the container's WORKDIR)
  // — a relative value here is either rejected by the CRI or silently
  // mounted somewhere the app never reads from.
  if (typeof target.mountPath !== 'string' || !target.mountPath.startsWith('/') || target.mountPath.includes('..') || target.mountPath.includes(':')) {
    throw new Error(`Invalid contentTarget.mountPath "${target.mountPath}": must be an absolute path (e.g. "/app/src/content"), no ".." or ":"`)
  }
  if (!Number.isInteger(target.pvcSizeGi) || target.pvcSizeGi <= 0 || target.pvcSizeGi > 1024) {
    throw new Error(`Invalid contentTarget.pvcSizeGi "${target.pvcSizeGi}": must be a positive integer (max 1024)`)
  }
}

function appDir(env: ContentNovaTargetEnv, deployment: string): string {
  return `${env.repoPath ?? 'deployments'}/apps/${deployment}`
}

function pvcManifest(pvcName: string, namespace: string, pvcSizeGi: number): string {
  // ReadWriteOnce, matching the hand-built reference implementation. Correct
  // for a single-replica app (technical-training's actual deployment): the
  // app pod and the CronJob's sync pod never hold the volume concurrently on
  // different nodes in that case. A multi-replica target would need RWX (or
  // the sync moved into a sidecar of the app pod itself) — not needed yet.
  return stringifyYaml(
    {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: pvcName, namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'longhorn',
        resources: { requests: { storage: `${pvcSizeGi}Gi` } },
      },
    },
    { lineWidth: 0 },
  )
}

function cronJobManifest(
  cronJobName: string,
  namespace: string,
  pvcName: string,
  source: NonNullable<Nova['config']['contentSource']>,
): string {
  // gitUrl/branch/path are passed as env vars and referenced quoted
  // ("$GIT_URL") rather than interpolated into the script string — the
  // values ultimately come from a Nova's config, which can originate from an
  // untrusted Nebula source repo, so they must never be able to break out of
  // a quoted context. validateContentSource() above is defense in depth on
  // top of this, not a substitute for it.
  const syncScript = [
    'set -e',
    'rm -rf /tmp/repo',
    'git clone --depth=1 --filter=blob:none --sparse --branch "$GIT_BRANCH" "$GIT_URL" /tmp/repo',
    'cd /tmp/repo',
    'git sparse-checkout set "$GIT_PATH"',
    'rm -rf /content/*',
    'cp -r "$GIT_PATH"/. /content/',
    'echo "content synced: $(find /content -type f | wc -l) files"',
  ].join('\n')

  // lineWidth: 0 disables stringify()'s default line-folding — without it,
  // the multi-line syncScript (and any long plain scalar) can get folded or
  // reformatted unpredictably; with it, syncScript comes out as a literal
  // block (`|-`) with every line intact.
  return stringifyYaml(
    {
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
                    env: [
                      { name: 'GIT_URL', value: source.gitUrl },
                      { name: 'GIT_BRANCH', value: source.branch },
                      { name: 'GIT_PATH', value: source.path },
                    ],
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
    },
    { lineWidth: 0 },
  )
}

/**
 * Splices a content volume + volumeMount into an existing Deployment's
 * manifest, matching the container by name (falling back to the first
 * container with a comment, since a service-mesh/logging sidecar could
 * otherwise silently steal the mount). Uses `yaml`'s Document API rather
 * than parse-to-JS-then-stringify: only the two touched paths (this
 * container's volumeMounts, the pod spec's volumes) are replaced, so
 * unrelated comments, anchors, and formatting elsewhere in the file survive.
 */
function patchDeploymentYaml(currentYaml: string, volumeName: string, pvcName: string, mountPath: string, deploymentName: string): string {
  // A trailing `---` (common in hand-written manifests) parses as a second,
  // empty document — don't let that trip the single-document check.
  const docs = parseAllDocuments(currentYaml).filter((d) => d.toJS() !== null)
  if (docs.length !== 1) {
    throw new Error(`Expected deployment.yaml to contain exactly one YAML document, found ${docs.length}`)
  }
  const doc = docs[0] as Document
  if (doc.errors.length > 0) {
    throw new Error(`Failed to parse deployment.yaml: ${doc.errors[0].message}`)
  }
  if (doc.get('kind') !== 'Deployment') {
    throw new Error(`Expected deployment.yaml's kind to be "Deployment", found "${String(doc.get('kind'))}"`)
  }

  const containersNode = doc.getIn(['spec', 'template', 'spec', 'containers'])
  if (!isSeq(containersNode)) {
    throw new Error('deployment.yaml has no spec.template.spec.containers list')
  }
  // Matching by container name === Deployment name is a real convention in
  // this cluster (every app under deployments/apps/ names its one container
  // after the app), but it's not a Kubernetes rule — silently falling back
  // to containers[0] on a miss could mount into an unrelated sidecar (e.g.
  // istio-proxy) with no error. Fail loudly instead: for a single-container
  // pod the name doesn't matter (there's only one place to mount), but for
  // multiple containers we need an unambiguous match.
  const containerIndex = containersNode.items.findIndex((c) => isMap(c) && c.get('name') === deploymentName)
  const targetIndex = containerIndex !== -1 ? containerIndex : containersNode.items.length === 1 ? 0 : -1
  if (targetIndex === -1) {
    throw new Error(
      `deployment.yaml has ${containersNode.items.length} containers and none is named "${deploymentName}" — ` +
        `can't tell which one should get the content mount. Name the target container "${deploymentName}" or update contentTarget.deployment to match.`,
    )
  }

  const volumeMountsPath = ['spec', 'template', 'spec', 'containers', targetIndex, 'volumeMounts']
  const existingMounts = doc.getIn(volumeMountsPath)
  const existingMountsJs: Array<{ name?: string }> = isSeq(existingMounts) ? (existingMounts.toJSON() as Array<{ name?: string }>) : []
  const newMounts = [
    ...existingMountsJs.filter((m) => m?.name !== volumeName),
    { name: volumeName, mountPath, readOnly: true },
  ]
  doc.setIn(volumeMountsPath, newMounts)

  const volumesPath = ['spec', 'template', 'spec', 'volumes']
  const existingVolumes = doc.getIn(volumesPath)
  const existingVolumesJs: Array<{ name?: string }> = isSeq(existingVolumes) ? (existingVolumes.toJSON() as Array<{ name?: string }>) : []
  const newVolumes = [
    ...existingVolumesJs.filter((v) => v?.name !== volumeName),
    { name: volumeName, persistentVolumeClaim: { claimName: pvcName } },
  ]
  doc.setIn(volumesPath, newVolumes)

  return doc.toString({ lineWidth: 0 })
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
  validateContentSource(config.contentSource)
  validateContentTarget(config.contentTarget)

  const { deployment, namespace, mountPath, pvcSizeGi } = config.contentTarget
  const pvcName = `${deployment}-content`
  const cronJobName = `${deployment}-content-sync`
  const volumeName = pvcName
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
    { path: `${dir}/deployment.yaml`, content: patchDeploymentYaml(currentDeploymentYaml, volumeName, pvcName, mountPath, deployment) },
  ]
}
