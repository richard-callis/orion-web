import { randomBytes } from 'crypto'
import { hash } from 'bcryptjs'
import { prisma } from './db'
import { Prisma } from '@prisma/client'
import { LOCALHOST_DEFAULT_TOOLS } from './default-tools'

export async function ensureSetupToken(): Promise<void> {
  // No-op if setup is already complete
  const completed = await prisma.systemSetting.findUnique({
    where: { key: 'setup.completed' },
  })
  if (completed?.value === true) return

  // Idempotent — don't regenerate if token already exists (handles restarts during setup)
  const existing = await prisma.systemSetting.findUnique({
    where: { key: 'setup.token' },
  })
  if (existing) {
    console.log('[orion] First-run setup pending. Check Docker logs for SETUP_TOKEN.')
    return
  }

  const token = randomBytes(32).toString('hex')
  const tokenHash = await hash(token, 12)

  await prisma.systemSetting.create({
    data: { key: 'setup.token', value: tokenHash },
  })

  // bootstrap.sh greps for this exact line
  console.log(`SETUP_TOKEN: ${token}`)
  console.log('[orion] Visit http://<management-ip>:3000/setup to complete first-run setup.')
}

/**
 * Seed a localhost gateway environment on startup when LOCALHOST_JOIN_TOKEN is set.
 * Idempotent — no-op if the environment already exists.
 *
 * The token value comes from the .env file so the gateway container gets the same
 * value via its JOIN_TOKEN env var without any dynamic coordination.
 */
export async function ensureLocalhostGateway(): Promise<void> {
  const joinTokenValue = process.env.LOCALHOST_JOIN_TOKEN?.trim()
  if (!joinTokenValue) return // Not running in localhost-gateway mode

  // Idempotent — already exists (connected or pending)
  const existing = await prisma.environment.findFirst({ where: { type: 'localhost' } })
  if (existing) return

  console.log('[orion] Seeding localhost gateway environment…')

  const env = await prisma.environment.create({
    data: {
      name:        'localhost',
      type:        'localhost',
      description: 'ORION management host (auto-registered local gateway)',
      status:      'disconnected',
    },
  })

  // Seed default tools
  await prisma.mcpTool.createMany({
    data: LOCALHOST_DEFAULT_TOOLS.map(t => ({
      environmentId: env.id,
      name:          t.name,
      description:   t.description,
      inputSchema:   t.inputSchema,
      execType:      t.execType,
      execConfig:    t.execConfig ?? null as any,
      enabled:       true,
      builtIn:       t.builtIn,
      status:        'active',
    })),
    skipDuplicates: true,
  })

  // Create the pre-shared join token (1-year expiry)
  await prisma.environmentJoinToken.create({
    data: {
      environmentId: env.id,
      token:         joinTokenValue,
      expiresAt:     new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  })

  console.log(`[orion] Localhost gateway environment ready (id: ${env.id}), waiting for gateway to connect…`)
}
