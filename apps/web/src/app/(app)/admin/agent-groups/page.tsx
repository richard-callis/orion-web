'use client'
import { useState, useEffect, useCallback } from 'react'
import { UsersRound, Plus, Trash2, X, RefreshCw, Check, Bot, Layers, ChevronDown, ChevronRight, Shield } from 'lucide-react'

interface Agent {
  id: string
  name: string
  type: string
  role: string | null
}

interface ToolGroup {
  id: string
  name: string
  minimumTier: string
  environment: { id: string; name: string }
}

interface AgentGroupMember {
  agentId: string
  agent: Agent
}

interface AgentGroupToolAccess {
  toolGroupId: string
  toolGroup: ToolGroup & { environment: { id: string; name: string } }
}

interface AgentGroup {
  id: string
  name: string
  description: string | null
  members: AgentGroupMember[]
  toolAccess: AgentGroupToolAccess[]
}

const TIER_COLORS: Record<string, string> = {
  viewer:   'bg-bg-raised text-text-muted',
  operator: 'bg-blue-500/15 text-blue-400',
  admin:    'bg-orange-500/15 text-orange-400',
}

const inputCls = 'w-full px-3 py-1.5 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors'
const labelCls = 'block text-xs font-medium text-text-muted mb-1'

export default function AgentGroupsPage() {
  const [groups, setGroups]           = useState<AgentGroup[]>([])
  const [allAgents, setAllAgents]     = useState<Agent[]>([])
  const [allToolGroups, setAllToolGroups] = useState<ToolGroup[]>([])
  const [loading, setLoading]         = useState(true)
  const [selected, setSelected]       = useState<AgentGroup | null>(null)
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())

  // Create group form
  const [showCreate, setShowCreate]   = useState(false)
  const [createName, setCreateName]   = useState('')
  const [createDesc, setCreateDesc]   = useState('')
  const [creating, setCreating]       = useState(false)

  // Delete confirm
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // Add member dropdown
  const [addingMember, setAddingMember] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')

  // Add tool access dropdown
  const [addingTool, setAddingTool]   = useState(false)
  const [toolSearch, setToolSearch]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [grpData, agentData, tgData] = await Promise.all([
        fetch('/api/agent-groups').then(r => r.json()),
        fetch('/api/agents').then(r => r.json()),
        fetch('/api/tool-groups').then(r => r.json()),
      ])
      setGroups(grpData)
      setAllAgents(agentData)
      setAllToolGroups(tgData)
      // Refresh selected if still present
      if (selected) {
        const fresh = grpData.find((g: AgentGroup) => g.id === selected.id)
        setSelected(fresh ?? null)
      }
    } finally {
      setLoading(false)
    }
  }, [selected])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const createGroup = async () => {
    if (!createName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/agent-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), description: createDesc.trim() || null }),
      })
      const grp: AgentGroup = await res.json()
      setGroups(prev => [...prev, grp].sort((a, b) => a.name.localeCompare(b.name)))
      setSelected(grp)
      setShowCreate(false)
      setCreateName('')
      setCreateDesc('')
    } finally {
      setCreating(false)
    }
  }

  const deleteGroup = async (id: string) => {
    await fetch(`/api/agent-groups/${id}`, { method: 'DELETE' })
    setGroups(prev => prev.filter(g => g.id !== id))
    if (selected?.id === id) setSelected(null)
    setConfirmDelete(null)
  }

  const addMember = async (agentId: string) => {
    if (!selected) return
    await fetch(`/api/agent-groups/${selected.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    })
    await load()
    setAddingMember(false)
    setMemberSearch('')
  }

  const removeMember = async (agentId: string) => {
    if (!selected) return
    await fetch(`/api/agent-groups/${selected.id}/members?agentId=${agentId}`, { method: 'DELETE' })
    await load()
  }

  const addToolAccess = async (toolGroupId: string) => {
    if (!selected) return
    await fetch(`/api/agent-groups/${selected.id}/tool-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolGroupId }),
    })
    await load()
    setAddingTool(false)
    setToolSearch('')
  }

  const removeToolAccess = async (toolGroupId: string) => {
    if (!selected) return
    await fetch(`/api/agent-groups/${selected.id}/tool-access?toolGroupId=${toolGroupId}`, { method: 'DELETE' })
    await load()
  }

  const toggleExpand = (id: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const memberIds = new Set(selected?.members.map(m => m.agentId) ?? [])
  const toolGroupIds = new Set(selected?.toolAccess.map(t => t.toolGroupId) ?? [])

  const filteredAgents = allAgents.filter(a =>
    !memberIds.has(a.id) &&
    (a.name.toLowerCase().includes(memberSearch.toLowerCase()) || (a.role ?? '').toLowerCase().includes(memberSearch.toLowerCase()))
  )

  const filteredToolGroups = allToolGroups.filter(tg =>
    !toolGroupIds.has(tg.id) &&
    (tg.name.toLowerCase().includes(toolSearch.toLowerCase()) || tg.environment.name.toLowerCase().includes(toolSearch.toLowerCase()))
  )

  return (
    <div className="flex h-full overflow-hidden">

      {/* Left: group list */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <UsersRound size={14} className="text-text-muted" />
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Agent Groups</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={load} className="p-1 rounded text-text-muted hover:text-text-primary transition-colors" title="Refresh">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={() => setShowCreate(true)} className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-raised transition-colors" title="New group">
              <Plus size={14} />
            </button>
          </div>
        </div>

        {showCreate && (
          <div className="p-3 border-b border-border-subtle space-y-2 bg-bg-card">
            <input
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createGroup(); if (e.key === 'Escape') setShowCreate(false) }}
              placeholder="Group name"
              className={inputCls}
              autoFocus
            />
            <input
              value={createDesc}
              onChange={e => setCreateDesc(e.target.value)}
              placeholder="Description (optional)"
              className={inputCls}
            />
            <div className="flex gap-2">
              <button onClick={createGroup} disabled={creating || !createName.trim()}
                className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {creating ? <RefreshCw size={10} className="animate-spin" /> : <Check size={10} />} Create
              </button>
              <button onClick={() => { setShowCreate(false); setCreateName(''); setCreateDesc('') }}
                className="px-3 py-1 text-xs rounded text-text-muted border border-border-subtle hover:text-text-primary transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {groups.map(g => (
            <div key={g.id} className="group">
              <button
                onClick={() => setSelected(g.id === selected?.id ? null : g)}
                className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                  selected?.id === g.id
                    ? 'bg-accent/15 text-accent'
                    : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
                }`}
              >
                <div className="flex items-center gap-2">
                  <UsersRound size={13} className="flex-shrink-0" />
                  <span className="text-xs font-medium flex-1 truncate">{g.name}</span>
                  {confirmDelete === g.id ? (
                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                      <button onClick={() => deleteGroup(g.id)}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-status-error text-white">
                        Del
                      </button>
                      <button onClick={() => setConfirmDelete(null)}
                        className="p-0.5 text-text-muted hover:text-text-primary">
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); setConfirmDelete(g.id) }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-muted hover:text-status-error transition-all">
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                <p className="text-[10px] text-text-muted pl-5 mt-0.5">
                  {g.members.length} agent{g.members.length !== 1 ? 's' : ''} · {g.toolAccess.length} tool group{g.toolAccess.length !== 1 ? 's' : ''}
                </p>
              </button>
            </div>
          ))}
          {groups.length === 0 && !loading && (
            <p className="text-xs text-text-muted text-center py-8">No agent groups yet</p>
          )}
        </div>
      </aside>

      {/* Right: detail */}
      {selected ? (
        <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-3xl">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{selected.name}</h1>
            {selected.description && <p className="text-sm text-text-muted mt-1">{selected.description}</p>}
          </div>

          {/* Members */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">Members</h2>
                <span className="text-xs text-text-muted">({selected.members.length})</span>
              </div>
              <button onClick={() => { setAddingMember(true); setMemberSearch('') }}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-border-subtle text-text-muted hover:text-accent hover:border-accent/40 transition-colors">
                <Plus size={11} /> Add Agent
              </button>
            </div>

            {addingMember && (
              <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-2">
                <input
                  value={memberSearch}
                  onChange={e => setMemberSearch(e.target.value)}
                  placeholder="Search agents…"
                  className={inputCls}
                  autoFocus
                />
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {filteredAgents.length === 0 && (
                    <p className="text-xs text-text-muted text-center py-3">No agents available</p>
                  )}
                  {filteredAgents.map(a => (
                    <button key={a.id} onClick={() => addMember(a.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-left hover:bg-bg-raised transition-colors">
                      <Bot size={13} className="text-text-muted flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-text-primary text-xs font-medium">{a.name}</p>
                        <p className="text-text-muted text-[10px]">{a.role ?? a.type}</p>
                      </div>
                    </button>
                  ))}
                </div>
                <button onClick={() => { setAddingMember(false); setMemberSearch('') }}
                  className="text-xs text-text-muted hover:text-text-primary transition-colors">
                  Cancel
                </button>
              </div>
            )}

            {selected.members.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-6 text-center text-xs text-text-muted">
                No agents in this group yet
              </div>
            ) : (
              <div className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle overflow-hidden">
                {selected.members.map(m => (
                  <div key={m.agentId} className="flex items-center gap-3 px-4 py-2.5">
                    <Bot size={13} className="text-text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">{m.agent.name}</p>
                      <p className="text-xs text-text-muted">{m.agent.role ?? m.agent.type}</p>
                    </div>
                    <button onClick={() => removeMember(m.agentId)}
                      className="p-1 rounded text-text-muted hover:text-status-error transition-colors">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Tool Group Access */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers size={14} className="text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">Tool Group Access</h2>
                <span className="text-xs text-text-muted">({selected.toolAccess.length})</span>
              </div>
              <button onClick={() => { setAddingTool(true); setToolSearch('') }}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-border-subtle text-text-muted hover:text-accent hover:border-accent/40 transition-colors">
                <Plus size={11} /> Add Access
              </button>
            </div>

            <p className="text-xs text-text-muted">
              Agents in this group can use tools in these tool groups (if environment tier also allows it).
            </p>

            {addingTool && (
              <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-2">
                <input
                  value={toolSearch}
                  onChange={e => setToolSearch(e.target.value)}
                  placeholder="Search tool groups…"
                  className={inputCls}
                  autoFocus
                />
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {filteredToolGroups.length === 0 && (
                    <p className="text-xs text-text-muted text-center py-3">No tool groups available</p>
                  )}
                  {filteredToolGroups.map(tg => (
                    <button key={tg.id} onClick={() => addToolAccess(tg.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-left hover:bg-bg-raised transition-colors">
                      <Layers size={13} className="text-text-muted flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-text-primary text-xs font-medium">{tg.name}</p>
                        <p className="text-text-muted text-[10px]">{tg.environment.name} · min tier: {tg.minimumTier}</p>
                      </div>
                    </button>
                  ))}
                </div>
                <button onClick={() => { setAddingTool(false); setToolSearch('') }}
                  className="text-xs text-text-muted hover:text-text-primary transition-colors">
                  Cancel
                </button>
              </div>
            )}

            {selected.toolAccess.length === 0 ? (
              <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-6 text-center text-xs text-text-muted">
                No tool group access granted yet
              </div>
            ) : (
              <div className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle overflow-hidden">
                {selected.toolAccess.map(ta => (
                  <div key={ta.toolGroupId} className="flex items-center gap-3 px-4 py-2.5">
                    <Layers size={13} className="text-text-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">{ta.toolGroup.name}</p>
                      <p className="text-xs text-text-muted">{ta.toolGroup.environment.name}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-1 ${TIER_COLORS[ta.toolGroup.minimumTier] ?? 'bg-bg-raised text-text-muted'}`}>
                      <Shield size={9} /> min: {ta.toolGroup.minimumTier}
                    </span>
                    <button onClick={() => removeToolAccess(ta.toolGroupId)}
                      className="p-1 rounded text-text-muted hover:text-status-error transition-colors">
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* How it works */}
          <section className="rounded-lg border border-border-subtle bg-bg-card p-4 space-y-2">
            <p className="text-xs font-semibold text-text-primary">How agent groups work</p>
            <ul className="text-xs text-text-muted space-y-1 list-disc list-inside">
              <li>Agents in a group inherit access to all tool groups granted to that group</li>
              <li>The tool group's <strong className="text-text-secondary">minimum tier</strong> still applies — human users below that tier must request approval</li>
              <li>If a tool has individual agent restrictions, only those listed agents can execute it (group membership is not sufficient)</li>
              <li>Agents always bypass the tier check — restrictions are for human users only</li>
            </ul>
          </section>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Select a group or create one
        </div>
      )}
    </div>
  )
}
