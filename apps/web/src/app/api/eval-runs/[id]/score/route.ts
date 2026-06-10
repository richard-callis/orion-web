import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

type AssertionDef = {
  type: 'contains_text' | 'not_contains_text' | 'regex_match' | 'llm_judge'
  value: string
  weight?: number
}

type AssertionResult = AssertionDef & { passed: boolean; score: number; reason?: string }

async function scoreAssertion(
  assertion: AssertionDef,
  output: string,
  expectedOutput: string | null
): Promise<AssertionResult> {
  const out = output ?? ''

  switch (assertion.type) {
    case 'contains_text': {
      const passed = out.toLowerCase().includes(assertion.value.toLowerCase())
      return { ...assertion, passed, score: passed ? 1 : 0 }
    }
    case 'not_contains_text': {
      const passed = !out.toLowerCase().includes(assertion.value.toLowerCase())
      return { ...assertion, passed, score: passed ? 1 : 0 }
    }
    case 'regex_match': {
      let passed = false
      try {
        passed = new RegExp(assertion.value, 'i').test(out)
      } catch {
        passed = false
      }
      return { ...assertion, passed, score: passed ? 1 : 0 }
    }
    case 'llm_judge': {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) {
        return { ...assertion, passed: false, score: 0, reason: 'No ANTHROPIC_API_KEY configured' }
      }

      try {
        const prompt = `You are evaluating an AI agent's response.
Expected behavior: ${expectedOutput ?? assertion.value}
Actual output: ${out}

Does the response satisfy the expected behavior? Respond with JSON only:
{"passed": boolean, "score": number (0-100), "reason": string}`

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5',
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
          }),
        })

        const data = await res.json() as { content?: Array<{ text?: string }> }
        const text = data.content?.[0]?.text ?? '{}'
        const parsed = JSON.parse(text) as { passed?: boolean; score?: number; reason?: string }

        return {
          ...assertion,
          passed: !!parsed.passed,
          score: typeof parsed.score === 'number' ? parsed.score / 100 : (parsed.passed ? 1 : 0),
          reason: parsed.reason,
        }
      } catch (err) {
        return { ...assertion, passed: false, score: 0, reason: String(err) }
      }
    }
    default:
      return { ...assertion, passed: false, score: 0, reason: 'Unknown assertion type' }
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  await requireServiceAuth(req)

  const run = await prisma.evalRun.findUnique({
    where: { id: params.id },
    include: {
      results: {
        include: { case: true },
      },
    },
  })

  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  type RunResult = (typeof run.results)[number]
  const pendingResults = run.results.filter((r: RunResult) => r.taskId && r.score === null)

  for (const result of pendingResults) {
    const startedAt = Date.now()

    // Fetch task output
    let output = ''
    if (result.taskId) {
      const task = await prisma.task.findUnique({
        where: { id: result.taskId },
        include: {
          events: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      })

      if (task) {
        // Try to get output from events
        type TaskEvent = (typeof task.events)[number]
        const outputEvent = task.events.find((e: TaskEvent) =>
          e.eventType === 'output' || e.eventType === 'completed'
        )
        output = outputEvent?.content ?? task.events.find((e: TaskEvent) => e.content)?.content ?? ''
      }
    }

    if (!output) {
      // Task not yet complete — skip this result
      continue
    }

    // Parse assertions from the case
    let assertions: AssertionDef[] = []
    try {
      assertions = JSON.parse(result.case.assertions) as AssertionDef[]
    } catch {
      assertions = []
    }

    // Score each assertion
    const assertionResults: AssertionResult[] = await Promise.all(
      assertions.map(a => scoreAssertion(a, output, result.case.expectedOutput ?? null))
    )

    // Calculate weighted score
    const totalWeight = assertionResults.reduce((sum, a) => sum + (a.weight ?? 1), 0)
    const weightedScore =
      totalWeight > 0
        ? assertionResults.reduce((sum, a) => sum + a.score * (a.weight ?? 1), 0) / totalWeight
        : 0

    const passed = assertionResults.every(a => a.passed)
    const judgeResult = assertionResults.find(a => a.type === 'llm_judge')

    await prisma.evalCaseResult.update({
      where: { id: result.id },
      data: {
        output,
        passed,
        score: weightedScore * 100,
        assertions: JSON.stringify(assertionResults),
        judgeReason: judgeResult?.reason ?? null,
        durationMs: Date.now() - startedAt,
      },
    })
  }

  // Check if all results are scored
  const allResults = await prisma.evalCaseResult.findMany({
    where: { runId: params.id },
  })

  type CaseResult = (typeof allResults)[number]
  const scoredResults = allResults.filter((r: CaseResult) => r.score !== null)
  const allScored = scoredResults.length === allResults.length

  if (allScored && allResults.length > 0) {
    // Get the eval cases to get weights
    const caseIds = allResults.map((r: CaseResult) => r.caseId)
    const cases = await prisma.evalCase.findMany({
      where: { id: { in: caseIds } },
      select: { id: true, weight: true },
    })
    const caseWeightMap = new Map(cases.map((c: { id: string; weight: number }) => [c.id, c.weight]))

    const totalWeight = allResults.reduce((sum: number, r: CaseResult) => sum + Number(caseWeightMap.get(r.caseId) ?? 1), 0)
    const scoreTotal =
      totalWeight > 0
        ? allResults.reduce((sum: number, r: CaseResult) => sum + (r.score ?? 0) * Number(caseWeightMap.get(r.caseId) ?? 1), 0) / totalWeight
        : 0

    const passCount = allResults.filter((r: CaseResult) => r.passed === true).length
    const failCount = allResults.filter((r: CaseResult) => r.passed === false).length

    await prisma.evalRun.update({
      where: { id: params.id },
      data: {
        status: 'completed',
        scoreTotal,
        passCount,
        failCount,
        completedAt: new Date(),
      },
    })
  }

  return NextResponse.json({ ok: true, scored: scoredResults.length, total: allResults.length })
}
