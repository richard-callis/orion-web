/**
 * POST /api/environments/[id]/rotate-token
 *
 * SOC2: [CRITICAL-2] Gateway token (mcga_*) revocation/rotation endpoint.
 *
 * Generates a new mcga_* token, stores it in the environment record (replacing
 * the old one), and returns the new plaintext token once. The old token is
 * immediately invalid — any gateway still holding it will get 401s on heartbeat.
 *
 * Requires admin auth. Only admins/owners should be able to rotate environment
 * credentials.
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { logAudit, getClientIp, getUserAgent } from '@/lib/audit'
import { randomBytes } from 'crypto'

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Require admin auth — only admins can rotate environment gateway tokens
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const env = await prisma.environment.findUnique({
    where: { id: (await params).id },
    select: { id: true, name: true, gatewayToken: true },
  })

  if (!env) {
    return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  }

  // Generate a new mcga_* token — same pattern as /api/environments/join
  const newToken = 'mcga_' + randomBytes(32).toString('hex')

  await prisma.environment.update({
    where: { id: (await params).id },
    data: { gatewayToken: newToken },
  })

  // SOC2: [M-005] Audit log the token rotation
  void logAudit({
    userId: admin.id,
    action: 'environment_update',
    target: `environment:${(await params).id}`,
    detail: { event: 'gateway_token_rotated', environmentName: env.name },
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req.headers),
  })

  // Return the new token plaintext — this is the only time it's visible.
  // The caller must distribute it to the gateway immediately.
  return NextResponse.json({
    ok: true,
    environmentId: (await params).id,
    gatewayToken: newToken,
    message: 'Gateway token rotated. Distribute the new token to your gateway immediately — it will not be shown again.',
  })
}
