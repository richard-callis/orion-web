export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

// Returns server-side env vars needed by the setup wizard UI.
// (NEXT_PUBLIC_ vars are baked at build time so we expose them server-side instead.)
export async function GET() {
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
