import { describe, it, expect, vi } from 'vitest'
import type { KeyboardEvent } from 'react'
import { clickableProps } from './clickable'

function key(k: string, sameTarget = true) {
  const el = {}
  return {
    key: k,
    target: el,
    currentTarget: sameTarget ? el : {},
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

describe('clickableProps', () => {
  it('exposes button semantics and focusability', () => {
    const p = clickableProps(() => {}, { expanded: true })
    expect(p.role).toBe('button')
    expect(p.tabIndex).toBe(0)
    expect(p['aria-expanded']).toBe(true)
  })

  it.each(['Enter', ' '])('activates on %j and prevents default', k => {
    const fn = vi.fn()
    const e = key(k)
    clickableProps(fn).onKeyDown(e)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('ignores other keys', () => {
    const fn = vi.fn()
    clickableProps(fn).onKeyDown(key('a'))
    expect(fn).not.toHaveBeenCalled()
  })

  it('ignores keys bubbling from nested controls', () => {
    const fn = vi.fn()
    clickableProps(fn).onKeyDown(key('Enter', false))
    expect(fn).not.toHaveBeenCalled()
  })
})
