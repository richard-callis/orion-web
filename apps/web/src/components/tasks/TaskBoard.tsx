'use client'
import { ChevronRight, Lock } from 'lucide-react'
import type { Agent, Task } from '@/types/tasks'
import { KanbanBoard } from '../ui/KanbanBoard'
import { agentInitials } from './team/agent-form'
import { AGENT_COLORS, priorityConfig, statusConfig } from './task-config'

interface Props {
  columns: string[]
  tasks: Task[]
  agents: Agent[]
  selectedTaskId: string | null
  onToggleTask: (task: Task) => void
}

export function TaskBoard({ columns, tasks, agents, selectedTaskId, onToggleTask }: Props) {
  return (
    <KanbanBoard
      columnWidth="w-60"
      columnBg="bg-bg-card"
      columns={columns.map(col => {
        const cfg = statusConfig(col)
        return {
          key: col,
          label: cfg.label,
          topBorderClass: cfg.border,
          items: tasks.filter(t => t.status === col),
          emptyText: 'No tasks',
          renderItem: (task: Task) => (
            <TaskCard
              task={task}
              agents={agents}
              selected={selectedTaskId === task.id}
              onClick={() => onToggleTask(task)}
            />
          ),
        }
      })}
    />
  )
}

function TaskCard({ task, agents, selected, onClick }: { task: Task; agents: Agent[]; selected: boolean; onClick: () => void }) {
  const p = priorityConfig[task.priority] ?? priorityConfig.medium
  const blockers = task.dependsOn?.length ?? 0
  const agentIdx = task.agent ? agents.findIndex(a => a.id === task.agent!.id) : -1
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className={`rounded-lg border p-3 cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        selected ? 'border-accent bg-accent/10' : 'border-border-subtle bg-bg-raised hover:border-border-visible'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-text-primary leading-snug flex-1">{task.title}</p>
        <ChevronRight size={12} className={`flex-shrink-0 mt-0.5 text-text-muted transition-transform ${selected ? 'rotate-90' : ''}`} />
      </div>
      {task.description && (
        <p className="text-[10px] text-text-muted mt-1.5 line-clamp-2 leading-relaxed">{task.description}</p>
      )}
      <div className="flex items-center gap-2 mt-2">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.dot}`} />
        <span className={`text-[10px] ${p.color}`}>{p.label}</span>
        <div className="ml-auto flex items-center gap-1">
          {task.wave != null && task.wave > 0 && (
            <span className="text-[10px] text-text-muted" title={`Wave ${task.wave}`}>W{task.wave}</span>
          )}
          {blockers > 0 && task.status === 'pending' && (
            <span className="flex items-center gap-0.5 text-[10px] text-amber-400" title={`Blocked by ${blockers} task(s)`}>
              <Lock size={9} />{blockers}
            </span>
          )}
          {task.plan && <span className="text-[10px] text-accent">has plan</span>}
          {task.agent && (
            <div
              title={task.agent.name}
              className={`w-4 h-4 rounded-full ${AGENT_COLORS[agentIdx >= 0 ? agentIdx % AGENT_COLORS.length : 0]} flex items-center justify-center`}
            >
              <span className="text-[7px] font-bold text-white">{agentInitials(task.agent.name)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
