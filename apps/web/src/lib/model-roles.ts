/**
 * Role-based Claude model resolution.
 *
 * Replaces model IDs that were hard-coded at each call site. Each role can be
 * overridden with a SystemSetting row `model.role.<role>` whose value is a
 * Claude model ID (a "claude:" prefix is accepted and stripped). The built-in
 * defaults below are the IDs previously hard-coded, so behaviour is unchanged
 * until an override is set.
 */

import { prisma } from './db'

export type ModelRole = 'chat' | 'planner' | 'reviewer' | 'room'

export const DEFAULT_ROLE_MODELS: Readonly<Record<ModelRole, string>> = {
  chat:     'claude-sonnet-4-6',          // interactive chat via the orion-claude sidecar
  planner:  'claude-sonnet-4-6',          // planning drafts
  reviewer: 'claude-opus-4-6',            // plan review pass
  room:     'claude-haiku-4-5-20251001',  // chat-room agents without an explicit llm
}

const CACHE_TTL_MS = 60_000
const cache = new Map<ModelRole, { model: string; at: number }>()

export function settingKeyForRole(role: ModelRole): string {
  return `model.role.${role}`
}

function normalize(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return null
  return v.startsWith('claude:') ? v.slice('claude:'.length) : v
}

/** Resolve the Claude model ID for a role (bare ID, no "claude:" prefix). */
export async function resolveModel(role: ModelRole): Promise<string> {
  const hit = cache.get(role)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.model

  let model = DEFAULT_ROLE_MODELS[role]
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: settingKeyForRole(role) } })
    model = normalize(setting?.value) ?? model
  } catch {
    // DB unavailable — fall back to the built-in default rather than failing the call
  }
  cache.set(role, { model, at: Date.now() })
  return model
}

/** Test/admin hook: drop cached resolutions (e.g. after a settings change). */
export function clearModelRoleCache(): void {
  cache.clear()
}
