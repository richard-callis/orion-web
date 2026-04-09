import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

const PUBLIC_PATHS = [
  '/setup',
  '/login',
  '/api/setup',
  '/api/auth',
  '/api/health',
  '/api/environments/join', // gateway registration — no session, token IS the auth
  '/_next',
  '/favicon.ico',
]

// API routes that gateways call with Bearer tokens — middleware passes through,
// route handlers validate the token themselves
const BEARER_PATHS = [
  '/api/environments',
]

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Gateway calls use Bearer token auth — let them through, routes handle validation
  if (
    BEARER_PATHS.some(p => pathname.startsWith(p)) &&
    req.headers.get('authorization')?.startsWith('Bearer ')
  ) {
    return NextResponse.next()
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token || !token.sub) {
    const loginUrl = new URL('/login', req.url)
    loginUrl.searchParams.set('callbackUrl', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
