import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { randomBytes } from 'crypto'
import { requireAdmin } from '@/lib/auth'
import { encrypt } from '@/lib/encryption'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  const existing = await prisma.webhookTrigger.findUnique({ where: { id } })
  if (!existing) return new NextResponse(null, { status: 404 })

  const secret = randomBytes(32).toString('hex')
  const secretToStore = process.env.ORION_ENCRYPTION_KEY ? encrypt(secret) : secret
  await prisma.webhookTrigger.update({ where: { id }, data: { secret: secretToStore } })

  // Return the plaintext secret — this is the only time it is shown in full
  return NextResponse.json({ secret })
}
