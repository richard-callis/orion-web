/**
 * POST /api/monitoring/security/investigations/[id]/observables
 *
 * Add an observable to an investigation.
 */

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { recordAudit } from '../../_utils'

export const dynamic = 'force-dynamic'

const createSchema = z.object({
  value: z.string().min(1),
  displayValue: z.string().optional(),
  category: z.enum(['ipv4', 'ipv6', 'domain', 'url', 'file_hash_md5', 'file_hash_sha1', 'file_hash_sha256', 'mac_address', 'email', 'username', 'file_path', 'registry_key', 'mutex', 'asn']),
  role: z.enum(['ioc', 'artifact', 'infrastructure']).default('ioc'),
  verdict: z.enum(['malicious', 'suspicious', 'benign', 'unknown']).default('unknown'),
  confidence: z.number().int().min(0).max(100).default(0),
  severity: z.number().int().min(0).max(100).default(0),
  context: z.string().optional().nullable(),
})

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try { await requireAdmin() } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const id = (await params).id
  const body = createSchema.safeParse(await req.json())
  if (!body.success) {
    return NextResponse.json({ error: body.error.errors }, { status: 400 })
  }

  const { value, displayValue, category, role, verdict, confidence, severity, context } = body.data
  const actor = (body.data as any)._actor ?? 'admin'

  // Warden cannot set malicious verdict with confidence < 80
  if (actor === 'warden' && verdict === 'malicious' && confidence < 80) {
    return NextResponse.json(
      { error: 'Warden requires confidence >= 80 to set malicious verdict' },
      { status: 403 },
    )
  }

  const investigation = await prisma.investigation.findUnique({ where: { id } })
  if (!investigation) {
    return NextResponse.json({ error: 'Investigation not found' }, { status: 404 })
  }

  const observable = await prisma.investigationObservable.upsert({
    where: { investigationId_value_category: { investigationId: id, value, category } },
    create: {
      investigationId: id,
      value,
      displayValue: displayValue ?? value,
      category, role, verdict, confidence, severity, context,
      verdictBy: verdict !== 'unknown' ? actor : undefined,
      verdictAt: verdict !== 'unknown' ? new Date() : undefined,
    },
    update: {
      lastSeen: new Date(),
      confidence: Math.max(confidence, severity),
      context: context ?? undefined,
    },
  })

  await recordAudit(id, actor, actor === 'warden' ? 'warden' : 'human', 'observable_added',
    undefined, { observableId: observable.id })

  await prisma.investigationTimeline.create({
    data: {
      investigationId: id, eventTime: new Date(),
      eventType: 'observable_added',
      title: `Observable added: ${value}`,
      source: actor === 'warden' ? 'warden' : 'manual',
    },
  })

  return NextResponse.json(observable, { status: 201 })
}
