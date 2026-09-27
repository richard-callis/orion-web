import { writeFile, rm, mkdir, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { runCommand, runQuiet } from './shell'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

// ── Standalone monitoring deployment ─────────────────────────────────────────

export async function deployMonitoringStack(
  envId: string,
  stack: 'basic' | 'full',
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) throw new Error('Environment not found')
  if (env.type !== 'cluster') throw new Error('Monitoring deployment is only supported for Kubernetes environments')
  if (!env.kubeconfig) throw new Error('No kubeconfig stored for this environment')

  const tmpDir = join(tmpdir(), `orion-monitoring-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const kubeconfigPath = join(tmpDir, 'kubeconfig')
  await writeFile(kubeconfigPath, Buffer.from(env.kubeconfig, 'base64').toString('utf8'), { mode: 0o600 })

  const kenv = { KUBECONFIG: kubeconfigPath, KUBECTL_CACHE_DIR: join(tmpDir, 'kubectl-cache') }

  try {
    emit({ type: 'step', message: 'Verifying cluster connectivity...' })
    await runCommand('kubectl', ['cluster-info'], kenv, msg => emit({ type: 'log', message: msg }))

    emit({ type: 'step', message: 'Creating monitoring namespace...' })
    await runQuiet('kubectl', ['create', 'namespace', 'monitoring'], kenv)

    if (stack === 'basic' || stack === 'full') {
      emit({ type: 'step', message: 'Deploying VictoriaMetrics (metrics & alerting)...' })
      await runCommand(
        'helm', [
          'upgrade', '--install', 'victoria-metrics-k8s-stack', 'victoriametrics/victoria-metrics-k8s-stack',
          '--namespace', 'victoria-metrics',
          '--create-namespace',
          '--wait',
          '--timeout', '5m',
          '--set', 'serverServiceEnabled=false',
          '--set', 'vmsingle.replicas=1',
        ],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      emit({ type: 'step', message: 'Deploying ntopng (network traffic analysis)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/ntopng/service.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
    }

    if (stack === 'full') {
      emit({ type: 'step', message: 'Deploying ELK stack (logs & flow analysis)...' })
      await runCommand('kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/namespace.yaml'], kenv, msg => emit({ type: 'log', message: msg }))
      await ensureElkCredentials(kenv, msg => emit({ type: 'log', message: msg }))
      for (const manifest of [
        '/opt/orion/deploy/monitoring/elk/elasticsearch-deployment.yaml',
        '/opt/orion/deploy/monitoring/elk/logstash-configmap.yaml',
        '/opt/orion/deploy/monitoring/elk/logstash-deployment.yaml',
        '/opt/orion/deploy/monitoring/elk/kibana-deployment.yaml',
      ]) {
        await runCommand('kubectl', ['apply', '-f', manifest], kenv, msg => emit({ type: 'log', message: msg }))
      }

      emit({ type: 'step', message: 'Deploying Elastiflow (NetFlow collector)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elastiflow/deployment.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
    }

    const namespacesToWait = stack === 'full'
      ? ['victoria-metrics', 'monitoring', 'elk']
      : ['victoria-metrics', 'monitoring']

    emit({ type: 'step', message: 'Waiting for monitoring pods to become ready...' })
    for (const ns of namespacesToWait) {
      try {
        await runCommand(
          'kubectl', ['wait', '--for=condition=Ready', '--all', '-n', ns, '--timeout=300s', 'pods'],
          kenv,
          msg => emit({ type: 'log', message: msg }),
        )
      } catch {
        emit({ type: 'log', message: `Some pods in ${ns} not ready yet — continuing` })
      }
    }

    await prisma.environment.update({
      where: { id: envId },
      data: { monitoringConfig: { stack } },
    })

    emit({ type: 'done', message: `Monitoring stack (${stack}) deployed successfully.` })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// ── Monitoring during cluster bootstrap ──────────────────────────────────────

/** Step 4.5 of bootstrapK8sCluster: deploy the env's configured monitoring stack, if any. */
export async function deployBootstrapMonitoring(
  env: BootstrapEnvironment,
  kenv: Record<string, string>,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const monitoringConfig = env.monitoringConfig as { stack?: string } | null
  if (monitoringConfig?.stack && monitoringConfig.stack !== 'none') {
    emit({ type: 'step', message: `Deploying monitoring stack (${monitoringConfig.stack})...` })

    // Deploy monitoring namespace
    await runCommand(
      'kubectl', ['create', 'namespace', 'monitoring', '--dry-run=client', '-o', 'yaml', '|', 'kubectl', 'apply', '-f', '-'],
      kenv,
      msg => emit({ type: 'log', message: msg }),
    )

    if (monitoringConfig.stack === 'basic' || monitoringConfig.stack === 'full') {
      // Deploy VictoriaMetrics
      emit({ type: 'step', message: 'Deploying VictoriaMetrics (metrics & alerting)...' })
      await runCommand(
        'helm', [
          'upgrade', '--install', 'victoria-metrics-k8s-stack', 'victoriametrics/victoria-metrics-k8s-stack',
          '--namespace', 'victoria-metrics',
          '--create-namespace',
          '--wait',
          '--timeout', '5m',
          '--set', 'serverServiceEnabled=false',
          '--set', 'vmsingle.replicas=1',
        ],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      // Deploy ntopng
      emit({ type: 'step', message: 'Deploying ntopng (network traffic analysis)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/ntopng/service.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
    }

    if (monitoringConfig.stack === 'full') {
      // Deploy ELK stack
      emit({ type: 'step', message: 'Deploying ELK stack (logs & flow analysis)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/namespace.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      await ensureElkCredentials(kenv, msg => emit({ type: 'log', message: msg }))
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/elasticsearch-deployment.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/logstash-configmap.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/logstash-deployment.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elk/kibana-deployment.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )

      // Deploy Elastiflow
      emit({ type: 'step', message: 'Deploying Elastiflow (NetFlow collector)...' })
      await runCommand(
        'kubectl', ['apply', '-f', '/opt/orion/deploy/monitoring/elastiflow/deployment.yaml'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
    }

    // Wait for monitoring pods
    emit({ type: 'step', message: 'Waiting for monitoring pods to become ready...' })
    try {
      await runCommand(
        'kubectl', ['wait', '--for=condition=Ready', '--all', '-n', 'monitoring', '--timeout=300s', 'pods'],
        kenv,
        msg => emit({ type: 'log', message: msg }),
      )
      emit({ type: 'log', message: 'Monitoring stack deployment complete' })
    } catch {
      emit({ type: 'log', message: 'Some monitoring pods not ready yet — will continue on next bootstrap' })
    }
  }
}

// ── ELK credentials ───────────────────────────────────────────────────────────

/**
 * Create the ELK `elasticsearch-credentials` Secret with a random password —
 * only if it doesn't already exist.
 *
 * This used to `kubectl apply` deploy/monitoring/elk/secret.yaml, which
 * committed a well-known default password ("orion-elk-default") to every
 * cluster. Existing clusters keep whatever password Elasticsearch was
 * initialised with (overwriting it would desync Logstash/Kibana/Elastiflow).
 * The password is written via a 0600 temp file so it never appears in argv.
 */
async function ensureElkCredentials(
  kenv: Record<string, string>,
  log: (msg: string) => void,
): Promise<void> {
  const exists = await runQuiet('kubectl', ['get', 'secret', 'elasticsearch-credentials', '-n', 'elk', '-o', 'name'], kenv)
  if (exists.ok) {
    log('elk/elasticsearch-credentials already exists — keeping the current password')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'orion-elk-'))
  const pwFile = join(dir, 'password')
  try {
    await writeFile(pwFile, randomBytes(24).toString('base64url'), { mode: 0o600 })
    await runCommand(
      'kubectl',
      ['create', 'secret', 'generic', 'elasticsearch-credentials', '-n', 'elk', `--from-file=password=${pwFile}`],
      kenv,
      log,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
