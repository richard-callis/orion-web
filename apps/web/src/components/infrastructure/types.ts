export type InfraTab = 'overview' | 'ingress' | 'storage' | 'secrets' | 'backups' | 'logs' | 'gitops' | 'alerts'

// ── Storage tab ───────────────────────────────────────────────────────────────

export interface LonghornVolume {
  metadata: { name: string }
  spec: { numberOfReplicas: number; size: string }
  status: {
    state: string
    robustness: string
    currentNodeID?: string
    kubernetesStatus?: {
      namespace?: string
      pvcName?: string
      pvStatus?: string
      workloadsStatus?: Array<{ podName: string; podStatus: string; workloadName: string; workloadType: string }>
    }
  }
}

export interface StorageStats {
  provider: 'longhorn' | 'ceph' | null
  totalBytes: number
  usedBytes:  number
  freeBytes:  number
  nodes: Array<{ name: string; totalBytes: number; usedBytes: number; freeBytes: number }>
}

export interface ManagedSecret {
  id: string
  name: string
  namespace: string
  description: string | null
  secretStore: string
  secretStoreKind: string
  remoteRef: string
  targetSecretName: string | null
  refreshInterval: string
  dataKeys: Array<{ secretKey: string; remoteKey: string }>
  tags: string[]
  status: string
  statusMessage: string | null
  appliedAt: string | null
  createdAt: string
  creator?: { id: string; username: string; name: string | null } | null
}
