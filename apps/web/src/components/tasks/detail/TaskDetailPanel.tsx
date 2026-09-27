'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { X, Trash2, MessageSquare } from 'lucide-react'
import type { Agent, Epic, Task, PlanTarget } from '@/types/tasks'
import { IconButton } from '../../ui/Button'
import { PlanWithAIButton } from '../PlanWithAIButton'
import type { SimpleUser } from '../task-config'
import { DetailsTab } from './DetailsTab'
import { RunLogTab } from './RunLogTab'
import { ChatTab, type TaskChatData } from './ChatTab'

type Tab = 'details' | 'log' | 'chat'

interface Props {
  task: Task
  tasks: Task[]
  epics: Epic[]
  agents: Agent[]
  users: SimpleUser[]
  columns: string[]
  onClose: () => void
  onUpdate: (patch: Partial<Task>) => void
  onDelete: () => void
  onPlan: (target: PlanTarget) => void
}

export function TaskDetailPanel({ task, tasks, epics, agents, users, columns, onClose, onUpdate, onDelete, onPlan }: Props) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('details')
  const [activeRoom, setActiveRoom] = useState<string | null>(null)

  // Chat is only fetched while its tab is open. Keyed by task id, so a late
  // response for a previously shown task can't land in this one.
  const chat = useSWR<TaskChatData>(tab === 'chat' ? `/api/tasks/${task.id}/chat` : null)
  const rooms = useMemo(() => chat.data?.rooms ?? [], [chat.data])

  // New task shown → back to details, no room selected.
  useEffect(() => { setTab('details'); setActiveRoom(null) }, [task.id])

  // Default to the first room once the chat loads.
  useEffect(() => {
    if (!activeRoom && rooms.length > 0) setActiveRoom(rooms[0].id)
  }, [activeRoom, rooms])

  const openRoomId = activeRoom ?? rooms[0]?.id

  const planTask = () => {
    const parentFeature = task.featureId ? epics.flatMap(e => e.features).find(f => f.id === task.featureId) : undefined
    const parentEpic = parentFeature ? epics.find(e => e.id === parentFeature.epicId) : undefined
    onPlan({
      type: 'task',
      id: task.id,
      title: task.title,
      description: task.description,
      parentContext: parentFeature ? {
        featureTitle: parentFeature.title,
        featureDescription: parentFeature.description,
        featurePlan: parentFeature.plan,
        epicTitle: parentEpic?.title ?? '',
        epicDescription: parentEpic?.description ?? null,
        epicPlan: parentEpic?.plan ?? null,
      } : undefined,
    })
  }

  const tabButton = (id: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`px-3 py-2 text-[11px] font-medium border-b-2 transition-colors ${tab === id ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'}`}
    >
      {label}
    </button>
  )

  return (
    <aside className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-xl border border-border-subtle bg-bg-sidebar shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <span className="text-xs font-semibold text-text-secondary">Task Detail</span>
        <IconButton label="Close task detail" onClick={onClose} className="p-0"><X size={14} /></IconButton>
      </div>
      {/* Tabs */}
      <div className="flex items-center border-b border-border-subtle px-4" role="tablist" aria-label="Task detail">
        {tabButton('details', 'Details')}
        {tabButton('log', 'Run Log')}
        {tabButton('chat', 'Chat')}
        {tab === 'chat' && openRoomId && (
          <button
            onClick={() => router.push(`/messages?r=${openRoomId}`)}
            className="ml-auto flex items-center gap-1 px-2 py-1 mb-px rounded-sm text-[10px] border border-border-subtle bg-bg-raised text-text-muted hover:text-text-secondary hover:border-accent/40 transition-colors"
            title="Open full feature chat room"
          >
            <MessageSquare size={10} />
            Open in Chat
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab === 'details' && (
          <DetailsTab task={task} tasks={tasks} agents={agents} users={users} columns={columns} onUpdate={onUpdate} />
        )}
        {tab === 'log' && <RunLogTab taskId={task.id} agents={agents} />}
        {tab === 'chat' && (
          <ChatTab
            taskId={task.id}
            rooms={rooms}
            loading={chat.isLoading && !chat.data}
            activeRoom={activeRoom}
            onRoomChange={setActiveRoom}
            reload={chat.mutate}
          />
        )}
      </div>
      {tab === 'details' && (
        <div className="p-3 border-t border-border-subtle space-y-2">
          <PlanWithAIButton onSelect={planTask} />
          <button onClick={onDelete}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-sm border border-border-subtle text-text-muted text-sm hover:border-status-error hover:text-status-error transition-colors">
            <Trash2 size={14} /> Delete Task
          </button>
        </div>
      )}
    </aside>
  )
}
