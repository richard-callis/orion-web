'use client'
import { useCallback } from 'react'
import useSWR from 'swr'

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

export const PENDING_TOOLS_KEY = '/api/tools/pending'
export const TOOL_APPROVALS_KEY = '/api/tool-approvals'

const EMPTY: never[] = []

/**
 * Pending tool proposals + approval requests. Backed by SWR, so every caller
 * (sidebar, admin layout, notifications) shares one request per key, and
 * polling pauses while the tab is hidden.
 */
export function usePendingTools(intervalMs = 30_000) {
  const tools = useSWR<PendingTool[]>(PENDING_TOOLS_KEY, { refreshInterval: intervalMs })
  const approvals = useSWR<ApprovalRequest[]>(TOOL_APPROVALS_KEY, { refreshInterval: intervalMs })

  const toolList = tools.data ?? EMPTY
  const approvalList = approvals.data ?? EMPTY
  const { mutate: mutateTools } = tools
  const { mutate: mutateApprovals } = approvals

  const refresh = useCallback(async () => {
    await Promise.all([mutateTools(), mutateApprovals()])
  }, [mutateTools, mutateApprovals])

  return {
    tools: toolList,
    approvals: approvalList,
    count: toolList.length + approvalList.length,
    pendingToolCount: toolList.length,
    pendingApprovalCount: approvalList.length,
    refresh,
  }
}
