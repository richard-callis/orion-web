'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import useSWR from 'swr'
import { ArrowLeft, Clock, ExternalLink, Eye, FileText, Loader2, MessageSquare, Search, Shield } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { ApiError, apiFetch } from '@/lib/api'
import { IncidentSummary } from '@/components/security/incident/IncidentSummary'
import { ActionsTab, ChatTab, EventsTab, NotesTab, ObservablesTab, TimelineTab } from '@/components/security/incident/tabs'
import type { IncidentData, IncidentTab } from '@/components/security/incident/types'

export default function IncidentDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const key = `/api/monitoring/security/incidents/${params.id}`
  const { data, error, isLoading, mutate } = useSWR<IncidentData>(key, { shouldRetryOnError: false })
  const [activeTab, setActiveTab] = useState<IncidentTab>('events')
  const [creatingInvestigation, setCreatingInvestigation] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  async function openInvestigation() {
    setCreatingInvestigation(true)
    setActionError(null)
    try {
      const d = await apiFetch<{ investigation: { id: string } }>(`${key}/create-investigation`, { method: 'POST' })
      router.push(`/security/investigations/${d.investigation.id}`)
    } catch (e) {
      // 409: one already exists — jump to it
      if (e instanceof ApiError && e.status === 409) {
        const refreshed = await mutate()
        const existing = refreshed?.incident.investigationId
        if (existing) { router.push(`/security/investigations/${existing}`); return }
      }
      setActionError('Failed to open investigation. Please try again.')
    } finally {
      setCreatingInvestigation(false)
    }
  }

  async function patchStatus(status: string) {
    setActionError(null)
    try {
      await apiFetch(key, { method: 'PATCH', body: { status } })
      await mutate()
    } catch {
      setActionError('Failed to update status. Please try again.')
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-label="Loading incident">
        <Loader2 size={24} className="animate-spin text-accent" aria-hidden />
      </div>
    )
  }

  if (!data) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <div role="alert" className="text-status-error text-sm p-4 border border-status-error/20 bg-status-error/5 rounded-lg">
          Incident not found.
        </div>
      )
    }
    return (
      <div role="alert" className="p-4 border border-status-error/20 bg-status-error/5 rounded-lg space-y-3">
        <p className="text-status-error text-sm">Failed to load incident.</p>
        <Button variant="secondary" onClick={() => mutate()}>Retry</Button>
      </div>
    )
  }

  const { incident, events, actions, chatMessages } = data
  const tabs: { key: IncidentTab; label: string; icon: typeof Shield }[] = [
    { key: 'events', label: `Events (${events.length})`, icon: FileText },
    { key: 'actions', label: `Actions (${actions.length})`, icon: Shield },
    { key: 'chat', label: `Chat (${chatMessages.length})`, icon: MessageSquare },
    { key: 'observables', label: 'Observables', icon: Eye },
    { key: 'notes', label: 'Notes', icon: FileText },
    { key: 'timeline', label: 'Timeline', icon: Clock },
  ]

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconButton label="Back" onClick={() => router.back()}>
            <ArrowLeft size={16} />
          </IconButton>
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-accent" aria-hidden />
            <h1 className="text-lg font-semibold text-text-primary">{incident.rootCauseSummary || 'Untitled Incident'}</h1>
          </div>
        </div>

        {incident.investigationId ? (
          <Link
            href={`/security/investigations/${incident.investigationId}`}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-accent text-accent hover:bg-accent/10 transition-colors"
          >
            <ExternalLink size={12} aria-hidden />
            View Investigation
          </Link>
        ) : (
          <Button onClick={openInvestigation} disabled={creatingInvestigation}>
            {creatingInvestigation ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Search size={12} aria-hidden />}
            Open Investigation
          </Button>
        )}
      </div>

      <IncidentSummary incident={incident} error={actionError} onStatusChange={patchStatus} />

      <div role="tablist" aria-label="Incident details" className="flex gap-1 bg-bg-raised rounded-lg p-0.5 flex-wrap">
        {tabs.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={activeTab === t.key}
            onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              activeTab === t.key ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            <t.icon size={12} aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {activeTab === 'events' && <EventsTab events={events} />}
        {activeTab === 'actions' && <ActionsTab actions={actions} />}
        {activeTab === 'chat' && <ChatTab messages={chatMessages} />}
        {activeTab === 'observables' && <ObservablesTab investigationId={incident.investigationId} />}
        {activeTab === 'notes' && <NotesTab investigationId={incident.investigationId} />}
        {activeTab === 'timeline' && <TimelineTab investigationId={incident.investigationId} />}
      </div>
    </div>
  )
}
