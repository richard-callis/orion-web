import { rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { prisma } from '../db'
import { ensureGitRepo } from './git-repo'
import { runCommand } from './shell'
import { parseHostConnection, validateSshField, type HostConnection } from './ssh'
import type { BootstrapEnvironment, BootstrapEvent } from './types'

/** Sync deployment files from local temp dir to remote host via SCP. */
async function syncFilesToHost(
  connection: HostConnection,
  tmpDir: string,
  remotePath: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const scpCmd = [
    'scp', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-r', `${tmpDir}/deployments/`,
    `${connection.user}@${connection.host}:${remotePath}/`,
  ]
  if (connection.port) scpCmd.splice(scpCmd.indexOf(`${connection.user}@${connection.host}:${remotePath}/`), 0, '-P', String(connection.port))
  if (connection.keyPath) scpCmd.splice(scpCmd.indexOf('-o'), 0, '-i', connection.keyPath)

  await runCommand(scpCmd[0], scpCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
}

/** Deploy Docker Compose services to a single Docker host. */
async function deployDockerCompose(
  connection: HostConnection,
  remotePath: string,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  // Run docker-compose up -d on the remote host
  const sshCmd = [
    'ssh', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
    '-t', `${connection.user}@${connection.host}`,
    // remotePath validated: must not contain shell metacharacters to prevent RCE
    `cd ${validateSshField(remotePath, 'remotePath', /^[a-zA-Z0-9/_.-]{1,256}$/)} && docker compose up -d`,
  ]
  if (connection.port) sshCmd.splice(sshCmd.indexOf(`${connection.user}@${connection.host}`), 0, '-p', String(connection.port))

  await runCommand('ssh', sshCmd.slice(1), {}, msg => emit({ type: 'log', message: msg }))
}

/** Bootstrap a single Docker host environment. */
export async function bootstrapDockerEnvironment(
  env: BootstrapEnvironment,
  emit: (event: BootstrapEvent) => void,
): Promise<void> {
  const tmpDir = join(tmpdir(), `orion-bootstrap-${randomBytes(8).toString('hex')}`)
  await mkdir(tmpDir, { recursive: true })

  const connection = parseHostConnection(env)
  const remotePath  = (env.metadata as Record<string, unknown>)?.remotePath as string ?? '/opt/orion-deploy'

  try {
    // 1. Create git repo
    const gitInfo = await ensureGitRepo(env, emit)
    if (!gitInfo) return

    // 2. Sync deployment files to remote host
    emit({ type: 'step', message: `Syncing files to ${connection.host}:${remotePath}...` })
    await syncFilesToHost(connection, tmpDir, remotePath, emit)

    // 3. Deploy docker-compose
    emit({ type: 'step', message: 'Deploying Docker Compose services...' })
    await deployDockerCompose(connection, remotePath, emit)

    // 4. Update environment
    await prisma.environment.update({
      where: { id: env.id },
      data: {
        gitOwner: gitInfo.owner,
        gitRepo: gitInfo.repo,
        status: 'connected',
      },
    })

    emit({ type: 'done', message: 'Bootstrap complete! Services deployed via Docker Compose.' })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
