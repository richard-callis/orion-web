'use client'
import { useState, type Dispatch, type SetStateAction } from 'react'
import type { Agent, Task, Feature, Epic, SelectionState } from '@/types/tasks'
import { apiFetch, errorMessage } from '@/lib/api'
import { useToast } from '../ui/Toast'
import type { RightPanel } from './task-config'

/** Re-insert `item` at `index` unless it is already present. */
function restoreAt<T extends { id: string }>(list: T[], item: T, index: number): T[] {
  if (list.some(x => x.id === item.id)) return list
  const next = [...list]
  next.splice(Math.min(index, next.length), 0, item)
  return next
}

interface Options {
  initialTasks: Task[]
  initialEpics: Epic[]
  initialAgents: Agent[]
  setPanel: Dispatch<SetStateAction<RightPanel>>
  setSelection: Dispatch<SetStateAction<SelectionState>>
}

export interface NewTask { title: string; description: string; priority: string; featureId: string | null }
export interface NewEpic { title: string; description: string }
export interface NewFeature { epicId: string; title: string; description: string }

/**
 * Tasks/epics/features state (plus the read-only agent list) and CRUD.
 *
 * Updates and deletes are optimistic: the local state changes first and, if the
 * request fails (network error or non-2xx), `rollback` restores the previous
 * state and a toast is shown. Creates wait for the server and return the new
 * entity (or null on failure, after toasting).
 */
export function useTaskMutations({ initialTasks, initialEpics, initialAgents, setPanel, setSelection }: Options) {
  const toast = useToast()
  const [tasks, setTasks]   = useState<Task[]>(initialTasks)
  const [epics, setEpics]   = useState<Epic[]>(initialEpics)
  const [agents]            = useState<Agent[]>(initialAgents)

  const persist = async (url: string, method: string, body: Record<string, unknown> | undefined, rollback: () => void, what: string) => {
    try {
      await apiFetch(url, { method, body })
    } catch (e) {
      rollback()
      toast.error(`Failed to ${what}: ${errorMessage(e, 'unknown error')}`)
    }
  }

  const create = async <T,>(url: string, body: Record<string, unknown>, what: string): Promise<T | null> => {
    try {
      return await apiFetch<T>(url, { method: 'POST', body })
    } catch (e) {
      toast.error(`Failed to create ${what}: ${errorMessage(e, 'unknown error')}`)
      return null
    }
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  const updateTask = async (id: string, patch: Partial<Task>) => {
    const original = tasks.find(t => t.id === id)
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
    setPanel(p => p?.kind === 'task' && p.task.id === id ? { ...p, task: { ...p.task, ...patch } } : p)
    await persist(`/api/tasks/${id}`, 'PUT', patch, () => {
      if (!original) return
      setTasks(prev => prev.map(t => t.id === id ? original : t))
      setPanel(p => p?.kind === 'task' && p.task.id === id ? { ...p, task: original } : p)
    }, 'update task')
  }

  const deleteTask = async (id: string) => {
    const index = tasks.findIndex(t => t.id === id)
    const original = tasks[index]
    setTasks(prev => prev.filter(t => t.id !== id))
    setPanel(p => p?.kind === 'task' && p.task.id === id ? null : p)
    await persist(`/api/tasks/${id}`, 'DELETE', undefined, () => {
      if (original) setTasks(prev => restoreAt(prev, original, index))
    }, 'delete task')
  }

  const createTask = async (input: NewTask): Promise<Task | null> => {
    const task = await create<Task>('/api/tasks', {
      title: input.title, description: input.description || null,
      priority: input.priority, featureId: input.featureId, createdBy: 'admin',
    }, 'task')
    if (!task) return null
    setTasks(prev => [task, ...prev])
    // Bump feature task count
    if (task.featureId) {
      setEpics(prev => prev.map(e => ({
        ...e,
        features: e.features.map(f =>
          f.id === task.featureId ? { ...f, _count: { tasks: (f._count?.tasks ?? 0) + 1 } } : f
        ),
      })))
    }
    return task
  }

  // ── Epics ──────────────────────────────────────────────────────────────────

  const updateEpic = async (id: string, patch: Partial<Epic>) => {
    const original = epics.find(e => e.id === id)
    setEpics(prev => prev.map(e => e.id === id ? { ...e, ...patch } : e))
    setPanel(p => p?.kind === 'epic' && p.epic.id === id ? { ...p, epic: { ...p.epic, ...patch } } : p)
    await persist(`/api/epics/${id}`, 'PUT', patch, () => {
      if (!original) return
      setEpics(prev => prev.map(e => e.id === id ? original : e))
      setPanel(p => p?.kind === 'epic' && p.epic.id === id ? { ...p, epic: original } : p)
    }, 'update epic')
  }

  const deleteEpic = async (id: string) => {
    const index = epics.findIndex(e => e.id === id)
    const original = epics[index]
    setEpics(prev => prev.filter(e => e.id !== id))
    setSelection({ kind: 'all' })
    setPanel(null)
    await persist(`/api/epics/${id}`, 'DELETE', undefined, () => {
      if (original) setEpics(prev => restoreAt(prev, original, index))
    }, 'delete epic')
  }

  const createEpic = async (input: NewEpic): Promise<Epic | null> => {
    const epic = await create<Epic>('/api/epics', { title: input.title, description: input.description || null }, 'epic')
    if (epic) setEpics(prev => [epic, ...prev])
    return epic
  }

  // ── Features ───────────────────────────────────────────────────────────────

  const updateFeature = async (id: string, epicId: string, patch: Partial<Feature>) => {
    const original = epics.find(e => e.id === epicId)?.features.find(f => f.id === id)
    setEpics(prev => prev.map(e =>
      e.id === epicId
        ? { ...e, features: e.features.map(f => f.id === id ? { ...f, ...patch } : f) }
        : e
    ))
    setPanel(p => p?.kind === 'feature' && p.feature.id === id ? { ...p, feature: { ...p.feature, ...patch } } : p)
    await persist(`/api/features/${id}`, 'PUT', patch, () => {
      if (!original) return
      setEpics(prev => prev.map(e =>
        e.id === epicId ? { ...e, features: e.features.map(f => f.id === id ? original : f) } : e
      ))
      setPanel(p => p?.kind === 'feature' && p.feature.id === id ? { ...p, feature: original } : p)
    }, 'update feature')
  }

  const deleteFeature = async (id: string, epicId: string) => {
    const features = epics.find(e => e.id === epicId)?.features ?? []
    const index = features.findIndex(f => f.id === id)
    const original = features[index]
    setEpics(prev => prev.map(e =>
      e.id === epicId ? { ...e, features: e.features.filter(f => f.id !== id) } : e
    ))
    setSelection({ kind: 'epic', epicId })
    setPanel(null)
    await persist(`/api/features/${id}`, 'DELETE', undefined, () => {
      if (!original) return
      setEpics(prev => prev.map(e =>
        e.id === epicId ? { ...e, features: restoreAt(e.features, original, index) } : e
      ))
    }, 'delete feature')
  }

  const createFeature = async (input: NewFeature): Promise<Feature | null> => {
    const feature = await create<Feature>('/api/features', {
      epicId: input.epicId, title: input.title, description: input.description || null,
    }, 'feature')
    if (feature) {
      setEpics(prev => prev.map(e =>
        e.id === input.epicId ? { ...e, features: [...e.features, feature] } : e
      ))
    }
    return feature
  }

  return {
    tasks, epics, agents,
    updateTask, deleteTask, createTask,
    updateEpic, deleteEpic, createEpic,
    updateFeature, deleteFeature, createFeature,
  }
}
