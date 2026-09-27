'use client'
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Terminal, CheckCircle2, XCircle, Play, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react'
import type { Agent } from '@/types/tasks'

export interface TaskEvent {
  id: string
  taskId: string
  eventType: string
  content: string | null
  agentId: string | null
  createdAt: string
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  started:     <Play size={11} className="text-accent" />,
  completed:   <CheckCircle2 size={11} className="text-status-healthy" />,
  failed:      <XCircle size={11} className="text-status-error" />,
  tool_call:   <Terminal size={11} className="text-status-warning" />,
  tool_result: <Terminal size={11} className="text-text-muted" />,
  comment:     <MessageSquare size={11} className="text-text-muted" />,
}

const EVENT_LABEL: Record<string, string> = {
  started:     'Started',
  completed:   'Completed',
  failed:      'Failed',
  tool_call:   'Command',
  tool_result: 'Output',
  comment:     'Comment',
}

const EVENT_BG: Record<string, string> = {
  started:     'border-accent/30 bg-accent/5',
  completed:   'border-status-healthy/30 bg-status-healthy/5',
  failed:      'border-status-error/30 bg-status-error/5',
  tool_call:   'border-status-warning/20 bg-status-warning/5',
  tool_result: 'border-border-subtle bg-bg-raised',
  comment:     'border-border-subtle bg-bg-card',
}

/** Run log for one task. Keyed by task id, so a switched task never shows another task's events. */
export function RunLogTab({ taskId, agents }: { taskId: string; agents: Agent[] }) {
  const { data: events, isLoading, mutate } = useSWR<TaskEvent[]>(`/api/tasks/${taskId}/events`)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const agentMap = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])
  const refresh = () => { void mutate() }
  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  if (isLoading && !events) return (
    <div className="flex items-center justify-center py-12 text-text-muted text-xs">Loading…</div>
  )

  const list = events ?? []
  if (list.length === 0) return (
    <div className="flex flex-col items-center justify-center py-12 gap-3">
      <Terminal size={28} className="text-text-muted opacity-40" />
      <p className="text-xs text-text-muted">No run log yet.</p>
      <p className="text-[10px] text-text-muted opacity-60">Events will appear here once an agent runs this task.</p>
      <button onClick={refresh} className="text-[10px] text-accent hover:underline mt-1">Refresh</button>
    </div>
  )

  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-text-muted">{list.length} event{list.length !== 1 ? 's' : ''}</span>
        <button onClick={refresh} className="text-[10px] text-accent hover:underline">Refresh</button>
      </div>
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-border-subtle" />
        <div className="space-y-2">
          {list.map(ev => {
            const isLong = (ev.content?.length ?? 0) > 200
            const isExpanded = expanded.has(ev.id)
            const displayContent = isLong && !isExpanded
              ? ev.content!.slice(0, 200) + '…'
              : ev.content
            const agent = ev.agentId ? agentMap.get(ev.agentId) : null

            return (
              <div key={ev.id} className="flex gap-3 pl-1">
                {/* Dot */}
                <div className="flex-shrink-0 w-3.5 h-3.5 mt-0.5 rounded-full bg-bg-sidebar border border-border-visible flex items-center justify-center z-10">
                  {EVENT_ICONS[ev.eventType] ?? <div className="w-1.5 h-1.5 rounded-full bg-border-visible" />}
                </div>
                {/* Card */}
                <div className={`flex-1 min-w-0 rounded border px-2.5 py-1.5 ${EVENT_BG[ev.eventType] ?? 'border-border-subtle bg-bg-raised'}`}>
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[10px] font-semibold text-text-secondary">
                      {EVENT_LABEL[ev.eventType] ?? ev.eventType}
                    </span>
                    {agent && (
                      <span className="text-[9px] text-text-muted">· {agent.name}</span>
                    )}
                    <span className="ml-auto text-[9px] text-text-muted flex-shrink-0">
                      {new Date(ev.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  {displayContent && (
                    <pre className="text-[11px] text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">{displayContent}</pre>
                  )}
                  {isLong && (
                    <button onClick={() => toggle(ev.id)}
                      aria-expanded={isExpanded}
                      className="flex items-center gap-1 text-[10px] text-accent hover:underline mt-1">
                      {isExpanded ? <><ChevronUp size={10} /> Show less</> : <><ChevronDown size={10} /> Show more</>}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
