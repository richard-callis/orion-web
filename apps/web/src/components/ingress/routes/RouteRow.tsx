'use client'

import { useState } from 'react'
import { Wifi, WifiOff, Trash2, Check, X, RefreshCw, ExternalLink, Lock, Shield } from 'lucide-react'
import { InlineEdit } from '../shared'
import { btnPrimary, btnGhost } from '../styles'
import type { IngressPath, IngressMiddleware, IngressRoute } from '../types'

export function RouteRow({ route, availableMiddlewares, onToggle, onDelete, onCommentSave, onMiddlewaresSave }: {
  route: IngressRoute
  availableMiddlewares: IngressMiddleware[]
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onCommentSave: (comment: string) => Promise<void>
  onMiddlewaresSave: (names: string[]) => Promise<void>
}) {
  const [toggling, setToggling]     = useState(false)
  const [deleting, setDeleting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editMws, setEditMws]       = useState(false)
  const [selMws, setSelMws]         = useState<string[]>(route.middlewares ?? [])
  const [savingMws, setSavingMws]   = useState(false)

  const doToggle = async () => { setToggling(true); await onToggle(); setToggling(false) }
  const doDelete = async () => { setDeleting(true); await onDelete(); setDeleting(false) }

  const toggleMw = (name: string) =>
    setSelMws(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])

  const saveMws = async () => {
    setSavingMws(true)
    await onMiddlewaresSave(selMws)
    setSavingMws(false)
    setEditMws(false)
  }

  const firstPath = Array.isArray(route.paths) && route.paths.length > 0
    ? route.paths[0] as IngressPath
    : null

  return (
    <div className={`rounded-lg border transition-colors ${
      route.enabled
        ? 'border-border-subtle bg-bg-surface hover:bg-bg-raised'
        : 'border-border-subtle/50 bg-bg-canvas opacity-60'
    }`}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* Toggle */}
        <button
          onClick={doToggle}
          disabled={toggling}
          title={route.enabled ? 'Disable route' : 'Enable route'}
          className={`mt-0.5 flex-shrink-0 transition-colors ${
            route.enabled ? 'text-status-healthy hover:text-status-error' : 'text-text-muted hover:text-status-healthy'
          }`}
        >
          {toggling
            ? <RefreshCw size={14} className="animate-spin" />
            : route.enabled ? <Wifi size={14} /> : <WifiOff size={14} />
          }
        </button>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={`${route.tls ? 'https' : 'http'}://${route.host}`}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-xs font-mono font-semibold flex items-center gap-1 ${
                route.enabled ? 'text-accent hover:underline' : 'text-text-muted line-through'
              }`}
            >
              {route.tls && <Lock size={9} className="flex-shrink-0" />}
              {route.host}
              <ExternalLink size={9} className="opacity-60" />
            </a>
            {firstPath && (
              <span className="text-[10px] text-text-muted font-mono bg-bg-raised px-1.5 py-0.5 rounded border border-border-subtle">
                → {firstPath.namespace ? `${firstPath.namespace}/` : ''}{firstPath.service}:{firstPath.port}
              </span>
            )}
            {!route.enabled && route.disabledBy && (
              <span className="text-[10px] text-text-muted italic">disabled by {route.disabledBy}</span>
            )}
          </div>

          {/* Middleware badges */}
          {(route.middlewares?.length > 0 || editMws) && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {!editMws && route.middlewares?.map(name => (
                <span key={name} className="text-[10px] px-1.5 py-0.5 rounded border border-accent/30 bg-accent/5 text-accent font-mono">
                  {name}
                </span>
              ))}
            </div>
          )}

          <InlineEdit
            value={route.comment}
            placeholder="Add a comment…"
            onSave={onCommentSave}
            className="text-[11px] text-text-muted"
          />
        </div>

        {/* Actions */}
        <div className="flex-shrink-0 flex items-center gap-1">
          {availableMiddlewares.length > 0 && (
            <button
              onClick={() => setEditMws(e => !e)}
              title="Edit middlewares"
              className={`transition-colors ${editMws ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
            >
              <Shield size={11} />
            </button>
          )}
          {confirmDelete ? (
            <>
              <span className="text-[10px] text-status-error">Delete?</span>
              <button onClick={doDelete} disabled={deleting} className="text-status-error hover:opacity-70">
                {deleting ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-text-muted hover:text-text-primary"><X size={11} /></button>
            </>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-text-muted hover:text-status-error transition-colors">
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Middleware picker */}
      {editMws && availableMiddlewares.length > 0 && (
        <div className="px-3 pb-2.5 pt-0 flex items-center gap-2 flex-wrap border-t border-border-subtle/50 mt-1">
          <span className="text-[10px] text-text-muted">Middlewares:</span>
          {availableMiddlewares.map(mw => (
            <label key={mw.id} className={`flex items-center gap-1 px-1.5 py-0.5 rounded border cursor-pointer transition-colors text-[11px] ${
              selMws.includes(mw.name)
                ? 'border-accent/60 bg-accent/10 text-accent'
                : 'border-border-subtle text-text-muted hover:border-accent/30'
            }`}>
              <input type="checkbox" className="hidden" checked={selMws.includes(mw.name)} onChange={() => toggleMw(mw.name)} />
              {mw.name}
            </label>
          ))}
          <button onClick={saveMws} disabled={savingMws} className={btnPrimary}>
            {savingMws ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />} Apply
          </button>
          <button onClick={() => { setSelMws(route.middlewares ?? []); setEditMws(false) }} className={btnGhost}>Cancel</button>
        </div>
      )}
    </div>
  )
}

// ── Ingress Point panel ───────────────────────────────────────────────────────
