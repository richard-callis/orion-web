'use client'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Trash2, Pencil, X, RefreshCw, Check,
  Server, Container, Globe, Zap, ZapOff, Bot, Code2, Link2,
  Terminal, Copy, CheckCheck, Rocket,
} from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpTool {
  id: string
  environmentId: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execType: string
  execConfig: Record<string, unknown> | null
  enabled: boolean
  builtIn: boolean
}

interface AgentEnv {
  id: string
  agentId: string
  agent: { id: string; name: string; type: string; role: string | null }
}

interface Environment {
  id: string
  name: string
  type: string
  description: string | null
  gatewayUrl: string | null
  gatewayToken: string | null
  status: string
  lastSeen: string | null
  tools: McpTool[]
  agents: AgentEnv[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, React.ReactNode> = {
  cluster: <Server size={14} />,
  docker:  <Container size={14} />,
  remote:  <Globe size={14} />,
}

const STATUS_DOT: Record<string, string> = {
  connected:    'bg-status-healthy',
  disconnected: 'bg-text-muted',
  error:        'bg-status-error',
}

const EXEC_TYPE_LABELS: Record<string, string> = {
  builtin: 'Built-in',
  shell:   'Shell',
  http:    'HTTP',
}

const inputCls = 'w-full px-3 py-2 text-sm bg-bg-raised border border-border-subtle rounded text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent transition-colors'
const labelCls = 'block text-xs text-text-muted mb-1'

const DEFAULT_INPUT_SCHEMA = `{
  "type": "object",
  "properties": {},
  "required": []
}`

// ─── Environment form ──────────────────────────────────────────────────────────

interface EnvForm { name: string; type: string; description: string; gatewayUrl: string; gatewayToken: string }
const EMPTY_ENV: EnvForm = { name: '', type: 'cluster', description: '', gatewayUrl: '', gatewayToken: '' }

// ─── Tool form ────────────────────────────────────────────────────────────────

interface ToolForm { name: string; description: string; inputSchema: string; execType: string; execConfig: string }
const EMPTY_TOOL: ToolForm = { name: '', description: '', inputSchema: DEFAULT_INPUT_SCHEMA, execType: 'shell', execConfig: '' }

// ─── Main component ───────────────────────────────────────────────────────────

export function EnvironmentsPage({ initialEnvironments }: { initialEnvironments: Environment[] }) {
  const [environments, setEnvironments] = useState<Environment[]>(initialEnvironments)
  const [selected, setSelected]         = useState<Environment | null>(initialEnvironments[0] ?? null)
  const [tab, setTab]                   = useState<'tools' | 'agents'>('tools')

  // Environment CRUD state
  const [envModal, setEnvModal]   = useState<'create' | 'edit' | null>(null)
  const [envForm, setEnvForm]     = useState<EnvForm>(EMPTY_ENV)
  const [envSaving, setEnvSaving] = useState(false)
  const [envError, setEnvError]   = useState<string | null>(null)

  // Deploy gateway / join token state
  interface JoinResult { token: string; expiresAt: string; dockerCmd: string; kubectlCmd: string }
  const [deployModal, setDeployModal]   = useState(false)
  const [deployGatewayUrl, setDeployGatewayUrl] = useState('')
  const [deployGatewayType, setDeployGatewayType] = useState('')
  const [deployResult, setDeployResult] = useState<JoinResult | null>(null)
  const [deploying, setDeploying]       = useState(false)
  const [copied, setCopied]             = useState<string | null>(null)

  // Tool CRUD state
  const [toolModal, setToolModal]   = useState<'create' | 'edit' | null>(null)
  const [toolTarget, setToolTarget] = useState<McpTool | null>(null)
  const [toolForm, setToolForm]     = useState<ToolForm>(EMPTY_TOOL)
  const [toolSaving, setToolSaving] = useState(false)
  const [toolError, setToolError]   = useState<string | null>(null)
  const [confirmDeleteTool, setConfirmDeleteTool] = useState<string | null>(null)

  // ── helpers ──────────────────────────────────────────────────────────────────

  const reload = async () => {
    const data: Environment[] = await fetch('/api/environments').then(r => r.json())
    setEnvironments(data)
    if (selected) setSelected(data.find(e => e.id === selected.id) ?? data[0] ?? null)
  }

  const syncSelected = (updated: Environment) => {
    setEnvironments(prev => prev.map(e => e.id === updated.id ? updated : e))
    setSelected(updated)
  }

  // ── Deploy gateway ────────────────────────────────────────────────────────────

  const openDeploy = (env: Environment) => {
    setDeployGatewayUrl('')
    setDeployGatewayType(env.type)
    setDeployResult(null)
    setDeployModal(true)
  }

  const generateJoinToken = async () => {
    if (!selected) return
    setDeploying(true)
    try {
      const res = await fetch(`/api/environments/${selected.id}/generate-join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gatewayUrl: deployGatewayUrl || undefined, gatewayType: deployGatewayType }),
      })
      if (!res.ok) throw new Error(await res.text())
      setDeployResult(await res.json())
    } catch (e) { console.error(e) }
    finally { setDeploying(false) }
  }

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Environment modals ────────────────────────────────────────────────────────

  const openCreateEnv = () => { setEnvForm(EMPTY_ENV); setEnvError(null); setEnvModal('create') }
  const openEditEnv = (env: Environment) => {
    setEnvForm({ name: env.name, type: env.type, description: env.description ?? '', gatewayUrl: env.gatewayUrl ?? '', gatewayToken: '' })
    setEnvError(null)
    setEnvModal('edit')
  }

  const saveEnv = async () => {
    if (!envForm.name.trim()) { setEnvError('Name is required'); return }
    setEnvSaving(true); setEnvError(null)
    try {
      const payload = { name: envForm.name.trim(), type: envForm.type, description: envForm.description || null, gatewayUrl: envForm.gatewayUrl || null, gatewayToken: envForm.gatewayToken || undefined }
      const res = envModal === 'create'
        ? await fetch('/api/environments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch(`/api/environments/${selected!.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error(await res.text())
      const env: Environment = await res.json()
      if (envModal === 'create') { setEnvironments(prev => [...prev, env]); setSelected(env) }
      else syncSelected(env)
      setEnvModal(null)
    } catch (e) { setEnvError(e instanceof Error ? e.message : 'Failed to save') }
    finally { setEnvSaving(false) }
  }

  const deleteEnv = async () => {
    if (!selected) return
    await fetch(`/api/environments/${selected.id}`, { method: 'DELETE' })
    const remaining = environments.filter(e => e.id !== selected.id)
    setEnvironments(remaining)
    setSelected(remaining[0] ?? null)
    setEnvModal(null)
  }

  // ── Tool modals ───────────────────────────────────────────────────────────────

  const openCreateTool = () => { setToolTarget(null); setToolForm(EMPTY_TOOL); setToolError(null); setToolModal('create') }
  const openEditTool = (t: McpTool) => {
    setToolTarget(t)
    setToolForm({
      name:        t.name,
      description: t.description,
      inputSchema: JSON.stringify(t.inputSchema, null, 2),
      execType:    t.execType,
      execConfig:  t.execConfig ? JSON.stringify(t.execConfig, null, 2) : '',
    })
    setToolError(null)
    setToolModal('edit')
  }

  const saveTool = async () => {
    if (!selected) return
    if (!toolForm.name.trim())        { setToolError('Name is required'); return }
    if (!toolForm.description.trim()) { setToolError('Description is required'); return }
    let inputSchema: unknown
    let execConfig: unknown = null
    try { inputSchema = JSON.parse(toolForm.inputSchema) } catch { setToolError('Input schema is not valid JSON'); return }
    if (toolForm.execConfig.trim()) {
      try { execConfig = JSON.parse(toolForm.execConfig) } catch { setToolError('Exec config is not valid JSON'); return }
    }
    setToolSaving(true); setToolError(null)
    try {
      const payload = { name: toolForm.name.trim(), description: toolForm.description.trim(), inputSchema, execType: toolForm.execType, execConfig }
      const res = toolModal === 'create'
        ? await fetch(`/api/environments/${selected.id}/tools`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch(`/api/environments/${selected.id}/tools/${toolTarget!.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error(await res.text())
      await reload()
      setToolModal(null)
    } catch (e) { setToolError(e instanceof Error ? e.message : 'Failed to save') }
    finally { setToolSaving(false) }
  }

  const toggleTool = async (tool: McpTool) => {
    if (!selected) return
    const res = await fetch(`/api/environments/${selected.id}/tools/${tool.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !tool.enabled }),
    })
    if (res.ok) {
      const updated: McpTool = await res.json()
      syncSelected({ ...selected, tools: selected.tools.map(t => t.id === updated.id ? updated : t) })
    }
  }

  const deleteTool = async (toolId: string) => {
    if (!selected) return
    await fetch(`/api/environments/${selected.id}/tools/${toolId}`, { method: 'DELETE' })
    setConfirmDeleteTool(null)
    syncSelected({ ...selected, tools: selected.tools.filter(t => t.id !== toolId) })
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  const envModalOpen = envModal !== null
  const toolModalOpen = toolModal !== null

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left: environment list ── */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-border-subtle bg-bg-sidebar overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Environments</span>
          <button onClick={openCreateEnv} title="New environment"
            className="p-1 rounded text-text-muted hover:text-accent hover:bg-bg-raised transition-colors">
            <Plus size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {environments.map(env => (
            <button
              key={env.id}
              onClick={() => { setSelected(env); setTab('tools') }}
              className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors ${
                selected?.id === env.id
                  ? 'bg-accent/15 text-accent'
                  : 'text-text-secondary hover:bg-bg-raised hover:text-text-primary'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[env.status] ?? 'bg-text-muted'}`} />
                <span className="flex items-center gap-1.5 text-xs font-medium truncate">
                  {TYPE_ICONS[env.type]}
                  {env.name}
                </span>
              </div>
              <p className="text-[10px] text-text-muted mt-0.5 pl-3.5 truncate">
                {env.tools.filter(t => t.enabled).length} tools enabled · {env.status}
              </p>
            </button>
          ))}

          {environments.length === 0 && (
            <p className="text-xs text-text-muted text-center py-8">No environments yet</p>
          )}
        </div>
      </aside>

      {/* ── Right: detail panel ── */}
      {selected ? (
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Header */}
          <div className="flex items-center gap-3 px-6 py-4 border-b border-border-subtle flex-shrink-0">
            <span className="text-text-muted">{TYPE_ICONS[selected.type]}</span>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-semibold text-text-primary">{selected.name}</h1>
              <p className="text-xs text-text-muted mt-0.5">
                {selected.gatewayUrl ?? 'No gateway URL configured'}
                {selected.lastSeen && ` · last seen ${new Date(selected.lastSeen).toLocaleTimeString()}`}
              </p>
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              selected.status === 'connected'
                ? 'bg-status-healthy/15 text-status-healthy'
                : selected.status === 'error'
                ? 'bg-status-error/15 text-status-error'
                : 'bg-bg-raised text-text-muted'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[selected.status] ?? 'bg-text-muted'}`} />
              {selected.status}
            </span>
            <button onClick={() => openDeploy(selected)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors" title="Deploy gateway">
              <Rocket size={12} /> Deploy Gateway
            </button>
            <button onClick={() => openEditEnv(selected)}
              className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-raised transition-colors" title="Edit environment">
              <Pencil size={14} />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-0 border-b border-border-subtle flex-shrink-0 px-6">
            {(['tools', 'agents'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`py-2.5 px-4 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
                }`}>
                {t === 'tools' ? `Tools (${selected.tools.length})` : `Agents (${selected.agents.length})`}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">

            {tab === 'tools' && (
              <div className="space-y-4 max-w-3xl">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-text-muted">
                    {selected.tools.filter(t => t.enabled).length} of {selected.tools.length} tools enabled
                  </p>
                  <button onClick={openCreateTool}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors">
                    <Plus size={12} /> Add Tool
                  </button>
                </div>

                {selected.tools.length === 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
                    No tools configured. Add a custom tool or connect a gateway to sync built-in tools.
                  </div>
                ) : (
                  <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden divide-y divide-border-subtle">
                    {selected.tools.map(tool => (
                      <div key={tool.id} className="flex items-start gap-3 px-4 py-3 hover:bg-bg-raised transition-colors">
                        <button onClick={() => toggleTool(tool)} title={tool.enabled ? 'Disable' : 'Enable'}
                          className={`mt-0.5 flex-shrink-0 transition-colors ${tool.enabled ? 'text-status-healthy' : 'text-text-muted hover:text-status-healthy'}`}>
                          {tool.enabled ? <Zap size={14} /> : <ZapOff size={14} />}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-primary font-mono">{tool.name}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle">
                              {EXEC_TYPE_LABELS[tool.execType] ?? tool.execType}
                            </span>
                            {tool.builtIn && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">built-in</span>
                            )}
                          </div>
                          <p className="text-xs text-text-muted mt-0.5 truncate">{tool.description}</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {!tool.builtIn && (
                            <button onClick={() => openEditTool(tool)}
                              className="p-1 rounded text-text-muted hover:text-accent transition-colors" title="Edit">
                              <Pencil size={12} />
                            </button>
                          )}
                          {confirmDeleteTool === tool.id ? (
                            <div className="flex items-center gap-1">
                              <button onClick={() => deleteTool(tool.id)}
                                className="px-2 py-0.5 text-[10px] rounded bg-status-error text-white hover:bg-status-error/80">
                                Confirm
                              </button>
                              <button onClick={() => setConfirmDeleteTool(null)}
                                className="p-1 rounded text-text-muted hover:text-text-primary">
                                <X size={11} />
                              </button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmDeleteTool(tool.id)}
                              className="p-1 rounded text-text-muted hover:text-status-error transition-colors" title="Delete">
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'agents' && (
              <div className="space-y-4 max-w-2xl">
                {selected.agents.length === 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
                    No agents linked to this environment.
                  </div>
                ) : (
                  <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden divide-y divide-border-subtle">
                    {selected.agents.map(ae => (
                      <div key={ae.id} className="flex items-center gap-3 px-4 py-3">
                        <Bot size={14} className="text-text-muted flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-text-primary">{ae.agent.name}</p>
                          <p className="text-xs text-text-muted">{ae.agent.role ?? ae.agent.type}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          Select an environment or create one to get started
        </div>
      )}

      {/* ── Environment modal ── */}
      {envModalOpen && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setEnvModal(null)}>
          <div className="w-full max-w-md bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <h2 className="text-sm font-semibold text-text-primary">
                {envModal === 'create' ? 'New Environment' : `Edit · ${selected?.name}`}
              </h2>
              <button onClick={() => setEnvModal(null)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>

            <div className="p-5 space-y-3">
              {envError && <div className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">{envError}</div>}

              <div>
                <label className={labelCls}>Name *</label>
                <input value={envForm.name} onChange={e => setEnvForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="K3s Cluster" className={inputCls} autoFocus />
              </div>
              <div>
                <label className={labelCls}>Type</label>
                <select value={envForm.type} onChange={e => setEnvForm(f => ({ ...f, type: e.target.value }))} className={inputCls}>
                  <option value="cluster">Cluster (kubectl)</option>
                  <option value="docker">Docker Node</option>
                  <option value="remote">Remote / Other</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input value={envForm.description} onChange={e => setEnvForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Main K3s homelab cluster" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>
                  <Link2 size={10} className="inline mr-1" />
                  Gateway URL
                </label>
                <input value={envForm.gatewayUrl} onChange={e => setEnvForm(f => ({ ...f, gatewayUrl: e.target.value }))}
                  placeholder="http://gateway.khalis.corp:3001" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Gateway Token (leave blank to keep existing)</label>
                <input type="password" value={envForm.gatewayToken} onChange={e => setEnvForm(f => ({ ...f, gatewayToken: e.target.value }))}
                  placeholder="••••••••" className={inputCls} autoComplete="off" />
              </div>
            </div>

            <div className="flex items-center gap-2 px-5 py-4 border-t border-border-subtle">
              {envModal === 'edit' && (
                <button onClick={deleteEnv} className="px-3 py-1.5 text-xs rounded border border-status-error/40 text-status-error hover:bg-status-error/10 transition-colors">
                  <Trash2 size={11} className="inline mr-1" />Delete
                </button>
              )}
              <div className="flex-1" />
              <button onClick={() => setEnvModal(null)} className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={saveEnv} disabled={envSaving}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {envSaving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
                {envSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Deploy Gateway modal ── */}
      {deployModal && selected && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { setDeployModal(false); setDeployResult(null) }}>
          <div className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <div className="flex items-center gap-2">
                <Rocket size={14} className="text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">Deploy Gateway · {selected.name}</h2>
              </div>
              <button onClick={() => { setDeployModal(false); setDeployResult(null) }} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>

            <div className="p-5 space-y-4">
              {!deployResult ? (
                <>
                  <p className="text-xs text-text-muted">
                    Generate a one-time join token. The gateway uses it on first boot to register itself — no manual credential copying needed.
                  </p>
                  <div>
                    <label className={labelCls}>Gateway Type</label>
                    <select value={deployGatewayType} onChange={e => setDeployGatewayType(e.target.value)} className={inputCls}>
                      <option value="cluster">Cluster (kubectl)</option>
                      <option value="docker">Docker Node</option>
                      <option value="remote">Remote / Other</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Gateway URL <span className="text-text-muted">(how ORION will reach this gateway after deployment)</span></label>
                    <input value={deployGatewayUrl} onChange={e => setDeployGatewayUrl(e.target.value)}
                      placeholder="http://10.2.2.84:3001 or http://orion-gateway.management.svc.cluster.local:3001"
                      className={inputCls} />
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => { setDeployModal(false); setDeployResult(null) }}
                      className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                      Cancel
                    </button>
                    <button onClick={generateJoinToken} disabled={deploying}
                      className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                      {deploying ? <RefreshCw size={11} className="animate-spin" /> : <Rocket size={11} />}
                      {deploying ? 'Generating…' : 'Generate Join Token'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-lg border border-status-healthy/30 bg-status-healthy/5 px-3 py-2 text-xs text-status-healthy">
                    Token generated — expires {new Date(deployResult.expiresAt).toLocaleString()}. One-time use only.
                  </div>

                  {/* Docker command */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                        <Terminal size={11} /> Docker
                      </label>
                      <button onClick={() => copyToClipboard(deployResult.dockerCmd, 'docker')}
                        className="flex items-center gap-1 text-[10px] text-text-muted hover:text-accent transition-colors">
                        {copied === 'docker' ? <CheckCheck size={11} className="text-status-healthy" /> : <Copy size={11} />}
                        {copied === 'docker' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <pre className="text-[11px] font-mono bg-bg-raised border border-border-subtle rounded p-3 overflow-x-auto text-text-secondary whitespace-pre">
                      {deployResult.dockerCmd}
                    </pre>
                  </div>

                  {/* kubectl command */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
                        <Server size={11} /> Kubernetes
                      </label>
                      <button onClick={() => copyToClipboard(deployResult.kubectlCmd, 'kubectl')}
                        className="flex items-center gap-1 text-[10px] text-text-muted hover:text-accent transition-colors">
                        {copied === 'kubectl' ? <CheckCheck size={11} className="text-status-healthy" /> : <Copy size={11} />}
                        {copied === 'kubectl' ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <pre className="text-[11px] font-mono bg-bg-raised border border-border-subtle rounded p-3 overflow-x-auto text-text-secondary whitespace-pre-wrap break-all">
                      {deployResult.kubectlCmd}
                    </pre>
                  </div>

                  <div className="flex justify-end pt-1">
                    <button onClick={() => { setDeployModal(false); setDeployResult(null) }}
                      className="px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors">
                      Done
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Tool modal ── */}
      {toolModalOpen && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setToolModal(null)}>
          <div className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <h2 className="text-sm font-semibold text-text-primary">
                {toolModal === 'create' ? 'New Tool' : `Edit · ${toolTarget?.name}`}
              </h2>
              <button onClick={() => setToolModal(null)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>

            <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
              {toolError && <div className="rounded border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">{toolError}</div>}

              <div>
                <label className={labelCls}>Tool Name * <span className="text-text-muted">(snake_case, e.g. run_script)</span></label>
                <input value={toolForm.name} onChange={e => setToolForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="run_script" className={`${inputCls} font-mono`} autoFocus />
              </div>
              <div>
                <label className={labelCls}>Description *</label>
                <input value={toolForm.description} onChange={e => setToolForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="What this tool does" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Execution Type</label>
                <select value={toolForm.execType} onChange={e => setToolForm(f => ({ ...f, execType: e.target.value }))} className={inputCls}>
                  <option value="shell">Shell command</option>
                  <option value="http">HTTP request</option>
                  <option value="builtin">Built-in function</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>
                  <Code2 size={10} className="inline mr-1" />
                  Input Schema <span className="text-text-muted">(JSON Schema)</span>
                </label>
                <textarea value={toolForm.inputSchema} onChange={e => setToolForm(f => ({ ...f, inputSchema: e.target.value }))}
                  rows={6} className={`${inputCls} font-mono text-xs resize-none`}
                  placeholder='{"type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"]}' />
              </div>
              <div>
                <label className={labelCls}>
                  Exec Config <span className="text-text-muted">(JSON — shell: {`{"command":"..."}`}, http: {`{"url":"..."}`})</span>
                </label>
                <textarea value={toolForm.execConfig} onChange={e => setToolForm(f => ({ ...f, execConfig: e.target.value }))}
                  rows={3} className={`${inputCls} font-mono text-xs resize-none`}
                  placeholder='{"command": "kubectl get pods -n {namespace}"}' />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
              <button onClick={() => setToolModal(null)} className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={saveTool} disabled={toolSaving}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {toolSaving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
                {toolSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
