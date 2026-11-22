import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { prisma, completeOnce, embedNote, recordTokenUsage } = vi.hoisted(() => ({
  prisma: {
    systemSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    note: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    externalModel: { findUnique: vi.fn() },
    agent: { findUnique: vi.fn() },
    agentKnowledge: { create: vi.fn() },
  },
  completeOnce: vi.fn(),
  embedNote: vi.fn(),
  recordTokenUsage: vi.fn(),
}))
vi.mock('./db', () => ({ prisma }))
vi.mock('./embeddings', () => ({ embedNote, computeSemanticEdges: vi.fn(async () => {}), embedSkill: vi.fn(), hybridSearch: vi.fn() }))
vi.mock('./token-budget', async (orig) => ({ ...(await orig<object>()), recordTokenUsage }))
vi.mock('./default-model', () => ({ getDefaultModelId: async () => 'm1' }))
vi.mock('./agent-runner/engine/complete', async (orig) => ({ ...(await orig<object>()), completeOnce }))

import { runSynthesis } from './dream'
import { SYNTHESIS_MAX_NEW_HUBS, SYNTHESIS_MAX_TOKENS } from './dream-synthesis'

const notes = (n: number, folder = 'A') => Array.from({ length: n }, (_, i) => ({ title: `${folder} ${i}`, folder, tags: ['dream'], content: '' }))
const reply = (hubs: unknown[], extra = {}) => ({ text: JSON.stringify({ hubs }), inputTokens: 1, outputTokens: 1, ...extra })
const hub = (title: string, members = ['A 0', 'A 1']) => ({ title, overview: 'o', notes: members, folder: 'GitOps' })
const advanced = () => prisma.systemSetting.upsert.mock.calls.some(c => JSON.stringify(c).includes('dream.synthesisLastRun'))

beforeEach(() => {
  for (const group of Object.values(prisma)) for (const f of Object.values(group)) f.mockReset()
  completeOnce.mockReset()
  embedNote.mockReset().mockResolvedValue(false)
  prisma.systemSetting.findUnique.mockResolvedValue(null)
  prisma.systemSetting.upsert.mockResolvedValue({})
  recordTokenUsage.mockReset()
  prisma.agent.findUnique.mockResolvedValue({ id: 'dream' })
  prisma.externalModel.findUnique.mockResolvedValue({ id: 'm1', provider: 'custom', baseUrl: 'http://llm', modelId: 'q', timeoutSecs: 120 })
  prisma.note.findMany.mockResolvedValue(notes(10))
  prisma.note.findFirst.mockResolvedValue(null)
  prisma.note.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'n', ...data }))
  prisma.note.update.mockImplementation(async ({ data }: { data: object }) => ({ id: 'n', ...data }))
  for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('runSynthesis', () => {
  it('asks per batch without reasoning and with a token limit, and creates the hubs', async () => {
    prisma.note.findMany.mockResolvedValue(notes(130))
    completeOnce.mockResolvedValueOnce(reply([hub('H1')])).mockResolvedValueOnce(reply([]))
    await runSynthesis()
    expect(completeOnce).toHaveBeenCalledTimes(2)
    expect(completeOnce.mock.calls[0][2]).toMatchObject({ maxTokens: SYNTHESIS_MAX_TOKENS, extraBody: { chat_template_kwargs: { enable_thinking: false } } })
    expect(completeOnce.mock.calls[1][1]).toContain('- H1\n') // the second batch knows the new hub
    expect(prisma.note.create).toHaveBeenCalledWith({ data: expect.objectContaining({ title: 'H1', tags: ['dream', 'hub'] }) })
    expect(advanced()).toBe(true)
  })

  // Answers like the database would: by the tags the lookup asked for.
  const stored = (rows: Array<{ id: string; title: string; tags: string[]; content: string }>) =>
    prisma.note.findFirst.mockImplementation(async ({ where }: { where: { title: string; tags: { array_contains: string[] } } }) =>
      rows.find(r => r.title === where.title && where.tags.array_contains.every(t => r.tags.includes(t))) ?? null)

  it('extends an existing hub instead of replacing it, and offers it to the model', async () => {
    const h1 = { id: 'h', title: 'H1', folder: 'A', tags: ['dream', 'hub'], content: 'Old\n- [[A 0]]\n- [[Z]]' }
    prisma.note.findMany.mockResolvedValue([...notes(10), h1])
    stored([h1])
    completeOnce.mockResolvedValue(reply([hub('H1', ['A 1'])]))
    await runSynthesis()
    expect(completeOnce.mock.calls[0][1]).toContain('EXISTING HUB NOTES:\n- H1')
    expect(prisma.note.update.mock.calls[0][0]).toMatchObject({ where: { id: 'h' }, data: { content: 'Old\n- [[A 0]]\n- [[Z]]\n- [[A 1]]' } })
    expect(prisma.note.create).not.toHaveBeenCalled()
  })

  it('extends the hub when a specific dream note has the same title', async () => {
    stored([{ id: 'x', title: 'H1', tags: ['dream'], content: 'specific' }, { id: 'h', title: 'H1', tags: ['dream', 'hub'], content: 'Old' }])
    completeOnce.mockResolvedValue(reply([hub('H1')]))
    await runSynthesis()
    expect(prisma.note.update.mock.calls[0][0].where).toEqual({ id: 'h' })
  })

  it('never touches a specific dream note, or a human note, that shares the title', async () => {
    stored([{ id: 'x', title: 'H1', tags: ['dream'], content: 'specific' }, { id: 'p', title: 'H2', tags: ['hub'], content: 'human' }])
    completeOnce.mockResolvedValue(reply([hub('H1'), hub('H2')]))
    await runSynthesis()
    expect(prisma.note.update).not.toHaveBeenCalled()
    expect(prisma.note.create.mock.calls.map(c => c[0].data.title)).toEqual(['H2']) // a new note, the human one untouched
  })

  it('does not offer a human hub for extension', async () => {
    prisma.note.findMany.mockResolvedValue([...notes(6), { title: 'Human hub', folder: 'A', tags: ['hub'], content: '' }])
    completeOnce.mockResolvedValue(reply([]))
    await runSynthesis()
    expect(completeOnce.mock.calls[0][1]).not.toContain('Human hub')
  })

  it('does not offer a refused title to the next batch', async () => {
    prisma.note.findMany.mockResolvedValue(notes(130))
    stored([{ id: 'x', title: 'Specific', tags: ['dream'], content: 'specific' }])
    completeOnce.mockResolvedValueOnce(reply([hub('Specific'), hub('H2')])).mockResolvedValueOnce(reply([]))
    await runSynthesis()
    expect(completeOnce.mock.calls[1][1]).toContain('- H2\n')
    expect(completeOnce.mock.calls[1][1]).not.toContain('- Specific')
  })

  it('counts failed calls in a row, so an answer in between lets the run go on', async () => {
    prisma.note.findMany.mockResolvedValue(notes(600))
    completeOnce
      .mockRejectedValueOnce(new Error('t')).mockResolvedValueOnce(reply([]))
      .mockRejectedValueOnce(new Error('t')).mockResolvedValueOnce(reply([])).mockResolvedValueOnce(reply([]))
    await runSynthesis()
    expect(completeOnce).toHaveBeenCalledTimes(5)
    expect(advanced()).toBe(true)
  })

  it('stops at the cap on new hubs', async () => {
    prisma.note.findMany.mockResolvedValue(notes(600))
    let n = 0
    completeOnce.mockImplementation(async (_t: unknown, prompt: string) => {
      const members = [...prompt.matchAll(/^- (A \d+)$/gm)].slice(0, 2).map(m => m[1])
      return reply(Array.from({ length: 5 }, () => hub(`H${n++}`, members)))
    })
    await runSynthesis()
    expect(prisma.note.create).toHaveBeenCalledTimes(SYNTHESIS_MAX_NEW_HUBS)
    expect(completeOnce).toHaveBeenCalledTimes(2)
    expect(advanced()).toBe(true)
  })

  it('keeps going past a failed, cut-off or unparseable batch, and records usage of every answer', async () => {
    prisma.note.findMany.mockResolvedValue(notes(490))
    completeOnce
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(reply([], { truncated: true, reasoning: 'half a thought' }))
      .mockResolvedValueOnce({ text: 'No hubs are missing.', inputTokens: 1, outputTokens: 1 })
      .mockResolvedValueOnce(reply([]))
      .mockResolvedValueOnce(reply([hub('H1', ['A 480', 'A 481'])]))
    await runSynthesis()
    expect(prisma.note.create).toHaveBeenCalledTimes(1)
    expect(recordTokenUsage).toHaveBeenCalledTimes(4)
    expect(prisma.agentKnowledge.create).not.toHaveBeenCalled() // a cut-off trace is not training data
    expect(advanced()).toBe(true)
  })

  it('stops after two failed calls, and fails the run when the model never answered', async () => {
    prisma.note.findMany.mockResolvedValue(notes(600))
    completeOnce.mockRejectedValue(new Error('timeout'))
    await expect(runSynthesis()).rejects.toThrow('timeout')
    expect(completeOnce).toHaveBeenCalledTimes(2)
    expect(advanced()).toBe(false)
  })

  it('consumes the run when every answer is unusable (asking again would cost the same)', async () => {
    completeOnce.mockResolvedValue(reply([], { truncated: true }))
    await runSynthesis()
    expect(advanced()).toBe(true)
  })

  it('counts a hub whose embedding failed', async () => {
    embedNote.mockRejectedValue(new Error('ollama down'))
    completeOnce.mockResolvedValue(reply([hub('H1')]))
    await runSynthesis()
    expect(prisma.note.create).toHaveBeenCalledTimes(1)
    expect(advanced()).toBe(true)
  })

  it('passes the options to a different fallback model', async () => {
    prisma.systemSetting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => where.key === 'dream.model' ? { value: 'other' } : null)
    completeOnce.mockRejectedValueOnce(new Error('down')).mockResolvedValue(reply([]))
    await runSynthesis()
    expect(completeOnce.mock.calls[1][2]).toMatchObject({ maxTokens: SYNTHESIS_MAX_TOKENS })
  })

  it('finishes without a call when every note is already linked', async () => {
    const n = notes(6)
    prisma.note.findMany.mockResolvedValue([...n, { title: 'Hub', folder: 'A', tags: ['dream', 'hub'], content: n.map(x => `[[${x.title}]]`).join('\n') }])
    await runSynthesis()
    expect(completeOnce).not.toHaveBeenCalled()
    expect(advanced()).toBe(true)
  })
})
