import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  await requireServiceAuth(req)

  let body: {
    title?: string
    prompt?: string
    expectedOutput?: string | null
    assertions?: Array<{ type: string; value: string; weight?: number }>
    weight?: number
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const evalCase = await prisma.evalCase.update({
    where: { id: (await params).caseId },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.prompt !== undefined && { prompt: body.prompt }),
      ...(body.expectedOutput !== undefined && { expectedOutput: body.expectedOutput }),
      ...(body.assertions !== undefined && { assertions: JSON.stringify(body.assertions) }),
      ...(body.weight !== undefined && { weight: body.weight }),
    },
  })

  return NextResponse.json(evalCase)
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  await requireServiceAuth(req)

  await prisma.evalCase.delete({ where: { id: (await params).caseId } })
  return NextResponse.json({ ok: true })
}
