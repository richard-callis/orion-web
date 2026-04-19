/**
 * POST /api/storage/bootstrap
 *
 * Deploys Longhorn or Rook-Ceph into a Kubernetes environment via the ORION Gateway.
 * For Talos clusters, auto-detects and installs prerequisites (iscsi-tools extension).
 * Returns { jobId } immediately — progress tracked via /api/jobs/[id].
 */
import * as fs from 'fs'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { startJob, type JobLogger } from '@/lib/job-runner'

type StorageType = 'longhorn' | 'ceph'

async function gatewayExec(
  gatewayUrl: string,
  gatewayToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${gatewayUrl}/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
    body: JSON.stringify({ name: toolName, arguments: args }),
  })
  if (!res.ok) throw new Error(`Gateway tool ${toolName} failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { result?: string; error?: string }
  if (data.error) throw new Error(data.error)
  return data.result ?? ''
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { environmentId?: string; storageType?: StorageType }
  if (!body.environmentId) {
    return NextResponse.json({ error: 'environmentId is required' }, { status: 400 })
  }

  const storageType: StorageType = body.storageType === 'ceph' ? 'ceph' : 'longhorn'

  const env = await prisma.environment.findUnique({ where: { id: body.environmentId } })
  if (!env) {
    return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  }
  if (env.type !== 'cluster') {
    return NextResponse.json(
      { error: 'Storage bootstrap is only supported for Kubernetes cluster environments' },
      { status: 422 },
    )
  }
  if (!env.gatewayUrl || !env.gatewayToken) {
    return NextResponse.json({ error: 'Environment gateway not connected' }, { status: 422 })
  }

  // Extract talosConfig from environment metadata (base64-encoded talosconfig YAML)
  const meta = (env.metadata as Record<string, unknown> | null) ?? {}
  const talosConfig = (meta.talosConfig as string | undefined) ?? null

  const label = storageType === 'ceph' ? 'Rook-Ceph' : 'Longhorn'
  const jobId = await startJob(
    'storage-bootstrap',
    `${label} bootstrap — ${env.name}`,
    { environmentId: env.id, metadata: { storageType } },
    async (log) => {
      if (storageType === 'ceph') {
        await bootstrapCeph(log, env.gatewayUrl!, env.gatewayToken!, env.name)
      } else {
        await bootstrapLonghorn(log, env.gatewayUrl!, env.gatewayToken!, env.name, env.id, talosConfig)
      }
    },
  )

  return NextResponse.json({ jobId })
}

// ── Talos prerequisite detection & auto-remediation ───────────────────────────

async function detectTalos(
  exec: (tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<{ isTalos: boolean; nodeIps: string[] }> {
  try {
    const json = await exec('kubectl_get', { resource: 'nodes', output: 'json' })
    const list = JSON.parse(json) as { items?: Record<string, unknown>[] }
    const items = list.items ?? []
    if (!items.length) return { isTalos: false, nodeIps: [] }

    const first = items[0] as { status?: { nodeInfo?: { osImage?: string }; addresses?: { type: string; address: string }[] } }
    const osImage = first.status?.nodeInfo?.osImage ?? ''
    const isTalos = osImage.toLowerCase().includes('talos')

    const nodeIps = items.flatMap(node => {
      const addresses = (node as typeof first).status?.addresses ?? []
      return addresses.filter(a => a.type === 'InternalIP').map(a => a.address)
    })

    return { isTalos, nodeIps }
  } catch {
    return { isTalos: false, nodeIps: [] }
  }
}

async function getTalosIscsiSchematic(): Promise<string> {
  const res = await fetch('https://factory.talos.dev/schematics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customization: {
        systemExtensions: {
          officialExtensions: ['siderolabs/iscsi-tools'],
        },
      },
    }),
  })
  if (!res.ok) throw new Error(`Talos Image Factory failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { id?: string }
  if (!data.id) throw new Error('Talos Image Factory did not return a schematic ID')
  return data.id
}

// Candidate paths where talosconfig may be found on the host (mounted into the container)
const TALOS_CONFIG_PATHS = ['/root/.talos/config', '/root/.talos/talosconfig']

async function autoFetchTalosConfig(
  log: JobLogger,
  envId: string,
  existingMeta: Record<string, unknown>,
): Promise<string | null> {
  for (const p of TALOS_CONFIG_PATHS) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim()
      if (!raw) continue
      const b64 = Buffer.from(raw).toString('base64')
      // Persist back to environment metadata so future runs skip this step
      await prisma.environment.update({
        where: { id: envId },
        data: { metadata: { ...existingMeta, talosConfig: b64 } },
      })
      await log(`  Auto-fetched talosconfig from ${p} ✓`)
      await log('  Saved to environment — will be reused on future bootstraps.')
      return b64
    } catch { /* try next path */ }
  }
  return null
}

async function checkAndFixIscsi(
  log: JobLogger,
  exec: (tool: string, args: Record<string, unknown>) => Promise<string>,
  nodeIps: string[],
  talosConfig: string | null,
): Promise<void> {
  if (!talosConfig) {
    await log('  ⚠ No talosConfig available — cannot check/install iscsi-tools.')
    await log('    Proceeding — Longhorn will fail if iscsi-tools is missing.')
    return
  }

  await log('Checking iscsi-tools extension on all nodes...')
  const nodesNeedingFix: string[] = []

  for (const nodeIp of nodeIps) {
    try {
      const raw = await exec('talos_get_extensions', { nodeIp, talosConfig })
      // talosctl get extensions returns NDJSON
      const lines = raw.trim().split('\n').filter(Boolean)
      const hasIscsi = lines.some(line => {
        try {
          const obj = JSON.parse(line) as { spec?: { metadata?: { name?: string } } }
          return obj.spec?.metadata?.name === 'iscsi-tools'
        } catch { return false }
      })
      if (hasIscsi) {
        await log(`  iscsi-tools present on ${nodeIp} ✓`)
      } else {
        await log(`  ✗ iscsi-tools missing on ${nodeIp}`)
        nodesNeedingFix.push(nodeIp)
      }
    } catch (err) {
      await log(`  ⚠ Could not check extensions on ${nodeIp}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!nodesNeedingFix.length) return

  await log(`Installing iscsi-tools on ${nodesNeedingFix.length} node(s) via Talos Image Factory...`)

  let schematicId: string
  try {
    schematicId = await getTalosIscsiSchematic()
    await log(`  Factory schematic ID: ${schematicId}`)
  } catch (err) {
    throw new Error(`Could not get Talos factory schematic: ${err instanceof Error ? err.message : String(err)}`)
  }

  for (const nodeIp of nodesNeedingFix) {
    await log(`\n  ── Node ${nodeIp} ──`)

    // Get current Talos version
    await log(`  Getting Talos version on ${nodeIp}...`)
    const versionOut = await exec('talos_get_version', { nodeIp, talosConfig })
    const versionMatch = versionOut.match(/Tag:\s+v([\d.]+)/)
    if (!versionMatch) {
      throw new Error(`Could not determine Talos version on ${nodeIp}. Output:\n${versionOut.slice(0, 300)}`)
    }
    const talosVersion = versionMatch[1]
    await log(`  Version: v${talosVersion}`)

    // Patch machine config to add extension (strategic merge — works with multi-document configs)
    await log(`  Patching machine config on ${nodeIp}...`)
    const extensionEntry = { image: 'ghcr.io/siderolabs/iscsi-tools:v0.1.6' }
    try {
      await exec('talos_patch_machineconfig', {
        nodeIp, talosConfig,
        patch: JSON.stringify({ machine: { install: { extensions: [extensionEntry] } } }),
      })
      await log(`  Machine config patched ✓`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('duplicate system extension')) {
        await log(`  Machine config already has iscsi-tools — skipping patch ✓`)
      } else {
        throw err
      }
    }

    // Upgrade to factory image with extension baked in (triggers reboot)
    const installerImage = `factory.talos.dev/installer/${schematicId}:v${talosVersion}`
    await log(`  Upgrading to factory image (node will reboot, ~3-5 min)...`)
    await log(`  Image: ${installerImage}`)
    await exec('talos_upgrade', { nodeIp, talosConfig, installerImage, preserve: true })
    await log(`  Node ${nodeIp} rebooted with iscsi-tools ✓`)
  }

  // Wait for all nodes to be Ready in Kubernetes after reboots
  await log('\n  Waiting for all nodes to report Ready...')
  await exec('kubectl_wait_nodes_ready', { timeout: '300s' })
  await log('  All nodes Ready ✓')
}

// ── Longhorn ──────────────────────────────────────────────────────────────────

async function bootstrapLonghorn(
  log: JobLogger,
  gatewayUrl: string,
  gatewayToken: string,
  envName: string,
  envId: string,
  talosConfig: string | null,
): Promise<void> {
  const exec = (tool: string, args: Record<string, unknown>) =>
    gatewayExec(gatewayUrl, gatewayToken, tool, args)

  await log(`Bootstrapping Longhorn in environment "${envName}"...`)

  // ── Preflight: detect Talos and auto-fix iSCSI ─────────────────────────────
  await log('Preflight: Detecting cluster type...')
  const { isTalos, nodeIps } = await detectTalos(exec)

  if (isTalos) {
    await log(`  Talos cluster detected (${nodeIps.length} node(s))`)

    // Auto-fetch talosconfig from the host if not already stored
    let effectiveTalosConfig = talosConfig
    if (!effectiveTalosConfig) {
      await log('  No talosConfig stored — attempting to auto-fetch from host...')
      const env = await prisma.environment.findUnique({ where: { id: envId } })
      const existingMeta = (env?.metadata as Record<string, unknown> | null) ?? {}
      effectiveTalosConfig = await autoFetchTalosConfig(log, envId, existingMeta)
      if (!effectiveTalosConfig) {
        await log('  ⚠ Could not find talosconfig on host (checked /root/.talos/config).')
        await log('    Run: talosctl config export > /root/.talos/config  on the host,')
        await log('    then re-run bootstrap.')
      }
    }

    await checkAndFixIscsi(log, exec, nodeIps, effectiveTalosConfig)
  } else {
    await log('  Standard Kubernetes cluster ✓')
  }

  // ── Step 1: Check existing installation ────────────────────────────────────
  await log('Step 1/3: Checking for existing Longhorn installation...')
  let needsInstall = true
  try {
    await exec('kubectl_get', { resource: 'namespace', name: 'longhorn-system' })
    // Namespace exists — check if manager is actually healthy
    try {
      const dsJson = await exec('kubectl_get', {
        resource: 'daemonset', name: 'longhorn-manager', namespace: 'longhorn-system', output: 'json',
      })
      const ds = JSON.parse(dsJson) as { status?: { numberReady?: number } }
      if ((ds.status?.numberReady ?? 0) > 0) {
        await log('  Longhorn already installed and healthy ✓')
        needsInstall = false
      } else {
        await log('  Longhorn namespace exists but manager is unhealthy — re-applying manifests...')
      }
    } catch {
      await log('  Longhorn namespace exists but manager not found — re-applying manifests...')
    }
  } catch {
    // namespace doesn't exist
  }

  // ── Step 2: Install ────────────────────────────────────────────────────────
  if (needsInstall) {
    await log('Step 2/3: Applying Longhorn manifests (this may take a few minutes)...')
    await exec('kubectl_apply_url', {
      url: 'https://raw.githubusercontent.com/longhorn/longhorn/v1.7.2/deploy/longhorn.yaml',
    })
    await log('  Longhorn manifests applied ✓')

    // Apply privileged PodSecurity labels immediately so manager pods aren't blocked
    await log('  Configuring namespace PodSecurity policy...')
    await exec('kubectl_apply_manifest', { manifest: longhornNamespace() })
    await log('  Namespace policy set ✓')

    await log('  Waiting for longhorn-manager DaemonSet to be ready...')
    await exec('kubectl_rollout_status', {
      kind: 'daemonset', name: 'longhorn-manager', namespace: 'longhorn-system', timeout: '300s',
    })
    await log('  longhorn-manager ready ✓')

    await log('  Waiting for longhorn-driver-deployer to be ready...')
    await exec('kubectl_rollout_status', {
      kind: 'deployment', name: 'longhorn-driver-deployer', namespace: 'longhorn-system', timeout: '120s',
    })
    await log('  longhorn-driver-deployer ready ✓')
  } else {
    await log('Step 2/3: Skipping install (already healthy)')
  }

  // ── Step 3: Default StorageClass ───────────────────────────────────────────
  await log('Step 3/3: Setting Longhorn as default StorageClass...')
  await exec('kubectl_apply_manifest', { manifest: longhornStorageClass() })
  await log('  Default StorageClass set ✓')

  await log('Longhorn bootstrap complete!')
}

// ── Rook-Ceph ─────────────────────────────────────────────────────────────────

async function bootstrapCeph(
  log: JobLogger,
  gatewayUrl: string,
  gatewayToken: string,
  envName: string,
): Promise<void> {
  const exec = (tool: string, args: Record<string, unknown>) =>
    gatewayExec(gatewayUrl, gatewayToken, tool, args)

  await log(`Bootstrapping Rook-Ceph in environment "${envName}"...`)

  await log('Step 1/5: Checking for existing Rook-Ceph installation...')
  let exists = false
  try {
    await exec('kubectl_get', { resource: 'namespace', name: 'rook-ceph' })
    exists = true
    await log('  Rook-Ceph already installed ✓')
  } catch { exists = false }

  if (!exists) {
    await log('Step 2/5: Applying Rook-Ceph CRDs...')
    await exec('kubectl_apply_url', {
      url: 'https://raw.githubusercontent.com/rook/rook/v1.16.0/deploy/examples/crds.yaml',
    })
    await log('  CRDs applied ✓')

    await log('Step 3/5: Applying Rook-Ceph operator...')
    await exec('kubectl_apply_url', {
      url: 'https://raw.githubusercontent.com/rook/rook/v1.16.0/deploy/examples/operator.yaml',
    })
    await log('  Operator applied ✓')

    await log('  Waiting for rook-ceph-operator to be ready...')
    await exec('kubectl_rollout_status', {
      kind: 'deployment', name: 'rook-ceph-operator', namespace: 'rook-ceph', timeout: '180s',
    })
    await log('  rook-ceph-operator ready ✓')

    await log('Step 4/5: Creating CephCluster (this may take 5-10 minutes)...')
    await exec('kubectl_apply_manifest', { manifest: cephClusterManifest() })
    await log('  CephCluster created — waiting for health (up to 10 min)...')
    await exec('kubectl_rollout_status', {
      kind: 'deployment', name: 'rook-ceph-mgr-a', namespace: 'rook-ceph', timeout: '600s',
    })
    await log('  Ceph cluster healthy ✓')
  } else {
    await log('Steps 2-4/5: Skipping install (already present)')
  }

  await log('Step 5/5: Applying CephBlockPool and StorageClass...')
  await exec('kubectl_apply_manifest', { manifest: cephStorageClass() })
  await log('  CephBlockPool + StorageClass applied ✓')

  await log('Rook-Ceph bootstrap complete!')
}

// ── Manifests ─────────────────────────────────────────────────────────────────

function longhornNamespace(): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: longhorn-system
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: privileged
    pod-security.kubernetes.io/warn: privileged`
}

function longhornStorageClass(): string {
  return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "2"
  staleReplicaTimeout: "2880"
  fromBackup: ""
  fsType: ext4`
}

function cephClusterManifest(): string {
  return `apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v19
    allowUnsupported: false
  dataDirHostPath: /var/lib/rook
  skipUpgradeChecks: false
  continueUpgradeAfterChecksEvenIfNotHealthy: false
  mon:
    count: 3
    allowMultiplePerNode: false
  mgr:
    count: 1
    modules:
      - name: pg_autoscaler
        enabled: true
  dashboard:
    enabled: true
    ssl: true
  monitoring:
    enabled: false
  network:
    connections:
      encryption:
        enabled: false
      compression:
        enabled: false
  crashCollector:
    disable: false
  cleanupPolicy:
    confirmation: ""
    sanitizeDisks:
      method: quick
      dataSource: zero
      iteration: 1
    allowUninstallWithVolumes: false
  storage:
    useAllNodes: true
    useAllDevices: true
  disruptionManagement:
    managePodBudgets: true
    osdMaintenanceTimeout: 30
    pgHealthCheckTimeout: 0`
}

function cephStorageClass(): string {
  return `apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host
  replicated:
    size: 3
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "false"
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: ext4
allowVolumeExpansion: true
reclaimPolicy: Delete`
}
