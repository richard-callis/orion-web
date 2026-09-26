'use client'

import { createContext, useCallback, useContext, useId, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { Button } from './Button'

interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive. Defaults to true. */
  danger?: boolean
}

interface ConfirmDialogProps extends ConfirmOptions {
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}

/** A controlled yes/no dialog. */
export function ConfirmDialog({
  title = 'Are you sure?',
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      onClose={onCancel}
      labelledBy={titleId}
      describedBy={descId}
      initialFocusRef={cancelRef}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      className="w-full max-w-sm bg-bg-card border border-border-visible rounded-xl p-5 shadow-2xl"
    >
      <h2 id={titleId} className="text-sm font-semibold text-text-primary">{title}</h2>
      <p id={descId} className="text-xs text-text-muted mt-2 whitespace-pre-wrap">{message}</p>
      <div className="flex justify-end gap-2 mt-5">
        <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
      </div>
    </Dialog>
  )
}

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Provides `useConfirm()`, a promise-based replacement for window.confirm(). */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  const confirm = useCallback<ConfirmFn>(options => {
    const opts = typeof options === 'string' ? { message: options } : options
    return new Promise<boolean>(resolve => {
      setPending(prev => {
        prev?.resolve(false)
        return { ...opts, resolve }
      })
    })
  }, [])

  const settle = (value: boolean) => {
    pending?.resolve(value)
    setPending(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          {...pending}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

/** Returns `confirm(message | options) => Promise<boolean>`. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return ctx
}
