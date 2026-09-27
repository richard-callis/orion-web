import { readFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { ensureGitRepo } from './git-repo'
import { runCommand, runQuiet } from './shell'
import { parseHostConnection, validateSshField, type HostConnection } from './ssh'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

export interface SwarmNode {
  nodeId: string
  host: string
  role: 'manager' | 'worker'
}

/** Initialize Docker Swarm and add managers/workers. */
async function setupDockerSwarm(
  connection: HostConnection,
  nodes: SwarmNode[],
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  // Step 1: Manager initializes swarm
  emit({ type: 'step', message: 'Initializing Docker Swarm on manager...' })
  const initCmd = [
    'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-t', `${connection.user}@${connection.host}`,
    'docker swarm init --advertise-addr eth0',
  ]
  if (connection.port) initCmd.splice(initCmd.indexOf(`${connection.user}@${connection.host}`), 0, '-p', String(connection.port))

  await runCommand('ssh', initCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))

  // Step 2: Get join tokens
  emit({ type: 'step', message: 'Retrieving swarm join tokens...' })
  const managerTokenRes = await runQuiet(
    'ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-t', `${connection.user}@${connection.host}`,
      'docker swarm join-token manager -q',
    ],
    {},
  )
  const workerTokenRes = await runQuiet(
    'ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-t', `${connection.user}@${connection.host}`,
      'docker swarm join-token worker -q',
    ],
    {},
  )

  const managerToken = managerTokenRes.out.trim()
  const workerToken = workerTokenRes.out.trim()

  // Step 3: Join additional managers and workers
  for (const node of nodes) {
    // BLOCKER fix: node.host and node.nodeId come from env.metadata (user-supplied) and were
    // used directly in SSH target and docker label commands without validation.
    // A crafted host like '-oProxyCommand=...' yields SSH option injection; a crafted
    // nodeId like 'x; rm -rf /' yields shell injection in the docker node update command.
    // Validate both through the same validateSshField function used for the manager host.
    let safeNodeHost: string
    try {
      safeNodeHost = validateSshField(node.host, 'node.host', /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/)
      validateSshField(node.nodeId, 'node.nodeId', /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/)
    } catch (e) {
      console.error(`[bootstrap] Skipping swarm node with invalid host/nodeId: ${e}`)
      emit({ type: 'log', message: `Skipped node with invalid host/nodeId: ${e}` })
      continue
    }

    const isManager = node.role === 'manager'
    const token = isManager ? managerToken : workerToken
    if (!token) {
      console.warn(`[bootstrap] No join token for node ${node.nodeId} — skipping`)
      continue
    }

    emit({ type: 'step', message: `Joining ${node.role} node ${safeNodeHost}...` })
    const joinCmd = [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-t', `${connection.user}@${safeNodeHost}`,
      `docker swarm join --token "${token}" ${connection.host}:2377`,
    ]
    if (connection.port) joinCmd.splice(joinCmd.indexOf(`${connection.user}@${safeNodeHost}`), 0, '-p', String(connection.port))

    await runCommand('ssh', joinCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
  }

  // Step 4: Label nodes
  emit({ type: 'step', message: 'Labeling swarm nodes...' })
  for (const node of nodes) {
    let safeHost: string
    let safeId: string
    try {
      safeHost = validateSshField(node.host, 'node.host', /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/)
      safeId   = validateSshField(node.nodeId, 'node.nodeId', /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/)
    } catch {
      continue
    }
    const labelCmd = [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-t', `${connection.user}@${safeHost}`,
      `docker node update --label-add orion/env=${connection.user} ${safeId}`,
    ]
    if (connection.port) labelCmd.splice(labelCmd.indexOf(`${connection.user}@${safeHost}`), 0, '-p', String(connection.port))

    await runCommand('ssh', labelCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
  }

  console.log(`[bootstrap] Docker Swarm initialized: ${nodes.length} nodes`)
}

/** Deploy a stack to Docker Swarm using compose files from the repo. */
async function deploySwarmStack(
  connection: HostConnection,
  repoUrl: string,
  stackName: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(stackName)) {
    throw new Error(`Invalid stack name: ${stackName}`)
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.host)) {
    throw new Error(`Invalid host: ${connection.host}`)
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(connection.user)) {
    throw new Error(`Invalid user: ${connection.user}`)
  }
  // Clone the repo locally (needed for docker stack deploy which reads compose files)
  const stackDir = join(tmpdir(), `orion-swarm-${randomBytes(4).toString('hex')}`)
  await mkdir(stackDir, { recursive: true })

  try {
    emit({ type: 'step', message: 'Checking out deployment files...' })
    // Validate repoUrl is a safe http(s) URL before cloning
    let parsedRepoUrl: URL
    try { parsedRepoUrl = new URL(repoUrl) } catch { throw new Error(`Invalid repo URL: ${repoUrl}`) }
    if (parsedRepoUrl.protocol !== 'http:' && parsedRepoUrl.protocol !== 'https:') {
      throw new Error(`Repo URL must use http or https: ${repoUrl}`)
    }
    await runCommand(
      'git', ['clone', '--depth', '1', '--', repoUrl, stackDir],
      {},
      msg => emit({ type: 'log', message: msg }),
    )

    // docker stack deploy requires a compose file at a known path
    // Use the deployments/ directory if it exists, otherwise fall back to root
    const composePath = join(stackDir, 'deployments', 'docker-compose.yml')
    const fallbackComposePath = join(stackDir, 'docker-compose.yml')

    const targetPath = (await readFile(composePath, 'utf8').catch(() => null))
      ? composePath : fallbackComposePath

    if (!targetPath) throw new Error('No docker-compose.yml found in repo')

    emit({ type: 'step', message: 'Deploying stack to Docker Swarm...' })

    // SCP compose file to swarm manager then run docker stack deploy
    const scpToManager = [
      'scp', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      targetPath, `${connection.user}@${connection.host}:/tmp/orion-stack-compose.yml`,
    ]
    if (connection.port) scpToManager.splice(scpToManager.indexOf(`${connection.user}@${connection.host}`), 0, '-P', String(connection.port))

    await runCommand(scpToManager[0], scpToManager.slice(1), {}, msg => emit({ type: 'log', message: msg }))

    // Run docker stack deploy on the manager
    const deployCmd = [
      'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-t', `${connection.user}@${connection.host}`,
      `docker stack deploy -c /tmp/orion-stack-compose.yml ${stackName}`,
    ]
    if (connection.port) deployCmd.splice(deployCmd.indexOf(`${connection.user}@${connection.host}`), 0, '-p', String(connection.port))

    await runCommand('ssh', deployCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))

    console.log(`[bootstrap] Swarm stack "${stackName}" deployed`)
  } finally {
    await rm(stackDir, { recursive: true, force: true })
  }
}

/** Bootstrap a Docker Swarm environment. */
export async function bootstrapSwarmEnvironment(
  env: BootstrapEnvironment,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const manager = parseHostConnection(env)
  const nodes = (env.metadata as Record<string, unknown>)?.swarmNodes as SwarmNode[] ?? []
  const stackName = env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  try {
    // 1. Create git repo
    const gitInfo = await ensureGitRepo(env, emit)
    if (!gitInfo) return

    // 2. Initialize Swarm
    emit({ type: 'step', message: 'Initializing Docker Swarm...' })
    await setupDockerSwarm(manager, [{ nodeId: 'manager', host: manager.host, role: 'manager' }, ...nodes], emit)

    // 3. Deploy stack
    emit({ type: 'step', message: `Deploying swarm stack "${stackName}"...` })
    await deploySwarmStack(manager, gitInfo.url, stackName, emit)

    // 4. Update environment
    await prisma.environment.update({
      where: { id: env.id },
      data: {
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
        status: 'connected',
      },
    })

    emit({ type: 'done', message: `Bootstrap complete! Swarm stack "${stackName}" deployed.` })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
