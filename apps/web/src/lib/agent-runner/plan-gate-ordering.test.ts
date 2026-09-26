/**
 * The worker's plan-approval gate inspects `tool_call` events (and the text
 * accumulated so far) and stops iterating the runner when a plan needs human
 * approval. That only works if runners:
 *   1. yield any text written alongside tool calls (typically the <plan>)
 *      BEFORE the tool_call events, and
 *   2. yield every tool_call BEFORE the corresponding tool executes —
 *      including parallel-safe batches in the OpenAI runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentEvent, TaskRunContext } from './types'

vi.mock('@/lib/system-prompts', () => ({
  getPrompt: vi.fn(async () => 'Task: {{taskTitle}}'),
  interpolate: (t: string) => t,
}))
vi.mock('@/lib/tool-registry', () => ({
  validateToolArgs: () => ({ valid: true, errors: [] }),
}))
vi.mock('@/lib/tool-permissions', () => ({
  checkToolPermission: vi.fn(async () => ({ allowed: true })),
}))
vi.mock('../db', () => ({
  prisma: {
    externalModel: {
      findFirst: vi.fn(async () => ({ baseUrl: 'http://ollama.test', timeoutSecs: 30 })),
      findUnique: vi.fn(async () => null),
    },
  },
}))

import { openaiRunner } from './openai-runner'
import { ollamaRunner } from './ollama-runner'

const PLAN = '<plan><summary>wipe it</summary><risk_level>high</risk_level></plan>'

function ctxWith(executed: string[]): TaskRunContext {
  return {
    taskId: 't1',
    taskTitle: 'title',
    taskDescription: null,
    taskPlan: null,
    agentId: 'a1',
    agentName: 'agent',
    systemPrompt: 'sys',
    modelId: 'ollama:test-model',
    gateway: null,
    managementTools: {
      definitions: [
        { name: 'orion_list_tasks', description: 'list', inputSchema: { type: 'object' } },
        { name: 'orion_list_agents', description: 'list', inputSchema: { type: 'object' } },
        { name: 'orion_delete_everything', description: 'destructive', inputSchema: { type: 'object' } },
      ],
      execute: vi.fn(async (name: string) => { executed.push(name); return `ran ${name}` }),
    },
  }
}

/** Consume events like the worker does: stop at the first tool_call if the text so far holds a high-risk plan. */
async function consumeWithGate(gen: AsyncGenerator<AgentEvent>) {
  const events: AgentEvent[] = []
  let text = ''
  for await (const ev of gen) {
    events.push(ev)
    if (ev.type === 'text') text += ev.content
    if (ev.type === 'tool_call' && /<risk_level>high<\/risk_level>/.test(text)) break
  }
  return events
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openaiRunner — plan gate sees tool calls before any tool executes', () => {
  const toolCalls = [
    { id: 'c1', type: 'function', function: { name: 'orion_list_tasks', arguments: '{}' } },
    { id: 'c2', type: 'function', function: { name: 'orion_list_agents', arguments: '{}' } },
    { id: 'c3', type: 'function', function: { name: 'orion_delete_everything', arguments: '{}' } },
  ]

  it('yields the plan text and tool_call before executing parallel-safe tools; stopping executes nothing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: PLAN, tool_calls: toolCalls } }],
    }))
    const executed: string[] = []
    const events = await consumeWithGate(openaiRunner.run(ctxWith(executed)))

    expect(events[0]).toEqual({ type: 'text', content: PLAN })
    expect(events[1]).toMatchObject({ type: 'tool_call', tool: 'orion_list_tasks' })
    expect(executed).toEqual([])
  })

  it('without a gate: all tool_calls precede their results, pairing order is preserved, and every tool runs', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls } }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      }))
    const executed: string[] = []
    const events: AgentEvent[] = []
    for await (const ev of openaiRunner.run(ctxWith(executed))) events.push(ev)

    const seq = events
      .filter(e => e.type === 'tool_call' || e.type === 'tool_result')
      .map(e => `${e.type}:${(e as { tool: string }).tool}`)
    expect(seq).toEqual([
      'tool_call:orion_list_tasks',
      'tool_call:orion_list_agents',
      'tool_result:orion_list_tasks',
      'tool_result:orion_list_agents',
      'tool_call:orion_delete_everything',
      'tool_result:orion_delete_everything',
    ])
    expect(executed.sort()).toEqual(['orion_delete_everything', 'orion_list_agents', 'orion_list_tasks'])
    // Empty content alongside tool calls is not yielded as text
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', content: 'done' }])
  })
})

describe('ollamaRunner — plan gate sees tool calls before any tool executes', () => {
  it('yields the plan text and tool_call before executing; stopping executes nothing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      message: {
        role: 'assistant',
        content: PLAN,
        tool_calls: [{ function: { name: 'orion_delete_everything', arguments: '{}' } }],
      },
      done: true,
    }))
    const executed: string[] = []
    const events = await consumeWithGate(ollamaRunner.run(ctxWith(executed)))

    expect(events[0]).toEqual({ type: 'text', content: PLAN })
    expect(events[1]).toMatchObject({ type: 'tool_call', tool: 'orion_delete_everything' })
    expect(executed).toEqual([])
  })
})
