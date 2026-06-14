import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// POST /api/tool-approvals/[id]  body: { action: 'approve'|'deny', adminNote?: string, approvedBy?: string }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let admin
  try { admin = await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const resolvedApprovedBy = admin.username ?? admin.email ?? 'admin'
  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { action, adminNote } = body as { action: 'approve' | 'deny'; adminNote?: string }

  const request = await prisma.toolApprovalRequest.findUnique({ where: { id: (await params).id } })
  if (!request) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (request.status !== 'pending') return NextResponse.json({ error: 'Already resolved' }, { status: 400 })
  if (request.userId === admin.id) {
    return NextResponse.json({ error: 'Cannot approve your own tool request' }, { status: 403 })
  }

  const updated = await prisma.toolApprovalRequest.update({
    where: { id: (await params).id },
    data: {
      status:     action === 'approve' ? 'approved' : 'denied',
      approvedBy: resolvedApprovedBy,
      adminNote:  adminNote ?? null,
      resolvedAt: new Date(),
    },
  })

  // On approval: create a one-time execution grant (expires in 30 minutes)
  if (action === 'approve') {
    await prisma.toolExecutionGrant.create({
      data: {
        userId:        request.userId,
        environmentId: request.environmentId,
        toolName:      request.toolName,
        expiresAt:     new Date(Date.now() + 30 * 60 * 1000),
      },
    })
  }

  return NextResponse.json(updated)
}
