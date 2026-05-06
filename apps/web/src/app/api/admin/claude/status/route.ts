import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import fs from 'fs'

const CREDS_PATH = '/claude-creds/.claude/.credentials.json'

export async function GET() {
  await requireAdmin()

  try {
    const raw = fs.readFileSync(CREDS_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth
    const accessToken: string | undefined = oauth?.accessToken
    const expiresAt: number | undefined = oauth?.expiresAt

    if (!accessToken) {
      return NextResponse.json({ configured: true, valid: false, reason: 'No access token found' })
    }

    const now = Date.now()
    const valid = !expiresAt || expiresAt > now

    return NextResponse.json({
      configured: true,
      valid,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      reason: valid ? null : 'Token expired',
    })
  } catch {
    return NextResponse.json({ configured: false, valid: false, reason: 'Credentials file not found' })
  }
}
