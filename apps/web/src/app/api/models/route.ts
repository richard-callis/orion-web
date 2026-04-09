import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export const dynamic = 'force-dynamic'

export interface AppModel {
  id: string        // "claude:claude-sonnet-4-6" | "gemini:..." | "ext:<cuid>"
  name: string
  provider: string  // "anthropic" | "ollama" | "openai" | "google" | "custom"
  builtIn: boolean
  modelId: string
  baseUrl?: string
  enabled: boolean
  isDefault: boolean
}

const GEMINI_MODELS = (isDefault: (id: string) => boolean): AppModel[] => [
  { id: 'gemini:gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google', builtIn: true, modelId: 'gemini-2.0-flash', enabled: true, isDefault: isDefault('gemini:gemini-2.0-flash') },
  { id: 'gemini:gemini-2.5-pro',   name: 'Gemini 2.5 Pro',   provider: 'google', builtIn: true, modelId: 'gemini-2.5-pro-preview-03-25', enabled: true, isDefault: isDefault('gemini:gemini-2.5-pro') },
  { id: 'gemini:gemini-1.5-pro',   name: 'Gemini 1.5 Pro',   provider: 'google', builtIn: true, modelId: 'gemini-1.5-pro', enabled: true, isDefault: isDefault('gemini:gemini-1.5-pro') },
]

const CLAUDE_MODELS = (isDefault: (id: string) => boolean): AppModel[] => [
  { id: 'claude:claude-haiku-4-5-20251001', name: 'Claude Haiku',  provider: 'anthropic', builtIn: true, modelId: 'claude-haiku-4-5-20251001', enabled: true, isDefault: isDefault('claude:claude-haiku-4-5-20251001') },
  { id: 'claude:claude-sonnet-4-6',         name: 'Claude Sonnet', provider: 'anthropic', builtIn: true, modelId: 'claude-sonnet-4-6',         enabled: true, isDefault: isDefault('claude:claude-sonnet-4-6') },
  { id: 'claude:claude-opus-4-6',           name: 'Claude Opus',   provider: 'anthropic', builtIn: true, modelId: 'claude-opus-4-6',           enabled: true, isDefault: isDefault('claude:claude-opus-4-6') },
]

export async function GET() {
  const [external, defaultSetting] = await Promise.all([
    prisma.externalModel.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } }),
    prisma.systemSetting.findUnique({ where: { key: 'model.default' } }),
  ])

  const defaultModelId = defaultSetting?.value as string | undefined
  const isDefault = (id: string) => id === defaultModelId

  const builtIns: AppModel[] = [
    ...(process.env.ANTHROPIC_API_KEY ? CLAUDE_MODELS(isDefault) : []),
    ...(process.env.GEMINI_API_KEY    ? GEMINI_MODELS(isDefault)  : []),
  ]

  const extMapped: AppModel[] = external.map(m => ({
    id: `ext:${m.id}`,
    name: m.name,
    provider: m.provider,
    builtIn: false,
    modelId: m.modelId,
    baseUrl: m.baseUrl ?? undefined,
    enabled: m.enabled,
    isDefault: isDefault(`ext:${m.id}`),
  }))

  return NextResponse.json([...builtIns, ...extMapped])
}
