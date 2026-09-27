/**
 * Prompt bodies, authored as Markdown under src/prompts/ and compiled into
 * generated.ts by scripts/gen-prompts.mjs (see that script for why).
 *
 *   system/<key>.md          — admin-editable defaults (lib/system-prompts.ts)
 *   agents/<name>.system.md  — bundled system agents' system prompts
 *   agents/<name>.watch.md   — their watcher-cycle prompts
 */
import { PROMPTS, type PromptId } from './generated'

export type { PromptId }

export function promptText(id: PromptId): string {
  return PROMPTS[id]
}
