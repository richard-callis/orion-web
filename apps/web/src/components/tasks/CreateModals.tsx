'use client'
import { useId, useState } from 'react'
import { Flag, AlertTriangle } from 'lucide-react'
import { CreateEntityModal } from '../ui/CreateEntityModal'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { fieldLabelClass, getRiskHints, modalFieldClass, priorityConfig } from './task-config'

/** Runs `create`; closes on success. `create` resolves truthy on success (it toasts on failure). */
function useSubmit(create: () => Promise<unknown>) {
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (saving) return
    setSaving(true)
    try { await create() } finally { setSaving(false) }
  }
  return { saving, submit }
}

// ── Task ──────────────────────────────────────────────────────────────────────

interface CreateTaskModalProps {
  featureTitle?: string
  onClose: () => void
  onCreate: (form: { title: string; description: string; priority: string }) => Promise<unknown>
}

export function CreateTaskModal({ featureTitle, onClose, onCreate }: CreateTaskModalProps) {
  const [form, setForm] = useState({ title: '', description: '', priority: 'medium' })
  const { saving, submit } = useSubmit(() => form.title.trim() ? onCreate(form) : Promise.resolve())
  const titleId = useId(), descId = useId()

  return (
    <CreateEntityModal
      title="New Task"
      subtitle={featureTitle !== undefined ? `Adding to: ${featureTitle}` : undefined}
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Create Task"
      submitting={saving}
      submitDisabled={!form.title.trim()}
    >
      <div>
        <label htmlFor={titleId} className={fieldLabelClass}>Title *</label>
        <Input id={titleId} autoFocus value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) void submit() }}
          placeholder="What needs to be done?"
          className={modalFieldClass} />
        {getRiskHints(`${form.title} ${form.description}`).map((hint, i) => (
          <div key={i} className="flex items-start gap-1.5 mt-1.5 text-[10px] text-amber-400 bg-amber-400/10 rounded px-2 py-1.5">
            <AlertTriangle size={10} className="flex-shrink-0 mt-0.5" />{hint}
          </div>
        ))}
      </div>
      <div>
        <label htmlFor={descId} className={fieldLabelClass}>Your Description</label>
        <Textarea id={descId} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3}
          placeholder="Context, goals, requirements..."
          className={modalFieldClass} />
      </div>
      <div role="radiogroup" aria-label="Priority">
        <span className={fieldLabelClass}>Priority</span>
        <div className="flex gap-2">
          {Object.entries(priorityConfig).map(([k, v]) => (
            <button key={k} role="radio" aria-checked={form.priority === k} onClick={() => setForm(f => ({ ...f, priority: k }))}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs border transition-colors ${
                form.priority === k ? 'border-accent bg-accent/15 text-accent' : 'border-border-subtle text-text-muted hover:border-border-visible'
              }`}>
              <Flag size={10} />{v.label}
            </button>
          ))}
        </div>
      </div>
    </CreateEntityModal>
  )
}

// ── Epic / Feature (title + description) ─────────────────────────────────────

interface TitleDescModalProps {
  title: string
  subtitle?: string
  submitLabel: string
  titlePlaceholder: string
  descPlaceholder: string
  onClose: () => void
  onCreate: (form: { title: string; description: string }) => Promise<unknown>
}

function TitleDescModal({ title, subtitle, submitLabel, titlePlaceholder, descPlaceholder, onClose, onCreate }: TitleDescModalProps) {
  const [form, setForm] = useState({ title: '', description: '' })
  const { saving, submit } = useSubmit(() => form.title.trim() ? onCreate(form) : Promise.resolve())
  const titleId = useId(), descId = useId()

  return (
    <CreateEntityModal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={submitLabel}
      submitting={saving}
      submitDisabled={!form.title.trim()}
    >
      <div>
        <label htmlFor={titleId} className={fieldLabelClass}>Title *</label>
        <Input id={titleId} autoFocus value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) void submit() }}
          placeholder={titlePlaceholder}
          className={modalFieldClass} />
      </div>
      <div>
        <label htmlFor={descId} className={fieldLabelClass}>Description</label>
        <Textarea id={descId} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={3}
          placeholder={descPlaceholder}
          className={modalFieldClass} />
      </div>
    </CreateEntityModal>
  )
}

export function CreateEpicModal({ onClose, onCreate }: Pick<TitleDescModalProps, 'onClose' | 'onCreate'>) {
  return (
    <TitleDescModal
      title="New Epic"
      submitLabel="Create Epic"
      titlePlaceholder="What is this initiative about?"
      descPlaceholder="High-level goals and scope..."
      onClose={onClose}
      onCreate={onCreate}
    />
  )
}

export function CreateFeatureModal({ epicTitle, onClose, onCreate }: { epicTitle: string } & Pick<TitleDescModalProps, 'onClose' | 'onCreate'>) {
  return (
    <TitleDescModal
      title="New Feature"
      subtitle={`Under: ${epicTitle}`}
      submitLabel="Create Feature"
      titlePlaceholder="What does this feature deliver?"
      descPlaceholder="Scope, acceptance criteria..."
      onClose={onClose}
      onCreate={onCreate}
    />
  )
}
