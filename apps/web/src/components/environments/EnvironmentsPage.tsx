'use client'
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Trash2, Pencil, X, RefreshCw, Check,
  Server, Container, Globe, Zap, ZapOff, Bot, Code2, Link2,
  Terminal, Copy, CheckCheck, Rocket, Clock, CheckCircle, XCircle,
  Sparkles, ToggleLeft, ToggleRight, Layers, Shield, Users, ArrowUpCircle,
} from 'lucide-react'
import { ClusterPreflightFlow } from './ClusterPreflightFlow'

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
  status: string       // "active" | "pending" | "rejected"
  proposedBy: string | null
  proposedAt: string | null
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
  gatewayVersion: string | null
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

interface EnvForm { name: string; type: string; description: string; gatewayUrl: string; gatewayToken: string; kubeconfig: string; nodeIp: string; talosConfig: string }
const EMPTY_ENV: EnvForm = { name: '', type: 'cluster', description: '', gatewayUrl: '', gatewayToken: '', kubeconfig: '', nodeIp: '', talosConfig: '' }

// ─── Tool form ────────────────────────────────────────────────────────────────

interface ToolForm { name: string; description: string; inputSchema: string; execType: string; execConfig: string }
const EMPTY_TOOL: ToolForm = { name: '', description: '', inputSchema: DEFAULT_INPUT_SCHEMA, execType: 'shell', execConfig: '' }

// ─── Main component ───────────────────────────────────────────────────────────

export function EnvironmentsPage({ initialEnvironments }: { initialEnvironments: Environment[] }) {
  const [environments, setEnvironments] = useState<Environment[]>(initialEnvironments)
  const [selected, setSelected]         = useState<Environment | null>(initialEnvironments[0] ?? null)
  const [tab, setTab]                   = useState<'tools' | 'agents' | 'groups' | 'access'>('tools')

  // ── Tool groups state ────────────────────────────────────────────────────────
  interface ToolGroup {
    id: string; name: string; description: string | null; minimumTier: string; environmentId: string
    tools: { toolId: string; tool: McpTool }[]
    agentAccess: { agentGroupId: string; agentGroup: { id: string; name: string } }[]
  }
  const [toolGroups, setToolGroups]       = useState<ToolGroup[]>([])
  const [toolGroupsLoaded, setToolGroupsLoaded] = useState(false)
  const [tgModal, setTgModal]             = useState<'create' | 'edit' | null>(null)
  const [tgTarget, setTgTarget]           = useState<ToolGroup | null>(null)
  const [tgForm, setTgForm]               = useState({ name: '', description: '', minimumTier: 'viewer' })
  const [tgSaving, setTgSaving]           = useState(false)
  const [confirmDeleteTg, setConfirmDeleteTg] = useState<string | null>(null)
  const [tgAddingTool, setTgAddingTool]   = useState<string | null>(null) // tool group id

  // ── Agent linking state ───────────────────────────────────────────────────────
  interface AllAgent { id: string; name: string; type: string; role: string | null }
  const [allAgents, setAllAgents]       = useState<AllAgent[]>([])
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [showAddAgent, setShowAddAgent] = useState(false)
  const [agentLinking, setAgentLinking] = useState(false)
  const [agentSearch, setAgentSearch]   = useState('')

  // ── User tiers state ─────────────────────────────────────────────────────────
  interface UserTier {
    userId: string; tier: string; environmentId: string
    user: { id: string; username: string; email: string; name: string | null; role: string }
  }
  interface AllUser { id: string; username: string; email: string; name: string | null; role: string }
  const [userTiers, setUserTiers]         = useState<UserTier[]>([])
  const [allUsers, setAllUsers]           = useState<AllUser[]>([])
  const [tiersLoaded, setTiersLoaded]     = useState(false)
  const [assigningTier, setAssigningTier] = useState<{ userId: string; tier: string } | null>(null)
  const [showAddUser, setShowAddUser]     = useState(false)
  const [userSearch, setUserSearch]       = useState('')

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

  // SSE bootstrap log state (localhost/docker environments)
  interface BootstrapLog { type: 'step' | 'log' | 'error' | 'done'; message: string }
  const [bootstrapLogs, setBootstrapLogs] = useState<BootstrapLog[]>([])
  const [bootstrapDone, setBootstrapDone] = useState(false)

  // Cluster bootstrap state
  const [bootstrapModal, setBootstrapModal]             = useState(false)
  const [clusterBootstrapLogs, setClusterBootstrapLogs] = useState<BootstrapLog[]>([])
  const [clusterBootstrapDone, setClusterBootstrapDone] = useState(false)
  const [clusterBootstrapping, setClusterBootstrapping] = useState(false)
  const [preflightPassed, setPreflightPassed]           = useState(false)
  const [kubeconfigSaving, setKubeconfigSaving]         = useState(false)

  // Gateway update state
  const [gatewayUpdating, setGatewayUpdating] = useState(false)
  const [gatewayUpdateMsg, setGatewayUpdateMsg] = useState<string | null>(null)

  // Pending tool approval state
  const [approvingTool, setApprovingTool] = useState<string | null>(null)

  // Tool detail modal (click to inspect / toggle enable)
  const [toolDetailModal, setToolDetailModal] = useState<McpTool | null>(null)

  // Tool CRUD state
  const [toolModal, setToolModal]   = useState<'create' | 'edit' | null>(null)
  const [toolTarget, setToolTarget] = useState<McpTool | null>(null)
  const [toolForm, setToolForm]     = useState<ToolForm>(EMPTY_TOOL)
  const [toolSaving, setToolSaving] = useState(false)
  const [toolError, setToolError]   = useState<string | null>(null)
  const [confirmDeleteTool, setConfirmDeleteTool] = useState<string | null>(null)

  // AI tool generation state
  const [aiToolDesc, setAiToolDesc]       = useState('')
  const [aiGenerating, setAiGenerating]   = useState(false)
  const [aiGenError, setAiGenError]       = useState<string | null>(null)

  // ── helpers ──────────────────────────────────────────────────────────────────

  const reload = async () => {
    const res = await fetch('/api/environments')
    if (!res.ok) return
    const data: Environment[] = await res.json()
    setEnvironments(data)
    if (selected) setSelected(data.find(e => e.id === selected.id) ?? data[0] ?? null)
  }

  const syncSelected = (updated: Environment) => {
    setEnvironments(prev => prev.map(e => e.id === updated.id ? updated : e))
    setSelected(updated)
  }

  // ── Gateway update ────────────────────────────────────────────────────────────

  const triggerGatewayUpdate = async (env: Environment) => {
    setGatewayUpdating(true)
    setGatewayUpdateMsg(null)
    try {
      const res = await fetch(`/api/environments/${env.id}/gateway`, { method: 'POST' })
      const data = await res.json() as { ok?: boolean; message?: string; error?: string }
      setGatewayUpdateMsg(data.message ?? data.error ?? 'Done')
      setTimeout(() => setGatewayUpdateMsg(null), 5000)
    } catch (e) {
      setGatewayUpdateMsg(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setGatewayUpdating(false)
    }
  }

  // ── Deploy gateway ────────────────────────────────────────────────────────────

  const openDeploy = (env: Environment) => {
    setDeployGatewayUrl('')
    setDeployGatewayType(env.type)
    setDeployResult(null)
    setBootstrapLogs([])
    setBootstrapDone(false)
    setDeployModal(true)
  }

  const runLocalBootstrap = async () => {
    if (!selected) return
    setDeploying(true)
    setBootstrapLogs([])
    setBootstrapDone(false)
    try {
      const res = await fetch(`/api/environments/${selected.id}/deploy-gateway`, { method: 'POST' })
      if (!res.ok || !res.body) throw new Error(`Bootstrap failed: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() ?? ''
        for (const chunk of lines) {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const evt = JSON.parse(dataLine.slice(6)) as BootstrapLog
            setBootstrapLogs(prev => [...prev, evt])
            if (evt.type === 'done' || evt.type === 'error') {
              setBootstrapDone(true)
              if (evt.type === 'done') reload()
            }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (e) {
      setBootstrapLogs(prev => [...prev, { type: 'error', message: e instanceof Error ? e.message : String(e) }])
      setBootstrapDone(true)
    } finally {
      setDeploying(false)
    }
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

  // ── Cluster bootstrap ─────────────────────────────────────────────────────────

  const openBootstrap = (env: Environment) => {
    void env
    setClusterBootstrapLogs([])
    setClusterBootstrapDone(false)
    setClusterBootstrapping(false)
    setPreflightPassed(false)
    setBootstrapModal(true)
  }

  const runClusterBootstrap = async () => {
    if (!selected) return
    setClusterBootstrapping(true)
    setClusterBootstrapLogs([])
    setClusterBootstrapDone(false)
    try {
      const res = await fetch(`/api/environments/${selected.id}/bootstrap`, { method: 'POST' })
      if (!res.ok || !res.body) throw new Error(`Bootstrap failed: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n\n')
        buf = lines.pop() ?? ''
        for (const chunk of lines) {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const evt = JSON.parse(dataLine.slice(6)) as BootstrapLog
            setClusterBootstrapLogs(prev => [...prev, evt])
            if (evt.type === 'done' || evt.type === 'error') {
              setClusterBootstrapDone(true)
              if (evt.type === 'done') reload()
            }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (e) {
      setClusterBootstrapLogs(prev => [...prev, { type: 'error', message: e instanceof Error ? e.message : String(e) }])
      setClusterBootstrapDone(true)
    } finally {
      setClusterBootstrapping(false)
    }
  }

  const copyToClipboard = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Environment modals ────────────────────────────────────────────────────────

  const openCreateEnv = () => { setEnvForm(EMPTY_ENV); setEnvError(null); setEnvModal('create') }
  const openEditEnv = (env: Environment) => {
    const meta = (env as unknown as { metadata?: Record<string, unknown> }).metadata ?? {}
    setEnvForm({ name: env.name, type: env.type, description: env.description ?? '', gatewayUrl: env.gatewayUrl ?? '', gatewayToken: '', kubeconfig: '', nodeIp: (meta.nodeIp as string) ?? '', talosConfig: '' })
    setEnvError(null)
    setEnvModal('edit')
  }

  const saveEnv = async () => {
    if (!envForm.name.trim()) { setEnvError('Name is required'); return }
    setEnvSaving(true); setEnvError(null)
    try {
      const kubeconfigB64 = envForm.kubeconfig.trim()
        ? btoa(unescape(encodeURIComponent(envForm.kubeconfig.trim())))
        : undefined
      const currentMeta = (selected as unknown as { metadata?: Record<string, unknown> })?.metadata ?? {}
      let metaUpdate: Record<string, unknown> = { ...currentMeta }
      if (envForm.type === 'cluster') {
        if (envForm.nodeIp.trim()) metaUpdate.nodeIp = envForm.nodeIp.trim()
        if (envForm.talosConfig.trim()) {
          // Store as base64 so we can pass it directly to gateway tools
          metaUpdate.talosConfig = btoa(unescape(encodeURIComponent(envForm.talosConfig.trim())))
        }
      }
      const payload = { name: envForm.name.trim(), type: envForm.type, description: envForm.description || null, gatewayUrl: envForm.gatewayUrl || null, gatewayToken: envForm.gatewayToken || undefined, kubeconfig: kubeconfigB64, metadata: metaUpdate }
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

  const approveTool = async (toolId: string) => {
    if (!selected) return
    setApprovingTool(toolId)
    try {
      const res = await fetch(`/api/environments/${selected.id}/tools/${toolId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (res.ok) {
        const updated: McpTool = await res.json()
        syncSelected({ ...selected, tools: selected.tools.map(t => t.id === updated.id ? updated : t) })
      }
    } finally { setApprovingTool(null) }
  }

  const rejectTool = async (toolId: string) => {
    if (!selected) return
    const res = await fetch(`/api/environments/${selected.id}/tools/${toolId}/reject`, { method: 'POST' })
    if (res.ok) {
      const updated: McpTool = await res.json()
      syncSelected({ ...selected, tools: selected.tools.map(t => t.id === updated.id ? updated : t) })
    }
  }

  // ── Tool groups ───────────────────────────────────────────────────────────────

  const loadToolGroups = useCallback(async () => {
    if (!selected) return
    const data = await fetch(`/api/tool-groups?environmentId=${selected.id}`).then(r => r.json())
    setToolGroups(data)
    setToolGroupsLoaded(true)
  }, [selected])

  useEffect(() => {
    if (tab === 'groups' && selected && !toolGroupsLoaded) loadToolGroups()
  }, [tab, selected, toolGroupsLoaded, loadToolGroups])

  useEffect(() => { setToolGroupsLoaded(false) }, [selected?.id])

  const saveTg = async () => {
    if (!selected || !tgForm.name.trim()) return
    setTgSaving(true)
    try {
      if (tgModal === 'create') {
        await fetch('/api/tool-groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tgForm.name.trim(), description: tgForm.description.trim() || null, minimumTier: tgForm.minimumTier, environmentId: selected.id }),
        })
      } else if (tgTarget) {
        await fetch(`/api/tool-groups/${tgTarget.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tgForm.name.trim(), description: tgForm.description.trim() || null, minimumTier: tgForm.minimumTier }),
        })
      }
      await loadToolGroups()
      setTgModal(null)
    } finally { setTgSaving(false) }
  }

  const deleteTg = async (id: string) => {
    await fetch(`/api/tool-groups/${id}`, { method: 'DELETE' })
    setToolGroups(prev => prev.filter(g => g.id !== id))
    setConfirmDeleteTg(null)
  }

  const addToolToGroup = async (tgId: string, toolId: string) => {
    await fetch(`/api/tool-groups/${tgId}/tools`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolId }),
    })
    await loadToolGroups()
    setTgAddingTool(null)
  }

  const removeToolFromGroup = async (tgId: string, toolId: string) => {
    await fetch(`/api/tool-groups/${tgId}/tools?toolId=${toolId}`, { method: 'DELETE' })
    await loadToolGroups()
  }

  // ── User tiers ────────────────────────────────────────────────────────────────

  const loadAllAgents = useCallback(async () => {
    if (agentsLoaded) return
    const data: AllAgent[] = await fetch('/api/agents').then(r => r.json())
    setAllAgents(data)
    setAgentsLoaded(true)
  }, [agentsLoaded])

  const linkAgent = async (agentId: string) => {
    if (!selected) return
    setAgentLinking(true)
    try {
      const res = await fetch(`/api/environments/${selected.id}/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }),
      })
      if (!res.ok) return
      const link = await res.json() as { id: string; agentId: string; agent: AllAgent }
      setEnvironments(prev => prev.map(e =>
        e.id === selected.id ? { ...e, agents: [...e.agents, { id: link.id, agentId: link.agentId, agent: link.agent }] } : e
      ))
      setSelected(prev => prev ? { ...prev, agents: [...prev.agents, { id: link.id, agentId: link.agentId, agent: link.agent }] } : prev)
      setShowAddAgent(false)
      setAgentSearch('')
    } finally { setAgentLinking(false) }
  }

  const unlinkAgent = async (agentId: string) => {
    if (!selected) return
    await fetch(`/api/environments/${selected.id}/agents/${agentId}`, { method: 'DELETE' })
    setEnvironments(prev => prev.map(e =>
      e.id === selected.id ? { ...e, agents: e.agents.filter(a => a.agentId !== agentId) } : e
    ))
    setSelected(prev => prev ? { ...prev, agents: prev.agents.filter(a => a.agentId !== agentId) } : prev)
  }

  const loadUserTiers = useCallback(async () => {
    if (!selected) return
    const [tiersData, usersData] = await Promise.all([
      fetch(`/api/environments/${selected.id}/user-tiers`).then(r => r.json()),
      fetch('/api/admin/users').then(r => r.json()),
    ])
    setUserTiers(tiersData)
    setAllUsers(usersData)
    setTiersLoaded(true)
  }, [selected])

  useEffect(() => {
    if (tab === 'agents' && !agentsLoaded) loadAllAgents()
  }, [tab, agentsLoaded, loadAllAgents])

  useEffect(() => {
    if (tab === 'access' && selected && !tiersLoaded) loadUserTiers()
  }, [tab, selected, tiersLoaded, loadUserTiers])

  useEffect(() => { setTiersLoaded(false) }, [selected?.id])

  const setUserTier = async (userId: string, tier: string) => {
    if (!selected) return
    setAssigningTier({ userId, tier })
    try {
      await fetch(`/api/environments/${selected.id}/user-tiers`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, tier }),
      })
      await loadUserTiers()
    } finally { setAssigningTier(null) }
  }

  const removeUserTier = async (userId: string) => {
    if (!selected) return
    await fetch(`/api/environments/${selected.id}/user-tiers?userId=${userId}`, { method: 'DELETE' })
    setUserTiers(prev => prev.filter(t => t.userId !== userId))
  }

  const generateToolWithAI = async () => {
    if (!aiToolDesc.trim() || !selected) return
    setAiGenerating(true); setAiGenError(null)
    try {
      const res = await fetch('/api/tools/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: aiToolDesc.trim(), environmentType: selected.type }),
      })
      if (!res.ok) {
        const err = await res.json() as { error: string }
        throw new Error(err.error)
      }
      const generated = await res.json() as { name: string; description: string; command: string; inputSchema: object; execType: string; execConfig: object }
      setToolForm({
        name:        generated.name,
        description: generated.description,
        inputSchema: JSON.stringify(generated.inputSchema, null, 2),
        execType:    generated.execType,
        execConfig:  JSON.stringify(generated.execConfig, null, 2),
      })
      setAiToolDesc('')
    } catch (e) {
      setAiGenError(e instanceof Error ? e.message : 'AI generation failed')
    } finally {
      setAiGenerating(false)
    }
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
              <p className="text-[10px] text-text-muted mt-0.5 pl-3.5 truncate flex items-center gap-1.5">
                {env.tools.filter(t => t.enabled && t.status === 'active').length} tools enabled · {env.status}
                {env.tools.filter(t => t.status === 'pending').length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-orange-500 text-white text-[9px] font-bold">
                    {env.tools.filter(t => t.status === 'pending').length}
                  </span>
                )}
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
            {selected.gatewayVersion && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono bg-bg-raised text-text-muted border border-border-subtle" title="Gateway version">
                v{selected.gatewayVersion}
              </span>
            )}
            {selected.status === 'connected' && (
              <button onClick={() => triggerGatewayUpdate(selected)} disabled={gatewayUpdating}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-text-muted border border-border-subtle hover:text-accent hover:border-accent/50 transition-colors disabled:opacity-50"
                title={gatewayUpdateMsg ?? 'Update gateway to latest image'}>
                <ArrowUpCircle size={12} className={gatewayUpdating ? 'animate-spin' : ''} />
                {gatewayUpdating ? 'Updating…' : gatewayUpdateMsg ?? 'Update'}
              </button>
            )}
            {selected.type === 'cluster' ? (
              <button onClick={() => openBootstrap(selected)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors" title="Bootstrap GitOps environment">
                <Rocket size={12} /> Bootstrap
              </button>
            ) : (
              <button onClick={() => openDeploy(selected)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 transition-colors" title="Deploy gateway">
                <Rocket size={12} /> Deploy Gateway
              </button>
            )}
            <button onClick={() => openEditEnv(selected)}
              className="p-1.5 rounded text-text-muted hover:text-accent hover:bg-bg-raised transition-colors" title="Edit environment">
              <Pencil size={14} />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-0 border-b border-border-subtle flex-shrink-0 px-6">
            {(['tools', 'agents', 'groups', 'access'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`py-2.5 px-4 text-xs font-medium capitalize transition-colors border-b-2 -mb-px ${
                  tab === t ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-primary'
                }`}>
                {t === 'tools'   ? `Tools (${selected.tools.length})` :
                 t === 'agents'  ? `Agents (${selected.agents.length})` :
                 t === 'groups'  ? 'Tool Groups' :
                 'Access'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">

            {tab === 'tools' && (
              <div className="space-y-4 max-w-3xl">

                {/* Pending tool proposals — individual orange-bordered cards */}
                {selected.tools.filter(t => t.status === 'pending').map(tool => (
                  <div key={tool.id} className="rounded-lg border-2 border-orange-500 bg-orange-500/5 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 border-b border-orange-500/30">
                      <Clock size={12} className="text-orange-400 flex-shrink-0" />
                      <span className="text-xs font-semibold text-orange-400 flex-1">Pending Approval</span>
                      {tool.proposedAt && (
                        <span className="text-[10px] text-orange-400/70">{new Date(tool.proposedAt).toLocaleString()}</span>
                      )}
                    </div>
                    <div className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-text-primary font-mono">{tool.name}</span>
                          <p className="text-xs text-text-muted mt-0.5">{tool.description}</p>
                          {tool.execConfig && (
                            <code className="mt-1.5 block text-[11px] bg-bg-raised rounded px-2 py-1 text-text-secondary font-mono truncate border border-orange-500/20">
                              {(tool.execConfig as { command?: string }).command ?? ''}
                            </code>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button
                            onClick={() => rejectTool(tool.id)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-status-error border border-status-error/30 hover:bg-status-error/10 transition-colors">
                            <XCircle size={12} /> Reject
                          </button>
                          <button
                            onClick={() => setToolDetailModal(tool)}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium text-text-secondary border border-border-subtle hover:text-accent hover:border-accent/40 transition-colors">
                            View
                          </button>
                          <button
                            onClick={() => approveTool(tool.id)}
                            disabled={approvingTool === tool.id}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium bg-status-healthy/15 text-status-healthy border border-status-healthy/30 hover:bg-status-healthy/25 transition-colors disabled:opacity-50">
                            <CheckCircle size={12} /> {approvingTool === tool.id ? 'Approving…' : 'Approve'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="flex items-center justify-between">
                  <p className="text-xs text-text-muted">
                    {selected.tools.filter(t => t.enabled && t.status === 'active').length} of {selected.tools.filter(t => t.status === 'active').length} active tools enabled
                  </p>
                  <button onClick={openCreateTool}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors">
                    <Plus size={12} /> Add Tool
                  </button>
                </div>

                {selected.tools.filter(t => t.status === 'active').length === 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
                    No tools configured. Add a custom tool or connect a gateway to sync built-in tools.
                  </div>
                ) : (
                  <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden divide-y divide-border-subtle">
                    {selected.tools.filter(t => t.status === 'active').map(tool => (
                      <div key={tool.id} className="flex items-start gap-3 px-4 py-3 hover:bg-bg-raised transition-colors cursor-pointer"
                        onClick={() => setToolDetailModal(tool)}>
                        <span onClick={e => { e.stopPropagation(); toggleTool(tool) }} title={tool.enabled ? 'Disable' : 'Enable'}
                          className={`mt-0.5 flex-shrink-0 transition-colors cursor-pointer ${tool.enabled ? 'text-status-healthy' : 'text-text-muted hover:text-status-healthy'}`}>
                          {tool.enabled ? <Zap size={14} /> : <ZapOff size={14} />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text-primary font-mono">{tool.name}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle">
                              {EXEC_TYPE_LABELS[tool.execType] ?? tool.execType}
                            </span>
                            {tool.builtIn && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">built-in</span>
                            )}
                            {!tool.enabled && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle">disabled</span>
                            )}
                          </div>
                          <p className="text-xs text-text-muted mt-0.5 truncate">{tool.description}</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
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
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Linked Agents</p>
                    <p className="text-xs text-text-muted mt-0.5">Agents linked here get priority routing to this environment&apos;s gateway tools</p>
                  </div>
                  <button
                    onClick={() => { setShowAddAgent(v => !v); setAgentSearch(''); loadAllAgents() }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors">
                    <Plus size={12} /> Link Agent
                  </button>
                </div>

                {showAddAgent && (
                  <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-2">
                    <p className="text-xs font-medium text-text-muted">Select an agent to link</p>
                    <input
                      value={agentSearch}
                      onChange={e => setAgentSearch(e.target.value)}
                      placeholder="Search agents…"
                      className={inputCls}
                    />
                    <div className="max-h-48 overflow-y-auto rounded border border-border-subtle divide-y divide-border-subtle">
                      {allAgents
                        .filter(a =>
                          !selected.agents.some(ae => ae.agentId === a.id) &&
                          (agentSearch === '' || a.name.toLowerCase().includes(agentSearch.toLowerCase()))
                        )
                        .map(a => (
                          <button
                            key={a.id}
                            onClick={() => linkAgent(a.id)}
                            disabled={agentLinking}
                            className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-raised transition-colors disabled:opacity-50">
                            <Bot size={13} className="text-text-muted flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-text-primary">{a.name}</p>
                              <p className="text-[11px] text-text-muted">{a.role ?? a.type}</p>
                            </div>
                          </button>
                        ))}
                      {allAgents.filter(a =>
                        !selected.agents.some(ae => ae.agentId === a.id) &&
                        (agentSearch === '' || a.name.toLowerCase().includes(agentSearch.toLowerCase()))
                      ).length === 0 && (
                        <p className="px-3 py-4 text-xs text-text-muted text-center">
                          {agentSearch ? 'No matching agents' : 'All agents are already linked'}
                        </p>
                      )}
                    </div>
                  </div>
                )}

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
                        <button
                          onClick={() => unlinkAgent(ae.agentId)}
                          className="p-1 rounded text-text-muted hover:text-status-error transition-colors"
                          title="Unlink agent">
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'groups' && (
              <div className="space-y-4 max-w-3xl">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Tool Groups</p>
                    <p className="text-xs text-text-muted mt-0.5">Group tools together and set a minimum user tier required to run them</p>
                  </div>
                  <button onClick={() => { setTgForm({ name: '', description: '', minimumTier: 'viewer' }); setTgTarget(null); setTgModal('create') }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors">
                    <Plus size={12} /> New Group
                  </button>
                </div>

                {!toolGroupsLoaded ? (
                  <div className="text-center py-8 text-xs text-text-muted"><RefreshCw size={14} className="animate-spin mx-auto mb-2" />Loading…</div>
                ) : toolGroups.length === 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
                    No tool groups yet. Create one to group tools and set access tiers.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {toolGroups.map(tg => (
                      <div key={tg.id} className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
                        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-raised/50">
                          <Layers size={13} className="text-text-muted flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary">{tg.name}</p>
                            {tg.description && <p className="text-xs text-text-muted">{tg.description}</p>}
                          </div>
                          <span className={`text-[10px] px-2 py-0.5 rounded font-medium flex items-center gap-1 ${
                            tg.minimumTier === 'admin' ? 'bg-orange-500/15 text-orange-400' :
                            tg.minimumTier === 'operator' ? 'bg-blue-500/15 text-blue-400' :
                            'bg-bg-raised text-text-muted border border-border-subtle'
                          }`}>
                            <Shield size={9} /> min: {tg.minimumTier}
                          </span>
                          <button onClick={() => { setTgTarget(tg); setTgForm({ name: tg.name, description: tg.description ?? '', minimumTier: tg.minimumTier }); setTgModal('edit') }}
                            className="p-1 rounded text-text-muted hover:text-accent transition-colors"><Pencil size={12} /></button>
                          {confirmDeleteTg === tg.id ? (
                            <div className="flex items-center gap-1">
                              <button onClick={() => deleteTg(tg.id)} className="px-2 py-0.5 text-[10px] rounded bg-status-error text-white">Del</button>
                              <button onClick={() => setConfirmDeleteTg(null)} className="p-0.5 text-text-muted"><X size={10} /></button>
                            </div>
                          ) : (
                            <button onClick={() => setConfirmDeleteTg(tg.id)} className="p-1 rounded text-text-muted hover:text-status-error transition-colors"><Trash2 size={12} /></button>
                          )}
                        </div>
                        <div className="p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide">Tools in group ({tg.tools.length})</p>
                            <button onClick={() => setTgAddingTool(tgAddingTool === tg.id ? null : tg.id)}
                              className="flex items-center gap-1 text-[11px] text-text-muted hover:text-accent transition-colors">
                              <Plus size={10} /> Add
                            </button>
                          </div>
                          {tgAddingTool === tg.id && (
                            <div className="rounded border border-border-subtle bg-bg-raised p-2 space-y-1 max-h-36 overflow-y-auto">
                              {selected.tools.filter(t => t.status === 'active' && !tg.tools.some(tt => tt.toolId === t.id)).map(t => (
                                <button key={t.id} onClick={() => addToolToGroup(tg.id, t.id)}
                                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left hover:bg-bg-card transition-colors">
                                  <Zap size={11} className="text-text-muted" />
                                  <span className="font-mono text-text-primary">{t.name}</span>
                                </button>
                              ))}
                              {selected.tools.filter(t => t.status === 'active' && !tg.tools.some(tt => tt.toolId === t.id)).length === 0 && (
                                <p className="text-xs text-text-muted text-center py-2">All tools already in group</p>
                              )}
                            </div>
                          )}
                          {tg.tools.length === 0 ? (
                            <p className="text-xs text-text-muted">No tools in this group yet</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {tg.tools.map(tt => (
                                <span key={tt.toolId} className="flex items-center gap-1 px-2 py-0.5 rounded bg-bg-raised border border-border-subtle text-[11px] text-text-secondary font-mono">
                                  {tt.tool.name}
                                  <button onClick={() => removeToolFromGroup(tg.id, tt.toolId)} className="text-text-muted hover:text-status-error transition-colors"><X size={9} /></button>
                                </span>
                              ))}
                            </div>
                          )}
                          {tg.agentAccess.length > 0 && (
                            <div>
                              <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1">Agent group access</p>
                              <div className="flex flex-wrap gap-1.5">
                                {tg.agentAccess.map(aa => (
                                  <span key={aa.agentGroupId} className="px-2 py-0.5 rounded bg-accent/10 border border-accent/20 text-[11px] text-accent">
                                    {aa.agentGroup.name}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'access' && (
              <div className="space-y-4 max-w-2xl">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-text-primary">User Access Tiers</p>
                    <p className="text-xs text-text-muted mt-0.5">Control which users can run restricted tools in this environment</p>
                  </div>
                  <button onClick={() => { setShowAddUser(true); setUserSearch('') }}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors">
                    <Plus size={12} /> Assign User
                  </button>
                </div>

                <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-1 text-xs text-text-muted">
                  <p><strong className="text-text-secondary">viewer</strong> — can read (default for all users with no explicit tier)</p>
                  <p><strong className="text-text-secondary">operator</strong> — can run operator-level tools without approval</p>
                  <p><strong className="text-text-secondary">admin</strong> — full access, can run all tools without approval</p>
                  <p className="text-[11px] mt-1">Users not listed here default to <em>viewer</em>. Admins in ORION always have admin tier everywhere.</p>
                </div>

                {showAddUser && (
                  <div className="rounded-lg border border-border-subtle bg-bg-card p-3 space-y-2">
                    <input
                      value={userSearch}
                      onChange={e => setUserSearch(e.target.value)}
                      placeholder="Search users…"
                      className={inputCls}
                      autoFocus
                    />
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {allUsers.filter(u =>
                        !userTiers.some(t => t.userId === u.id) &&
                        (u.username.toLowerCase().includes(userSearch.toLowerCase()) || (u.name ?? '').toLowerCase().includes(userSearch.toLowerCase()))
                      ).map(u => (
                        <div key={u.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-raised transition-colors">
                          <Users size={12} className="text-text-muted flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-text-primary">{u.name ?? u.username}</p>
                            <p className="text-[10px] text-text-muted">{u.username}</p>
                          </div>
                          {(['viewer', 'operator', 'admin'] as const).map(tier => (
                            <button key={tier} onClick={() => { setUserTier(u.id, tier); setShowAddUser(false) }}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                                tier === 'admin' ? 'border-orange-500/30 text-orange-400 hover:bg-orange-500/10' :
                                tier === 'operator' ? 'border-blue-500/30 text-blue-400 hover:bg-blue-500/10' :
                                'border-border-subtle text-text-muted hover:bg-bg-raised'
                              }`}>{tier}</button>
                          ))}
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setShowAddUser(false)} className="text-xs text-text-muted hover:text-text-primary transition-colors">Cancel</button>
                  </div>
                )}

                {!tiersLoaded ? (
                  <div className="text-center py-8 text-xs text-text-muted"><RefreshCw size={14} className="animate-spin mx-auto mb-2" />Loading…</div>
                ) : userTiers.length === 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-bg-card px-4 py-10 text-center text-sm text-text-muted">
                    No explicit user tiers set. All users default to viewer.
                  </div>
                ) : (
                  <div className="rounded-lg border border-border-subtle bg-bg-card divide-y divide-border-subtle overflow-hidden">
                    {userTiers.map(ut => (
                      <div key={ut.userId} className="flex items-center gap-3 px-4 py-2.5">
                        <Users size={13} className="text-text-muted flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-text-primary">{ut.user.name ?? ut.user.username}</p>
                          <p className="text-xs text-text-muted">{ut.user.username} · ORION role: {ut.user.role}</p>
                        </div>
                        <select
                          value={ut.tier}
                          onChange={e => setUserTier(ut.userId, e.target.value)}
                          disabled={!!assigningTier}
                          className="px-2 py-1 text-xs bg-bg-raised border border-border-subtle rounded text-text-primary focus:outline-none focus:border-accent">
                          <option value="viewer">viewer</option>
                          <option value="operator">operator</option>
                          <option value="admin">admin</option>
                        </select>
                        <button onClick={() => removeUserTier(ut.userId)}
                          className="p-1 rounded text-text-muted hover:text-status-error transition-colors">
                          <X size={12} />
                        </button>
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
              {envForm.type === 'cluster' && (
                <>
                  <div>
                    <label className={labelCls}>
                      <Server size={10} className="inline mr-1" />
                      Control plane node IP
                      <span className="text-text-muted ml-1">(used to auto-fetch kubeconfig)</span>
                    </label>
                    <input
                      value={envForm.nodeIp}
                      onChange={e => setEnvForm(f => ({ ...f, nodeIp: e.target.value }))}
                      placeholder="10.2.2.100"
                      className={inputCls}
                    />
                    <p className="text-[10px] text-text-muted mt-1">
                      ORION probes this IP to detect Talos (port 50000) or K3s (port 6443) and fetches credentials automatically.
                    </p>
                  </div>
                  <div>
                    <label className={labelCls}>
                      Kubeconfig <span className="text-text-muted">(optional override — leave blank to auto-fetch)</span>
                    </label>
                    <textarea
                      value={envForm.kubeconfig}
                      onChange={e => setEnvForm(f => ({ ...f, kubeconfig: e.target.value }))}
                      placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;  ..."
                      rows={4}
                      className={`${inputCls} font-mono text-[11px] resize-y`}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>
                      Talos Config{' '}
                      <span className="text-text-muted">(optional — enables auto-remediation of Talos prerequisites)</span>
                    </label>
                    <textarea
                      value={envForm.talosConfig}
                      onChange={e => setEnvForm(f => ({ ...f, talosConfig: e.target.value }))}
                      placeholder="context: <cluster-name>&#10;contexts:&#10;  <cluster-name>:&#10;    endpoints: [...]&#10;    ca: ...&#10;    crt: ...&#10;    key: ..."
                      rows={4}
                      className={`${inputCls} font-mono text-[11px] resize-y`}
                    />
                    <p className="text-[10px] text-text-muted mt-1">
                      Paste your <code className="font-mono">talosconfig</code> content here. Used by storage bootstrap to auto-install
                      extensions (e.g. iscsi-tools) and reboot nodes. Leave blank to skip auto-remediation.
                    </p>
                  </div>
                </>
              )}
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
              {(selected.type === 'localhost' || selected.type === 'docker') ? (
                /* ── localhost/docker: full SSE bootstrap ── */
                bootstrapLogs.length === 0 && !deploying ? (
                  <>
                    <p className="text-xs text-text-muted">
                      Deploys the gateway container, creates a Gitea repo with CI/CD scaffold, and registers a self-hosted Actions runner — all in one click.
                    </p>
                    <div className="flex justify-end gap-2 pt-1">
                      <button onClick={() => { setDeployModal(false) }}
                        className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                        Cancel
                      </button>
                      <button onClick={runLocalBootstrap} disabled={deploying}
                        className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                        <Rocket size={11} /> Deploy Everything
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
                      <div className="max-h-72 overflow-y-auto p-3 space-y-1 font-mono text-[11px]">
                        {bootstrapLogs.map((log, i) => (
                          <div key={i} className={
                            log.type === 'step'  ? 'text-accent font-semibold' :
                            log.type === 'error' ? 'text-status-error' :
                            log.type === 'done'  ? 'text-status-healthy font-semibold' :
                            'text-text-muted'
                          }>
                            {log.type === 'step' ? `▶ ${log.message}` :
                             log.type === 'done' ? `✓ ${log.message}` :
                             log.type === 'error' ? `✗ ${log.message}` :
                             `  ${log.message}`}
                          </div>
                        ))}
                        {deploying && !bootstrapDone && (
                          <div className="flex items-center gap-1.5 text-text-muted">
                            <RefreshCw size={10} className="animate-spin" /> Running…
                          </div>
                        )}
                      </div>
                    </div>
                    {bootstrapDone && (
                      <div className="flex justify-end pt-1">
                        <button onClick={() => { setDeployModal(false); setBootstrapLogs([]); setBootstrapDone(false) }}
                          className="px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors">
                          Done
                        </button>
                      </div>
                    )}
                  </>
                )
              ) : (
                /* ── cluster/remote: join token flow ── */
                !deployResult ? (
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
                )
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Cluster Bootstrap modal ── */}
      {bootstrapModal && selected && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { if (!clusterBootstrapping) setBootstrapModal(false) }}>
          <div className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <div className="flex items-center gap-2">
                <Rocket size={14} className="text-accent" />
                <h2 className="text-sm font-semibold text-text-primary">Bootstrap · {selected.name}</h2>
              </div>
              {!clusterBootstrapping && (
                <button onClick={() => setBootstrapModal(false)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
              )}
            </div>

            <div className="p-5 space-y-4">
              {/* Preflight — shared component handles detection, credential input, re-check */}
              {!preflightPassed && !clusterBootstrapLogs.length && (
                <ClusterPreflightFlow
                  envId={selected.id}
                  onReady={() => {
                    setPreflightPassed(true)
                    runClusterBootstrap()
                  }}
                />
              )}

              {/* Live bootstrap log stream */}
              {clusterBootstrapLogs.length > 0 && (
                <>
                  <div className="rounded-lg border border-border-subtle bg-bg-card overflow-hidden">
                    <div className="max-h-80 overflow-y-auto p-3 space-y-1 font-mono text-[11px]" id="bootstrap-log-scroll">
                      {clusterBootstrapLogs.map((log, i) => (
                        <div key={i} className={
                          log.type === 'step'  ? 'text-accent font-semibold' :
                          log.type === 'error' ? 'text-status-error' :
                          log.type === 'done'  ? 'text-status-healthy font-semibold' :
                          'text-text-muted'
                        }>
                          {log.type === 'step'  ? `▶ ${log.message}` :
                           log.type === 'done'  ? `✓ ${log.message}` :
                           log.type === 'error' ? `✗ ${log.message}` :
                           `  ${log.message}`}
                        </div>
                      ))}
                      {clusterBootstrapping && !clusterBootstrapDone && (
                        <div className="flex items-center gap-1.5 text-text-muted">
                          <RefreshCw size={10} className="animate-spin" /> Running…
                        </div>
                      )}
                    </div>
                  </div>
                  {clusterBootstrapDone && (
                    <div className="flex justify-end pt-1">
                      <button onClick={() => setBootstrapModal(false)}
                        className="px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 transition-colors">
                        Done
                      </button>
                    </div>
                  )}
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

              {/* AI assist — only shown when creating */}
              {toolModal === 'create' && (
                <div className="rounded-lg border border-accent/20 bg-accent/5 p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-accent">
                    <Sparkles size={12} /> AI Assist — describe what you want
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={aiToolDesc}
                      onChange={e => setAiToolDesc(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') generateToolWithAI() }}
                      placeholder="e.g. list pods in a namespace, restart a deployment, show disk usage..."
                      className={`${inputCls} flex-1`}
                    />
                    <button
                      onClick={generateToolWithAI}
                      disabled={aiGenerating || !aiToolDesc.trim()}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-white text-xs font-medium hover:bg-accent/80 disabled:opacity-50 transition-colors flex-shrink-0">
                      {aiGenerating ? <RefreshCw size={11} className="animate-spin" /> : <Sparkles size={11} />}
                      {aiGenerating ? 'Thinking…' : 'Generate'}
                    </button>
                  </div>
                  {aiGenError && <p className="text-[11px] text-status-error">{aiGenError}</p>}
                </div>
              )}

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

      {/* ── Tool group modal ── */}
      {tgModal !== null && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setTgModal(null)}>
          <div className="w-full max-w-sm bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <h2 className="text-sm font-semibold text-text-primary">{tgModal === 'create' ? 'New Tool Group' : `Edit · ${tgTarget?.name}`}</h2>
              <button onClick={() => setTgModal(null)} className="p-1 rounded text-text-muted hover:text-text-primary"><X size={14} /></button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className={labelCls}>Name *</label>
                <input value={tgForm.name} onChange={e => setTgForm(f => ({ ...f, name: e.target.value }))} placeholder="Kubernetes Read-only" className={inputCls} autoFocus />
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input value={tgForm.description} onChange={e => setTgForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Minimum tier to run without approval</label>
                <select value={tgForm.minimumTier} onChange={e => setTgForm(f => ({ ...f, minimumTier: e.target.value }))} className={inputCls}>
                  <option value="viewer">viewer — anyone</option>
                  <option value="operator">operator — operators and above</option>
                  <option value="admin">admin — admins only</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle">
              <button onClick={() => setTgModal(null)} className="px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-text-primary transition-colors">Cancel</button>
              <button onClick={saveTg} disabled={tgSaving || !tgForm.name.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors">
                {tgSaving ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
                {tgSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Tool detail modal ── */}
      {toolDetailModal && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setToolDetailModal(null)}>
          <div className="w-full max-w-lg bg-bg-sidebar border border-border-subtle rounded-xl shadow-2xl" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-text-primary font-mono truncate">{toolDetailModal.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-text-muted border border-border-subtle flex-shrink-0">
                  {EXEC_TYPE_LABELS[toolDetailModal.execType] ?? toolDetailModal.execType}
                </span>
                {toolDetailModal.builtIn && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20 flex-shrink-0">built-in</span>
                )}
              </div>
              <button onClick={() => setToolDetailModal(null)} className="p-1 rounded text-text-muted hover:text-text-primary flex-shrink-0"><X size={14} /></button>
            </div>

            <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
              {/* Description */}
              <p className="text-sm text-text-secondary">{toolDetailModal.description}</p>

              {/* Enable / Disable toggle */}
              <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-bg-card">
                <div>
                  <p className="text-xs font-medium text-text-primary">Enabled</p>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    {toolDetailModal.enabled
                      ? 'Tool is active and available to the AI'
                      : 'Tool is disabled — AI cannot call it'}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    await toggleTool(toolDetailModal)
                    // Reflect updated state in the detail modal
                    setToolDetailModal(prev => prev ? { ...prev, enabled: !prev.enabled } : null)
                  }}
                  className={`flex-shrink-0 transition-colors ${toolDetailModal.enabled ? 'text-status-healthy' : 'text-text-muted'}`}
                  title={toolDetailModal.enabled ? 'Disable' : 'Enable'}>
                  {toolDetailModal.enabled
                    ? <ToggleRight size={28} />
                    : <ToggleLeft size={28} />}
                </button>
              </div>

              {/* Input schema */}
              {Object.keys((toolDetailModal.inputSchema as { properties?: object }).properties ?? {}).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Parameters</p>
                  <div className="space-y-1.5">
                    {Object.entries((toolDetailModal.inputSchema as { properties?: Record<string, { type?: string; description?: string }> }).properties ?? {}).map(([k, v]) => (
                      <div key={k} className="flex items-start gap-2 text-xs">
                        <code className="px-1.5 py-0.5 rounded bg-bg-raised text-accent font-mono text-[11px] flex-shrink-0">{k}</code>
                        <span className="text-text-muted">{v.type ?? 'string'}{v.description ? ` — ${v.description}` : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Exec config */}
              {toolDetailModal.execConfig && Object.keys(toolDetailModal.execConfig).length > 0 && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wide mb-1.5">Command</p>
                  <code className="block text-[11px] bg-bg-raised rounded px-3 py-2 text-text-secondary font-mono whitespace-pre-wrap break-all border border-border-subtle">
                    {(toolDetailModal.execConfig as { command?: string; fn?: string }).command
                      ?? (toolDetailModal.execConfig as { fn?: string }).fn
                      ?? JSON.stringify(toolDetailModal.execConfig)}
                  </code>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle">
              <div className="flex items-center gap-2">
                {!toolDetailModal.builtIn && (
                  <button
                    onClick={() => { openEditTool(toolDetailModal); setToolDetailModal(null) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-subtle text-text-muted hover:text-accent hover:border-accent/40 transition-colors">
                    <Pencil size={11} /> Edit
                  </button>
                )}
              </div>
              <button onClick={() => setToolDetailModal(null)}
                className="px-4 py-1.5 text-xs rounded bg-bg-raised text-text-muted hover:text-text-primary border border-border-subtle transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
