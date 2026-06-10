import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const cases = await prisma.evalCase.findMany({
    where: { suiteId: params.id },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(cases)
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  let body: {
    title: string
    prompt: string
    expectedOutput?: string
    assertions: Array<{ type: string; value: string; weight?: number }>
    weight?: number
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.title || !body.prompt || !body.assertions) {
    return NextResponse.json({ error: 'title, prompt, and assertions are required' }, { status: 400 })
  }

  const evalCase = await prisma.evalCase.create({
    data: {
      suiteId: params.id,
      title: body.title,
      prompt: body.prompt,
      expectedOutput: body.expectedOutput ?? null,
      assertions: JSON.stringify(body.assertions),
      weight: body.weight ?? 1,
    },
  })

  return NextResponse.json(evalCase, { status: 201 })
}
