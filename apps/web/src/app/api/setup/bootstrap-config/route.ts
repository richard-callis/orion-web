export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireWizardSession } from '@/lib/setup-guard'

// Returns server-side env vars needed by the setup wizard UI.
// (NEXT_PUBLIC_ vars are baked at build time so we expose them server-side instead.)
export async function GET(req: NextRequest) {
  if (!await requireWizardSession(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Only expose Gitea credentials during setup — after completion they're
  // stored encrypted in the database and this endpoint should not leak them.
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'setup.completed' } })
  if (setting?.value === true) {
    return NextResponse.json({
      managementIp: process.env.MANAGEMENT_IP ?? '',
      giteaBundled: false,
      giteaAdminToken: '',
      giteaAdminUser: '',
      giteaAdminPassword: '',
    })
  }

  // Bundled Gitea: prefer pre-generated API token (no basic-auth / password-change issues).
  // Fall back to user+password if token not yet generated.
  const adminToken    = process.env.GITEA_ADMIN_TOKEN ?? ''
  const adminUser     = process.env.GITEA_ADMIN_USER ?? ''
  const adminPassword = process.env.GITEA_ADMIN_PASSWORD ?? ''
  const giteaBundled  = !!(adminToken || (adminUser && adminPassword))

  return NextResponse.json({
    managementIp: process.env.MANAGEMENT_IP ?? '',
    giteaBundled,
    giteaAdminToken:    adminToken,
    giteaAdminUser:     adminUser,
    giteaAdminPassword: adminPassword,
  })
}
