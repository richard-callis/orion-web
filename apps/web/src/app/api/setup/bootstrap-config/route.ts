export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

// Returns server-side env vars needed by the setup wizard UI
// (NEXT_PUBLIC_ vars are baked at build time so we expose them server-side instead)
export async function GET() {
  return NextResponse.json({
    managementIp: process.env.MANAGEMENT_IP ?? '',
  })
}
