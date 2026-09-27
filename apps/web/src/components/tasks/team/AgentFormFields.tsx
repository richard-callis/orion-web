'use client'
import { useId } from 'react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import type { AgentForm, ModelOption } from './agent-form'

const fieldCls = 'border-border-visible placeholder-text-muted'
const labelCls = 'block text-xs text-text-muted mb-1'

interface Props {
  form: AgentForm
  onChange: (update: (f: AgentForm) => AgentForm) => void
  models: ModelOption[]
  /** Edit mode also shows the persistent-watcher settings. */
  showWatcher?: boolean
  autoFocus?: boolean
  onSubmitKey?: () => void
}

/** Shared fields of the create and edit agent dialogs. */
export function AgentFormFields({ form, onChange, models, showWatcher, autoFocus, onSubmitKey }: Props) {
  const id = useId()
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => onChange(f => ({ ...f, [key]: value }))
  const isAI = form.modelId !== 'human'

  const toolsCheckbox = (
    <label className="flex items-center gap-2.5 cursor-pointer">
      <input type="checkbox" checked={form.tools} onChange={e => set('tools', e.target.checked)} className="w-3.5 h-3.5 accent-accent" />
      <span className="text-xs font-medium text-text-primary">ORION tools</span>
      <span className="text-[10px] text-text-muted">— can create tasks, agents, and more in chat</span>
    </label>
  )

  return (
    <>
      <div>
        <label htmlFor={`${id}-name`} className={labelCls}>Name{showWatcher ? '' : ' *'}</label>
        <Input id={`${id}-name`} autoFocus={autoFocus} value={form.name} onChange={e => set('name', e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && onSubmitKey) onSubmitKey() }}
          placeholder={showWatcher ? 'Agent name' : 'e.g. Alpha'} className={fieldCls} />
      </div>
      <div>
        <label htmlFor={`${id}-role`} className={labelCls}>Role</label>
        <Input id={`${id}-role`} value={form.role} onChange={e => set('role', e.target.value)}
          placeholder="e.g. DevOps Engineer" className={fieldCls} />
      </div>
      <div>
        <label htmlFor={`${id}-model`} className={labelCls}>Model</label>
        <Select id={`${id}-model`} value={form.modelId} onChange={e => set('modelId', e.target.value)} className={fieldCls}>
          <option value="human">Human (no AI)</option>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </Select>
      </div>
      <div>
        <label htmlFor={`${id}-desc`} className={labelCls}>Description</label>
        <Textarea id={`${id}-desc`} value={form.description} onChange={e => set('description', e.target.value)}
          rows={3} placeholder="Responsibilities & expertise..." className={fieldCls} />
      </div>
      {isAI && (
        <>
          <div>
            <label htmlFor={`${id}-prompt`} className={labelCls}>System Prompt</label>
            <Textarea id={`${id}-prompt`} value={form.systemPrompt} onChange={e => set('systemPrompt', e.target.value)}
              rows={showWatcher ? 5 : 4} placeholder="How this agent should behave, its persona, constraints..."
              className={`${fieldCls} border-accent/30 bg-accent/5`} />
          </div>
          {!showWatcher ? toolsCheckbox : (
            <div className="rounded-lg border border-border-subtle p-3 space-y-3">
              {toolsCheckbox}
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" checked={form.persistent} onChange={e => set('persistent', e.target.checked)} className="w-3.5 h-3.5 accent-accent" />
                <span className="text-xs font-medium text-text-primary">Persistent watcher</span>
                <span className="text-[10px] text-text-muted">— runs on a schedule, not assigned tasks</span>
              </label>
              {form.persistent && (
                <>
                  <div>
                    <label htmlFor={`${id}-interval`} className={labelCls}>Watch interval (minutes)</label>
                    <Input id={`${id}-interval`} type="number" min={1} max={1440} value={form.watchIntervalMin}
                      onChange={e => set('watchIntervalMin', parseInt(e.target.value) || 60)} className={fieldCls} />
                  </div>
                  <div>
                    <label htmlFor={`${id}-watch`} className={labelCls}>Watch prompt <span className="text-text-muted">(what to check each cycle)</span></label>
                    <Textarea id={`${id}-watch`} value={form.watchPrompt} onChange={e => set('watchPrompt', e.target.value)}
                      rows={3} placeholder="Check for any pods in CrashLoopBackOff and report them to the Agent Feed..."
                      className={fieldCls} />
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}
