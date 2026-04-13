/**
 * Docker Gateway Deployer
 *
 * Deploys the ORION gateway container on the local Docker host via the
 * Unix socket at /var/run/docker.sock — no docker CLI required.
 *
 * Steps:
 *   1. Pull the gateway image (streams progress)
 *   2. Remove any existing container with the same name (idempotent)
 *   3. Create + start the new container
 */

import http from 'http'
import { randomBytes } from 'crypto'
import { prisma } from './db'

const SOCKET = '/var/run/docker.sock'
const GATEWAY_IMAGE = `ghcr.io/${process.env.GITHUB_ORG ?? 'richard-callis'}/orion-gateway:latest`
const ORION_CALLBACK_URL = (
  process.env.ORION_CALLBACK_URL ??
  (process.env.MANAGEMENT_IP ? `http://${process.env.MANAGEMENT_IP}:3000` : null) ??
  process.env.NEXTAUTH_URL ??
  'http://localhost:3000'
).replace(/\/$/, '')

export type GatewayDeployEvent =
  | { type: 'step'; message: string }
  | { type: 'log';  message: string }
  | { type: 'error'; message: string }
  | { type: 'done'; message: string }

// ── Docker socket helpers ─────────────────────────────────────────────────────

function dockerRequest(opts: {
  method: string
  path: string
  body?: unknown
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined
    const req = http.request(
      {
        socketPath: SOCKET,
        method: opts.method,
        path: opts.path,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Stream pull progress — resolves when pull is complete, yields log lines via onLog. */
function dockerPull(image: string, onLog: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const [repoTag] = image.split(':')
    const tag = image.includes(':') ? image.split(':')[1] : 'latest'
    const path = `/images/create?fromImage=${encodeURIComponent(repoTag)}&tag=${encodeURIComponent(tag)}`

    const req = http.request(
      { socketPath: SOCKET, method: 'POST', path },
      (res) => {
        let buf = ''
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString()
          // Docker streams newline-delimited JSON
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const evt = JSON.parse(line) as { status?: string; progress?: string; error?: string }
              if (evt.error) { reject(new Error(evt.error)); return }
              const msg = evt.progress ? `${evt.status} ${evt.progress}` : evt.status
              if (msg) onLog(msg)
            } catch {
              // ignore malformed lines
            }
          }
        })
        res.on('end', () => resolve())
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ── Main deploy function ──────────────────────────────────────────────────────

export async function deployLocalGateway(
  environmentId: string,
  emit: (event: GatewayDeployEvent) => void,
): Promise<void> {
  const env = await prisma.environment.findUnique({ where: { id: environmentId } })
  if (!env) throw new Error('Environment not found')
  if (env.type !== 'localhost' && env.type !== 'docker') {
    throw new Error(`deployLocalGateway only supports localhost/docker environments, got: ${env.type}`)
  }

  const containerName = `orion-gateway-${env.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`

  // 1. Generate a join token
  emit({ type: 'step', message: 'Generating join token…' })
  await prisma.environmentJoinToken.deleteMany({
    where: { environmentId, usedAt: null },
  })
  const joinToken = 'mcg_' + randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year
  await prisma.environmentJoinToken.create({
    data: { token: joinToken, environmentId, expiresAt },
  })
  emit({ type: 'log', message: `Token: ${joinToken.slice(0, 12)}…` })

  // 2. Pull the gateway image
  emit({ type: 'step', message: `Pulling ${GATEWAY_IMAGE}…` })
  await dockerPull(GATEWAY_IMAGE, msg => emit({ type: 'log', message: msg }))
  emit({ type: 'log', message: 'Image ready.' })

  // 3. Remove existing container with same name (idempotent re-deploy)
  emit({ type: 'step', message: `Removing existing container (if any)…` })
  const rmRes = await dockerRequest({ method: 'DELETE', path: `/containers/${containerName}?force=true` })
  if (rmRes.status === 204) {
    emit({ type: 'log', message: `Removed existing container ${containerName}.` })
  } else if (rmRes.status === 404) {
    emit({ type: 'log', message: 'No existing container found — clean deploy.' })
  } else {
    emit({ type: 'log', message: `Remove returned ${rmRes.status} — continuing.` })
  }

  // 4. Create container
  emit({ type: 'step', message: 'Creating container…' })
  const gatewayUrl = env.gatewayUrl ?? `http://${process.env.MANAGEMENT_IP ?? 'localhost'}:3001`
  const createBody = {
    Image: GATEWAY_IMAGE,
    Env: [
      `JOIN_TOKEN=${joinToken}`,
      `GATEWAY_TYPE=${env.type}`,
      `ORION_URL=${ORION_CALLBACK_URL}`,
      `GATEWAY_URL=${gatewayUrl}`,
    ],
    HostConfig: {
      Binds: ['/var/run/docker.sock:/var/run/docker.sock:ro'],
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'deploy_default',  // same compose network as ORION
    },
  }
  const createRes = await dockerRequest({
    method: 'POST',
    path: `/containers/create?name=${encodeURIComponent(containerName)}`,
    body: createBody,
  })
  if (createRes.status !== 201) {
    throw new Error(`Container create failed (${createRes.status}): ${createRes.body}`)
  }
  const { Id: containerId } = JSON.parse(createRes.body) as { Id: string }
  emit({ type: 'log', message: `Container created: ${containerId.slice(0, 12)}` })

  // 5. Start container
  emit({ type: 'step', message: 'Starting container…' })
  const startRes = await dockerRequest({ method: 'POST', path: `/containers/${containerId}/start` })
  if (startRes.status !== 204 && startRes.status !== 304) {
    throw new Error(`Container start failed (${startRes.status}): ${startRes.body}`)
  }
  emit({ type: 'log', message: 'Gateway container started.' })

  emit({ type: 'done', message: 'Gateway deployed — it will connect to ORION within ~30 seconds.' })
}
