import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

const PUBLIC_PATHS = [
  '/setup',
  '/login',
  '/api/setup',
  '/api/auth',
  '/api/health',
  '/_next',
  '/favicon.ico',
]

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Always allow public paths
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Fast path: setup-done cookie set by /api/setup/complete
  const setupDone = req.cookies.get('__orion_setup_done')?.value === '1'

  if (!setupDone) {
    try {
      const statusUrl = new URL('/api/setup/status', req.url)
      const res = await fetch(statusUrl, { cache: 'no-store' })
      const data = await res.json()
      if (!data.completed) {
        return NextResponse.redirect(new URL('/setup', req.url))
      }
    } catch {
      // DB unreachable — fail open to avoid lockout on transient errors
      return NextResponse.next()
    }
  }

  // Require authenticated session
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', req.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
