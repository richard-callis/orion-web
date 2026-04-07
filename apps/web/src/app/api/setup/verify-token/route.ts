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

  // Issue short-lived wizard session JWT (1 hour)
  const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET ?? 'fallback-secret')
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
