/**
 * generated.ts must match the .md sources exactly — fails when a prompt was
 * edited without running `npm run gen:prompts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { collectPrompts, renderModule, OUTPUT_FILE } from '../../scripts/gen-prompts.mjs'

describe('src/prompts/generated.ts', () => {
  it('is up to date with the .md prompt files', () => {
    expect(readFileSync(OUTPUT_FILE, 'utf8')).toBe(renderModule(collectPrompts()))
  })
})
