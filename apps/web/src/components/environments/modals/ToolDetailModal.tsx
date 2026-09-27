'use client'

import { createPortal } from 'react-dom'
import { Pencil, ToggleLeft, ToggleRight } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { ModalHeader, modalPanel } from '../shared'
import { EXEC_TYPE_LABELS, type McpTool } from '../types'

type SchemaProps = Record<string, { type?: string; description?: string }>

export function ToolDetailModal({ tool, onClose, onToggle, onEdit }: {
  tool: McpTool
  onClose: () => void
  onToggle: (tool: McpTool) => void
  onEdit: (tool: McpTool) => void
}) {
  const props = ((tool.inputSchema as { properties?: SchemaProps }).properties ?? {})
  const cfg = tool.execConfig as { command?: string; fn?: string } | null
  const command = cfg ? (cfg.command ?? cfg.fn ?? JSON.stringify(cfg)) : null

  return createPortal(
    <Dialog onClose={onClose} label="Tool details" className={`${modalPanel} max-w-lg`}>
      <ModalHeader
        onClose={onClose}
        title={
          <span className="flex items-center gap-2 min-w-0">
            <span className="font-mono truncate">{tool.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle flex-shrink-0 font-normal">
              {EXEC_TYPE_LABELS[tool.execType] ?? tool.execType}
            </span>
            {tool.builtIn && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 flex-shrink-0 font-normal">built-in</span>
            )}
          </span>
        }
      />

      <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
        <p className="text-sm text-text-secondary">{tool.description}</p>

        <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-bg-card">
          <div>
            <p className="text-xs font-medium text-text-primary">Enabled</p>
            <p className="text-[11px] text-text-muted mt-0.5">
              {tool.enabled ? 'Tool is active and available to the AI' : 'Tool is disabled — AI cannot call it'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={tool.enabled}
            aria-label={tool.enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`}
            onClick={() => onToggle(tool)}
            className={`flex-shrink-0 transition-colors ${tool.enabled ? 'text-status-healthy' : 'text-text-muted'}`}>
            {tool.enabled ? <ToggleRight size={28} aria-hidden /> : <ToggleLeft size={28} aria-hidden />}
          </button>
        </div>

        {Object.keys(props).length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Parameters</p>
            <div className="space-y-1.5">
              {Object.entries(props).map(([k, v]) => (
                <div key={k} className="flex items-start gap-2 text-xs">
                  <code className="px-1.5 py-0.5 rounded bg-bg-raised text-accent font-mono text-[11px] flex-shrink-0">{k}</code>
                  <span className="text-text-muted">{v.type ?? 'string'}{v.description ? ` — ${v.description}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {cfg && Object.keys(cfg).length > 0 && (
          <div>
            <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Command</p>
            <code className="block text-[11px] bg-bg-raised rounded px-3 py-2 text-text-secondary font-mono whitespace-pre-wrap break-all border border-border-subtle">
              {command}
            </code>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle">
        <div>
          {!tool.builtIn && (
            <Button variant="secondary" onClick={() => onEdit(tool)}>
              <Pencil size={11} aria-hidden /> Edit
            </Button>
          )}
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Dialog>,
    document.body,
  )
}
