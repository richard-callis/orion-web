import { NextRequest, NextResponse } from 'next/server'
import { compare } from 'bcryptjs'
import { SignJWT } from 'jose'
import { prisma } from '@/lib/db'

export async function POST(req: NextRequest) {
  const { token } = await req.json()

  if (!token) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 })
  }

  // Ensure setup is not already complete
  const completed = await prisma.systemSetting.findUnique({
    where: { key: 'setup.completed' },
  })
  if (completed?.value === true) {
    return NextResponse.json({ error: 'Setup already completed' }, { status: 409 })
  }

  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'setup.token' },
  })
  if (!setting) {
    return NextResponse.json({ error: 'Setup token not found' }, { status: 404 })
  }

  const valid = await compare(token, setting.value as string)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid setup token' }, { status: 401 })
  }

  // Issue short-lived wizard session JWT (1 hour).
  // NEXTAUTH_SECRET must be set — 'fallback-secret' would produce forgeable wizard
  // tokens that grant full setup access to anyone who knows the hardcoded value.
  const nextAuthSecret = process.env.NEXTAUTH_SECRET
  if (!nextAuthSecret) {
    return NextResponse.json({ error: 'Server misconfiguration: NEXTAUTH_SECRET is not set' }, { status: 500 })
  }
  const secret = new TextEncoder().encode(nextAuthSecret)
  const wizardJwt = await new SignJWT({ wizard: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(secret)

  const res = NextResponse.json({ ok: true })
  res.cookies.set('__orion_wizard', wizardJwt, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/setup',
    maxAge: 3600,
  })
  return res
}
