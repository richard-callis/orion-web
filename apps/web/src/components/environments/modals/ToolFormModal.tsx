'use client'

import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Code2, RefreshCw, Sparkles } from 'lucide-react'
import { Dialog } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input, labelClass } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { apiFetch, errorMessage } from '@/lib/api'
import { ErrorNote, ModalHeader, modalPanel } from '../shared'
import type { Environment, McpTool } from '../types'

interface ToolForm { name: string; description: string; inputSchema: string; execType: string; execConfig: string }

const DEFAULT_INPUT_SCHEMA = `{
  "type": "object",
  "properties": {},
  "required": []
}`

const EMPTY_TOOL: ToolForm = { name: '', description: '', inputSchema: DEFAULT_INPUT_SCHEMA, execType: 'shell', execConfig: '' }

interface GeneratedTool { name: string; description: string; inputSchema: object; execType: string; execConfig: object }

export function ToolFormModal({ env, tool, onClose, onSaved }: {
  env: Environment
  /** null = create */
  tool: McpTool | null
  onClose: () => void
  onSaved: () => void
}) {
  const mode = tool ? 'edit' : 'create'
  const [form, setForm] = useState<ToolForm>(() => tool ? {
    name: tool.name,
    description: tool.description,
    inputSchema: JSON.stringify(tool.inputSchema, null, 2),
    execType: tool.execType,
    execConfig: tool.execConfig ? JSON.stringify(tool.execConfig, null, 2) : '',
  } : EMPTY_TOOL)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiDesc, setAiDesc] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const id = useId()
  const set = (k: keyof ToolForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const save = async () => {
    if (!form.name.trim())        { setError('Name is required'); return }
    if (!form.description.trim()) { setError('Description is required'); return }
    let inputSchema: unknown
    let execConfig: unknown = null
    try { inputSchema = JSON.parse(form.inputSchema) } catch { setError('Input schema is not valid JSON'); return }
    if (form.execConfig.trim()) {
      try { execConfig = JSON.parse(form.execConfig) } catch { setError('Exec config is not valid JSON'); return }
    }
    setSaving(true); setError(null)
    try {
      const body = { name: form.name.trim(), description: form.description.trim(), inputSchema, execType: form.execType, execConfig }
      if (tool) await apiFetch(`/api/environments/${env.id}/tools/${tool.id}`, { method: 'PUT', body })
      else await apiFetch(`/api/environments/${env.id}/tools`, { method: 'POST', body })
      onSaved()
    } catch (e) {
      setError(errorMessage(e, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  const generate = async () => {
    if (!aiDesc.trim()) return
    setAiGenerating(true); setAiError(null)
    try {
      const g = await apiFetch<GeneratedTool>('/api/tools/generate', {
        method: 'POST',
        body: { description: aiDesc.trim(), environmentType: env.type },
      })
      setForm({
        name: g.name,
        description: g.description,
        inputSchema: JSON.stringify(g.inputSchema, null, 2),
        execType: g.execType,
        execConfig: JSON.stringify(g.execConfig, null, 2),
      })
      setAiDesc('')
    } catch (e) {
      setAiError(errorMessage(e, 'AI generation failed'))
    } finally {
      setAiGenerating(false)
    }
  }

  const f = (n: string) => `${id}-${n}`

  return createPortal(
    <Dialog onClose={onClose} label={mode === 'create' ? 'New tool' : `Edit ${tool?.name ?? 'tool'}`} className={`${modalPanel} max-w-lg`}>
      <ModalHeader title={mode === 'create' ? 'New Tool' : `Edit · ${tool?.name}`} onClose={onClose} />

      <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
        {error && <ErrorNote>{error}</ErrorNote>}

        {mode === 'create' && (
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 space-y-2">
            <label htmlFor={f('ai')} className="flex items-center gap-1.5 text-xs font-medium text-accent">
              <Sparkles size={12} aria-hidden /> AI Assist — describe what you want
            </label>
            <div className="flex gap-2">
              <Input id={f('ai')} value={aiDesc} onChange={e => setAiDesc(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') generate() }}
                placeholder="e.g. list pods in a namespace, restart a deployment, show disk usage..." className="flex-1" />
              <Button onClick={generate} disabled={aiGenerating || !aiDesc.trim()} className="flex-shrink-0">
                {aiGenerating ? <RefreshCw size={11} className="animate-spin" aria-hidden /> : <Sparkles size={11} aria-hidden />}
                {aiGenerating ? 'Thinking…' : 'Generate'}
              </Button>
            </div>
            {aiError && <p role="alert" className="text-[11px] text-status-error">{aiError}</p>}
          </div>
        )}

        <div>
          <label htmlFor={f('name')} className={labelClass}>Tool Name * <span className="text-text-muted">(snake_case, e.g. run_script)</span></label>
          <Input id={f('name')} value={form.name} onChange={set('name')} placeholder="run_script" className="font-mono" autoFocus />
        </div>
        <div>
          <label htmlFor={f('desc')} className={labelClass}>Description *</label>
          <Input id={f('desc')} value={form.description} onChange={set('description')} placeholder="What this tool does" />
        </div>
        <div>
          <label htmlFor={f('exec')} className={labelClass}>Execution Type</label>
          <Select id={f('exec')} value={form.execType} onChange={set('execType')}>
            <option value="shell">Shell command</option>
            <option value="http">HTTP request</option>
            <option value="builtin">Built-in function</option>
          </Select>
        </div>
        <div>
          <label htmlFor={f('schema')} className={labelClass}>
            <Code2 size={10} className="inline mr-1" aria-hidden />
            Input Schema <span className="text-text-muted">(JSON Schema)</span>
          </label>
          <Textarea id={f('schema')} value={form.inputSchema} onChange={set('inputSchema')} rows={6} className="font-mono text-xs resize-none"
            placeholder='{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}' />
        </div>
        <div>
          <label htmlFor={f('config')} className={labelClass}>
            Exec Config <span className="text-text-muted">(JSON — shell: {`{"command":"..."}`}, http: {`{"url":"..."}`})</span>
          </label>
          <Textarea id={f('config')} value={form.execConfig} onChange={set('execConfig')} rows={3} className="font-mono text-xs resize-none"
            placeholder='{"command": "kubectl get pods -n {namespace}"}' />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>
          {saving ? <RefreshCw size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />}
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Dialog>,
    document.body,
  )
}
