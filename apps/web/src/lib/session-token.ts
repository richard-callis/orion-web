/**
 * Single place that decodes the next-auth session JWT from a request.
 *
 * Always pass the same `secret` and `cookieName` the auth config uses. Without
 * `cookieName`, next-auth infers the cookie from NEXTAUTH_URL's scheme, so a
 * mismatch (e.g. an http URL while the app sets the `__Secure-` cookie) made
 * some routes 401 while the proxy — which did pass it — let the request through.
 */
import { getToken, type JWT } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE_NAME } from './auth-constants'

export function getSessionToken(req: NextRequest): Promise<JWT | null> {
  return getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: SESSION_COOKIE_NAME })
}
