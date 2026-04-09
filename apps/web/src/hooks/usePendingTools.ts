'use client'
import { useState, useEffect, useCallback } from 'react'

export interface PendingTool {
  id: string
  name: string
  description: string
  execType: string
  execConfig: Record<string, unknown> | null
  inputSchema: Record<string, unknown>
  enabled: boolean
  proposedAt: string | null
  proposedBy: string | null
  environment: { id: string; name: string }
}

export interface ApprovalRequest {
  id: string
  conversationId: string
  userId: string
  environmentId: string
  toolName: string
  toolArgs: Record<string, unknown>
  reason: string | null
  status: string
  createdAt: string
}

export function usePendingTools(intervalMs = 30_000) {
  const [tools, setTools]     = useState<PendingTool[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])

  const fetch_ = useCallback(async () => {
    try {
      const [toolData, approvalData] = await Promise.all([
        fetch('/api/tools/pending').then(r => r.json()) as Promise<PendingTool[]>,
        fetch('/api/tool-approvals').then(r => r.json()) as Promise<ApprovalRequest[]>,
      ])
      setTools(toolData)
      setApprovals(approvalData)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetch_()
    const t = setInterval(fetch_, intervalMs)
    return () => clearInterval(t)
  }, [fetch_, intervalMs])

  const count = tools.length + approvals.length
  return { tools, approvals, count, pendingToolCount: tools.length, pendingApprovalCount: approvals.length, refresh: fetch_ }
}
