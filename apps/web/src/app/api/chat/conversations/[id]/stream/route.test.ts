/** Which model a chat is routed to when an embedding model is involved. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  convo: vi.fn(), setting: vi.fn(), model: vi.fn(), agent: vi.fn(),
  claude: vi.fn(), agentChat: vi.fn(), ollama: vi.fn(), gemini: vi.fn(), openai: vi.fn(), rag: vi.fn(),
}))
vi.mock('@/lib/db', () => ({ prisma: {
  conversation: { findUnique: m.convo }, systemSetting: { findUnique: m.setting }, externalModel: { findUnique: m.model },
  agent: { findUnique: m.agent }, message: { findMany: vi.fn(async () => []) }, environment: { findMany: vi.fn(async () => []) },
} }))
vi.mock('@/lib/conversation-owner', () => ({ assertConversationOwner: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/session-token', () => ({ getSessionToken: vi.fn(async () => ({ sub: 'u' })) }))
vi.mock('@/lib/chat-tool-policy', () => ({ getChatUserRole: vi.fn(async () => 'user'), canUseTools: () => true }))
vi.mock('@/lib/embeddings', () => ({ retrieveKnowledgeContext: m.rag }))
vi.mock('@/lib/system-prompts', () => ({ getPrompt: vi.fn(async () => '') }))
vi.mock('@/lib/claude', () => ({ streamClaudeResponse: m.claude, streamAgentChat: m.agentChat, streamOllamaChat: m.ollama, streamGeminiChat: m.gemini, streamOpenAIChat: m.openai }))

import { POST } from './route'

const providers = () => ({ claude: m.claude, agentChat: m.agentChat, ollama: m.ollama, gemini: m.gemini, openai: m.openai })
const called = () => Object.entries(providers()).filter(([, f]) => f.mock.calls.length).map(([n]) => n)
const chat = async (body: object) => {
  const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ prompt: 'hi', ...body }) }) as never, { params: Promise.resolve({ id: 'c' }) })
  return (res as Response).text()
}
const row = (provider: string, modelId: string) => m.model.mockResolvedValue({ provider, modelId, baseUrl: 'http://host' })

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  for (const f of Object.values(providers())) f.mockImplementation(async function* () { yield { type: 'done' } })
  m.convo.mockResolvedValue({ id: 'c', metadata: {} })
  m.rag.mockResolvedValue('')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a chosen embedding model', () => {
  it.each([
    ['an Ollama row', 'ollama', 'nomic-embed-text', { ollamaModel: 'ext:e' }],
    ['an OpenAI-compatible row', 'openai', 'text-embedding-3-small', { ollamaModel: 'ext:e' }],
    ['a bare Ollama name', 'ollama', '', { ollamaModel: 'nomic-embed-text' }],
    ['an ollama: name', 'ollama', '', { ollamaModel: 'ollama:nomic-embed-text' }],
  ])('is refused, not replaced: %s', async (_n, provider, modelId, body) => {
    row(provider, modelId)
    expect(await chat(body)).toContain("can't chat")
    expect(called()).toEqual([])
    expect(m.rag).not.toHaveBeenCalled()
  })
  it('is refused as a saved plan model', async () => {
    m.convo.mockResolvedValue({ id: 'c', metadata: { planModel: 'ext:e' } })
    row('ollama', 'nomic-embed-text')
    expect(await chat({})).toContain("can't chat")
    expect(called()).toEqual([])
  })
  it('does not matter to a chat with an agent, which uses its own model', async () => {
    m.convo.mockResolvedValue({ id: 'c', metadata: { agentChat: { id: 'a', name: 'A' } } })
    m.agent.mockResolvedValue({ name: 'A', metadata: {} })
    row('ollama', 'nomic-embed-text')
    await chat({ ollamaModel: 'ext:e' })
    expect(called()).toEqual(['agentChat'])
  })
})

describe('other choices', () => {
  it('a chat model is used', async () => {
    row('ollama', 'llama3.1:8b')
    await chat({ ollamaModel: 'ext:m' })
    expect(called()).toEqual(['ollama'])
  })
  it('a default that is an embedding model counts as unset', async () => {
    m.setting.mockResolvedValue({ value: 'ext:e' })
    row('ollama', 'nomic-embed-text')
    await chat({})
    expect(called()).toEqual(['claude'])
  })
})
