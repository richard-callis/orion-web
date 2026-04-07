import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export interface AppModel {
  id: string        // "claude" | "ollama:llama3.2:3b" | "ext:<cuid>"
  name: string
  provider: string  // "anthropic" | "ollama" | "openai" | "custom"
  builtIn: boolean
  modelId: string
  baseUrl?: string
  enabled: boolean
}

const GEMINI_MODELS: AppModel[] = [
  { id: 'gemini:gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', builtIn: true, modelId: 'gemini-2.0-flash', enabled: true },
  { id: 'gemini:gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', builtIn: true, modelId: 'gemini-2.5-pro-preview-03-25', enabled: true },
  { id: 'gemini:gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'google', builtIn: true, modelId: 'gemini-1.5-pro', enabled: true },
]

const CLAUDE_MODELS: AppModel[] = [
  { id: 'claude:claude-haiku-4-5-20251001', name: 'Claude Haiku', provider: 'anthropic', builtIn: true, modelId: 'claude-haiku-4-5-20251001', enabled: true },
  { id: 'claude:claude-sonnet-4-6',         name: 'Claude Sonnet', provider: 'anthropic', builtIn: true, modelId: 'claude-sonnet-4-6',         enabled: true },
  { id: 'claude:claude-opus-4-6',           name: 'Claude Opus',   provider: 'anthropic', builtIn: true, modelId: 'claude-opus-4-6',           enabled: true },
]

const BUILT_IN_MODELS: AppModel[] = [
  ...CLAUDE_MODELS,
  ...(process.env.GEMINI_API_KEY ? GEMINI_MODELS : []),
]

export async function GET() {
  const external = await prisma.externalModel.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } })
  const extMapped: AppModel[] = external.map(m => ({
    id: `ext:${m.id}`,
    name: m.name,
    provider: m.provider,
    builtIn: false,
    modelId: m.modelId,
    baseUrl: m.baseUrl ?? undefined,
    enabled: m.enabled,
  }))
  return NextResponse.json([...BUILT_IN_MODELS, ...extMapped])
}
