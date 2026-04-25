/**
 * GET /api/auth/totp/status — Check if MFA is enabled for current user
 *
 * POST handlers have been split into separate route files:
 * - /api/auth/totp/generate/route.ts — Generate TOTP secret
 * - /api/auth/totp/verify/route.ts — Verify and enable MFA
 * - /api/auth/totp/disable/route.ts — Disable MFA
 * - /api/auth/totp/recovery/route.ts — Get new recovery codes
 *
 * SOC2 [M-002] fixes:
 * - TOTP secret stored server-side, never extracted from client data
 * - Recovery codes properly consumed (removed after use)
 * - Separate route files prevent POST handler collisions
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { totpEnabled: true, totpEnabledAt: true },
  })

  return NextResponse.json({
    enabled: dbUser?.totpEnabled ?? false,
    enabledAt: dbUser?.totpEnabledAt ?? null,
  })
}
