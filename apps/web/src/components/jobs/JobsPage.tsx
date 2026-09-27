'use client'

import { Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Zap, Activity } from 'lucide-react'
import type { Tab } from './job-types'
import { SchedulesTab } from './SchedulesTab'
import { WebhooksTab } from './WebhooksTab'
import { SystemTab, HistoryTab } from './RunTabs'

const TABS: { key: Tab; label: string }[] = [
  { key: 'schedules', label: 'Schedules' },
  { key: 'webhooks',  label: 'Webhooks' },
  { key: 'system',    label: 'System' },
  { key: 'history',   label: 'History' },
]

function JobsPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const requested = searchParams.get('tab')
  const activeTab: Tab = TABS.some(t => t.key === requested) ? requested as Tab : 'schedules'

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Zap size={20} className="text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Jobs</h1>
          <p className="text-sm text-text-muted mt-0.5">Schedules, webhooks, and system background jobs</p>
        </div>
      </div>
      <div role="tablist" aria-label="Job types" className="flex gap-1 flex-wrap border-b border-border-subtle pb-2">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={activeTab === t.key}
            onClick={() => router.push(`/jobs?tab=${t.key}`, { scroll: false })}
            className={`px-3 py-1.5 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
              activeTab === t.key
                ? 'bg-accent/10 text-accent border border-accent/30'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-raised'
            }`}
          >
            {t.key === 'history' ? <Activity size={11} className="inline mr-1" /> : null}
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {activeTab === 'schedules' && <SchedulesTab />}
        {activeTab === 'webhooks'  && <WebhooksTab />}
        {activeTab === 'system'    && <SystemTab />}
        {activeTab === 'history'   && <HistoryTab />}
      </div>
    </div>
  )
}

export function JobsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Loading…</div>}>
      <JobsPageInner />
    </Suspense>
  )
}
