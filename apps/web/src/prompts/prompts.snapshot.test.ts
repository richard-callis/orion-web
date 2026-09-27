/**
 * Snapshots of every seeded prompt body: the admin-editable system prompt
 * defaults and the bundled system agents (system + watch prompts, plus the
 * rest of each definition). Written before the prompt bodies moved to .md
 * files so the move can prove the seeded content is byte-identical.
 */
import { describe, it, expect } from 'vitest'
import { PROMPT_DEFAULTS } from '@/lib/system-prompts'
import { SYSTEM_AGENT_DEFS } from '@/lib/seed-system-agents'

describe('seeded prompt content', () => {
  it('PROMPT_DEFAULTS', () => {
    expect(PROMPT_DEFAULTS).toMatchSnapshot()
  })

  it('SYSTEM_AGENT_DEFS', () => {
    expect(SYSTEM_AGENT_DEFS).toMatchSnapshot()
  })
})
