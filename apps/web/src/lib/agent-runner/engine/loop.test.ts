/**
 * Unit tests for the shared tool loop against a scripted in-memory provider.
 */
import { describe, it, expect, vi } from 'vitest'
import { runToolLoop, trimHistory, type LoopEvent, type LoopUsage } from './loop'
import { RunTokenCap } from '../../llm-budget'
import type { ChatProvider, EngineMessage, TurnEvent, TurnResult, TurnRequest } from './types'

vi.mock('@/lib/db', () => ({ prisma: {} }))

function scripted(turns: Array<TurnResult | { deltas: string[]; result: TurnResult } | Error>): ChatProvider & { requests: TurnRequest[] } {
  const requests: TurnRequest[] = []
  let i = 0
  return {
    requests,
    async *turn(req): AsyncGenerator<TurnEvent> {
      requests.push({ ...req, messages: [...req.messages] })
      const t = turns[i++]
      if (!t) throw new Error('script exhausted')
      if (t instanceof Error) throw t
      if ('deltas' in t) {
        for (const d of t.deltas) yield { type: 'delta', text: d }
        yield { type: 'end', result: t.result }
      } else {
        yield { type: 'end', result: t }
      }
    },
  }
}

const call = (id: string, name: string, argsRaw = '{}') => ({ id, name, argsRaw })
async function drain(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}
const base = (): EngineMessage[] => [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]

describe('runToolLoop', () => {
  it('parallel batch: every call announced before any runs; results in order; steps numbered in run order', async () => {
    const order: string[] = []
    const provider = scripted([
      { text: 'plan', toolCalls: [call('a', 'read1'), call('b', 'write1'), call('c', 'read2')] },
      { text: 'done', toolCalls: [] },
    ])
    const steps: Array<[string, number]> = []
    const events = await drain(runToolLoop({
      provider, messages: base(), tools: [], maxTurns: 5, emitTextWithToolCalls: true,
      parallelSafe: n => n.startsWith('read'),
      hooks: {
        runTool: async (c, step) => { order.push(`run:${c.name}`); steps.push([c.name, step]); return `r:${c.name}` },
        beforeToolCall: c => { order.push(`announce:${c.name}`) },
      },
    }))
    expect(events.map(e => e.type === 'tool_call' || e.type === 'tool_result' ? `${e.type}:${e.tool}` : e.type)).toEqual([
      'text', 'tool_call:read1', 'tool_call:read2', 'tool_result:read1', 'tool_result:read2',
      'tool_call:write1', 'tool_result:write1', 'text', 'end',
    ])
    expect(order.slice(0, 2)).toEqual(['announce:read1', 'announce:read2'])
    expect(steps).toEqual([['read1', 1], ['read2', 2], ['write1', 3]])
  })

  it('a consumer that stops at a tool_call prevents the whole parallel batch from running', async () => {
    const ran: string[] = []
    const gen = runToolLoop({
      provider: scripted([{ text: null, toolCalls: [call('a', 'r1'), call('b', 'r2')] }]),
      messages: base(), tools: [], maxTurns: 3, parallelSafe: () => true,
      hooks: { runTool: async c => { ran.push(c.name); return '' } },
    })
    for await (const ev of gen) if (ev.type === 'tool_call') break
    expect(ran).toEqual([])
  })

  it('step numbers count every call, including ones a hook denies (matches the worker checkpoint index)', async () => {
    const steps: number[] = []
    await drain(runToolLoop({
      provider: scripted([
        { text: null, toolCalls: [call('a', 'denied')] },
        { text: null, toolCalls: [call('b', 'ok')] },
        { text: 'fin', toolCalls: [] },
      ]),
      messages: base(), tools: [], maxTurns: 5,
      hooks: { runTool: async (c, step) => { steps.push(step); return c.name === 'denied' ? 'Permission denied' : 'ok' } },
    }))
    expect(steps).toEqual([1, 2])
  })

  it('history: assistant tool turn then tool results (with names when asked)', async () => {
    const messages = base()
    await drain(runToolLoop({
      provider: scripted([{ text: null, toolCalls: [call('x', 't')] }, { text: 'k', toolCalls: [] }]),
      messages, tools: [], maxTurns: 3, toolMessageName: true, assistantContent: t => t,
      hooks: { runTool: async () => 'R' },
    }))
    expect(messages.slice(2)).toEqual([
      { role: 'assistant', content: null, toolCalls: [call('x', 't')] },
      { role: 'tool', content: 'R', toolCallId: 'x', name: 't' },
    ])
  })

  it('streamed deltas are yielded as text and not repeated at the end', async () => {
    const events = await drain(runToolLoop({
      provider: scripted([{ deltas: ['a', 'b'], result: { text: 'ab', toolCalls: [] } }]),
      messages: base(), tools: [], maxTurns: 1, hooks: { runTool: async () => '' },
    }))
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }])
  })

  it('reviewFinal can reject a reply and burn a turn', async () => {
    const messages = base()
    const events = await drain(runToolLoop({
      provider: scripted([{ text: 'fake_tool', toolCalls: [] }, { text: 'real', toolCalls: [] }]),
      messages, tools: [], maxTurns: 3,
      hooks: { runTool: async () => '', reviewFinal: t => t === 'fake_tool' ? { assistant: t, user: 'use tool_calls' } : null },
    }))
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'final', finalText: 'real' })
    expect(messages.slice(2)).toEqual([{ role: 'assistant', content: 'fake_tool' }, { role: 'user', content: 'use tool_calls' }])
  })

  it('toolCallsRequireFinishReason: tool calls without finish_reason tool_calls are a final reply', async () => {
    const runTool = vi.fn(async () => '')
    const events = await drain(runToolLoop({
      provider: scripted([{ text: 'hi', toolCalls: [call('a', 't')], finishReason: 'stop' }]),
      messages: base(), tools: [], maxTurns: 2, toolCallsRequireFinishReason: true, hooks: { runTool },
    }))
    expect(runTool).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({ reason: 'final', finalText: 'hi' })
  })

  it('run token cap ends the loop before the next turn', async () => {
    const cap = new RunTokenCap(10)
    const provider = scripted([{ text: null, toolCalls: [call('a', 't')], usage: { inputTokens: 8, outputTokens: 4 } }])
    const events = await drain(runToolLoop({
      provider, messages: base(), tools: [], maxTurns: 5,
      runCap: { cap, after: r => (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0) },
      hooks: { runTool: async () => '' },
    }))
    expect(provider.requests).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'cap' })
  })

  it('max turns exhausted → reason max_turns; usage summed and kept in the sink', async () => {
    const usage: LoopUsage = { inputTokens: 0, outputTokens: 0, reported: false }
    const events = await drain(runToolLoop({
      provider: scripted([
        { text: null, toolCalls: [call('a', 't')], usage: { inputTokens: 3, outputTokens: 1 } },
        { text: null, toolCalls: [call('b', 't')], usage: { inputTokens: 5, outputTokens: 2 } },
      ]),
      messages: base(), tools: [], maxTurns: 2, usage, hooks: { runTool: async () => '' },
    }))
    expect(events.at(-1)).toMatchObject({ type: 'end', reason: 'max_turns' })
    expect(usage).toEqual({ inputTokens: 8, outputTokens: 3, reported: true, lastInputTokens: 5 })
  })

  it('usage sink survives a provider error mid-run', async () => {
    const usage: LoopUsage = { inputTokens: 0, outputTokens: 0, reported: false }
    await expect(drain(runToolLoop({
      provider: scripted([{ text: null, toolCalls: [call('a', 't')], usage: { inputTokens: 4, outputTokens: 1 } }, new Error('HTTP 500')]),
      messages: base(), tools: [], maxTurns: 3, usage, hooks: { runTool: async () => '' },
    }))).rejects.toThrow('HTTP 500')
    expect(usage.inputTokens).toBe(4)
  })

  it('an aborted signal stops before the next model call', async () => {
    const ac = new AbortController(); ac.abort()
    const provider = scripted([{ text: 'x', toolCalls: [] }])
    await expect(drain(runToolLoop({ provider, messages: base(), tools: [], maxTurns: 1, signal: ac.signal, hooks: { runTool: async () => '' } })))
      .rejects.toThrow('Run cancelled by caller')
    expect(provider.requests).toHaveLength(0)
  })

  it('an empty provider response ends the run with no text', async () => {
    const events = await drain(runToolLoop({
      provider: scripted([{ text: null, toolCalls: [], empty: true }]),
      messages: base(), tools: [], maxTurns: 2, hooks: { runTool: async () => '' },
    }))
    expect(events).toEqual([{ type: 'end', reason: 'final', finalText: null, empty: true, usage: { inputTokens: 0, outputTokens: 0, reported: false } }])
  })
})

describe('trimHistory', () => {
  it('keeps the first 2 and last 20 of a long run with a notice', () => {
    const msgs: EngineMessage[] = Array.from({ length: 45 }, (_, i) => ({ role: 'user', content: String(i) }))
    const t = trimHistory(msgs)
    expect(t).toHaveLength(23)
    expect(t[2]).toEqual({ role: 'system', content: '[23 earlier messages trimmed to stay within context limits. Task is still in progress.]' })
    expect(t.at(-1)!.content).toBe('44')
    expect(trimHistory(msgs.slice(0, 40))).toHaveLength(40)
  })
})
