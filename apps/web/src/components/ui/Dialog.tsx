'use client'

import { useEffect, useRef } from 'react'
import { cn } from './cn'

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

interface DialogProps {
  /** Called on Escape or backdrop click. */
  onClose: () => void
  children: React.ReactNode
  /** Classes for the dialog panel (sizing, background, layout). */
  className?: string
  /** Classes for the backdrop/positioning layer. */
  overlayClassName?: string
  /** Accessible name when there is no visible title element. */
  label?: string
  /** id of the element that titles the dialog. */
  labelledBy?: string
  describedBy?: string
  /** Set false to ignore backdrop clicks (e.g. while a long operation runs). */
  closeOnBackdrop?: boolean
  /** Set false to ignore Escape. */
  closeOnEscape?: boolean
  /** Element to focus first; defaults to the first focusable element. */
  initialFocusRef?: React.RefObject<HTMLElement | null>
}

/**
 * Accessible modal dialog: role="dialog", aria-modal, Escape to close,
 * focus trap, and focus restored to the previously focused element on close.
 */
export function Dialog({
  onClose,
  children,
  className,
  overlayClassName,
  label,
  labelledBy,
  describedBy,
  closeOnBackdrop = true,
  closeOnEscape = true,
  initialFocusRef,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const closeOnEscapeRef = useRef(closeOnEscape)
  closeOnEscapeRef.current = closeOnEscape

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const target =
      initialFocusRef?.current ??
      panel?.querySelector<HTMLElement>('[autofocus]') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel
    target?.focus()

    function onKeyDown(e: KeyboardEvent) {
      const current = panelRef.current
      if (!current) return
      // Only the top-most open dialog handles keys.
      const dialogs = document.querySelectorAll('[data-orion-dialog]')
      if (dialogs[dialogs.length - 1] !== current) return

      if (e.key === 'Escape' && closeOnEscapeRef.current) {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = Array.from(current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter(el => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) {
        e.preventDefault()
        current.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !current.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !current.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus()
    }
    // Focus handling runs once per mount; callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm',
        overlayClassName,
      )}
      onMouseDown={e => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        data-orion-dialog=""
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn('outline-none', className)}
      >
        {children}
      </div>
    </div>
  )
}
