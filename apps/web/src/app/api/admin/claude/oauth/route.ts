/**
 * POST /api/admin/claude/oauth
 *
 * Starts the Claude Code OAuth flow by running `claude login` inside the
 * claude-refresh container via Docker exec. Returns a BackgroundJob ID that
 * the UI can poll for log output (which includes the auth URL to visit).
 *
 * On completion, `claude login` writes credentials to /root/.claude in the
 * claude-refresh container, and the refresh script copies them to the shared
 * /claude-creds volume — which the web container also mounts.
 */
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { spawn } from 'child_process'

// Name of the claude-refresh container (matches docker-compose service name)
const REFRESH_CONTAINER = process.env.CLAUDE_REFRESH_CONTAINER ?? 'deploy-claude-refresh-1'
const CREDS_PATH = '/claude-creds/.claude/.credentials.json'

export async function POST() {
  await requireAdmin()

  const job = await prisma.backgroundJob.create({
    data: {
      type: 'claude-oauth',
      title: 'Claude Code OAuth Login',
      status: 'running',
      logs: 'Starting Claude OAuth flow...\n',
    },
  })

  // Run async — do not await
  runOAuthFlow(job.id).catch(async (err) => {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: 'failed', logs: { set: `Error: ${err instanceof Error ? err.message : String(err)}\n` } },
    }).catch(() => {})
  })

  return NextResponse.json({ jobId: job.id })
}

async function runOAuthFlow(jobId: string) {
  const appendLog = async (line: string) => {
    const current = await prisma.backgroundJob.findUnique({ where: { id: jobId }, select: { logs: true } })
    const prev = typeof current?.logs === 'string' ? current.logs : ''
    await prisma.backgroundJob.update({
      where: { id: jobId },
      data: { logs: prev + line },
    }).catch(() => {})
  }

  await appendLog(`Executing: docker exec ${REFRESH_CONTAINER} claude login\n`)
  await appendLog('Waiting for auth URL — this may take a few seconds...\n\n')

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', REFRESH_CONTAINER, 'claude', 'login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const handle = async (data: Buffer) => {
      const text = data.toString()
      await appendLog(text)
    }

    proc.stdout.on('data', handle)
    proc.stderr.on('data', handle)

    proc.on('close', async (code) => {
      if (code === 0) {
        await appendLog('\n✓ Login completed. Copying credentials to shared volume...\n')

        // claude login writes to /root/.claude in the refresh container.
        // The refresh script already copies to /claude-creds on each loop,
        // but we trigger a copy immediately via docker exec.
        const copy = spawn('docker', [
          'exec', REFRESH_CONTAINER,
          'sh', '-c',
          `mkdir -p /claude-creds/.claude && cp /root/.claude/.credentials.json ${CREDS_PATH}`,
        ])
        await new Promise<void>(r => copy.on('close', () => r()))
        await appendLog('✓ Credentials saved. Claude Code is ready.\n')

        await prisma.backgroundJob.update({
          where: { id: jobId },
          data: { status: 'completed' },
        }).catch(() => {})
        resolve()
      } else {
        await appendLog(`\n✗ claude login exited with code ${code}\n`)
        await prisma.backgroundJob.update({
          where: { id: jobId },
          data: { status: 'failed' },
        }).catch(() => {})
        reject(new Error(`Exit code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}
