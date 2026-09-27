import type { KeyboardEvent } from 'react'

/**
 * Props that make a non-button element (card, row, panel header) operable by
 * keyboard: focusable, announced as a button, activated with Enter/Space.
 * Prefer a real <button> when the element contains no other controls.
 */
export function clickableProps(onActivate: () => void, opts: { expanded?: boolean; pressed?: boolean } = {}) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-expanded': opts.expanded,
    'aria-pressed': opts.pressed,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      // Ignore keys bubbling up from nested inputs/buttons
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onActivate()
      }
    },
  }
}
