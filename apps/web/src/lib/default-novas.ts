export interface NovaDefinitionSeed {
  name: string
  category: "skill" | "hook"
  version: string
  title: string
  description: string
  spec: string
  metadata: string
}

export const DEFAULT_NOVAS: NovaDefinitionSeed[] = [
  // --- 5 SKILLS ---

  {
    name: "k8s-debug",
    category: "skill",
    version: "1.0",
    title: "Kubernetes Debugging",
    description: "Structured methodology for debugging common Kubernetes pod issues including CrashLoopBackOff, OOMKill, ImagePullBackOff, and pending pods.",
    spec: JSON.stringify({
      triggerPatterns: [
        "crashloop", "CrashLoopBackOff", "CrashLoop",
        "pod is stuck", "pod not starting", "pod pending", "ImagePullBackOff", "ErrImagePull",
        "pod crash", "container restarting", "OOMKill", "oom",
        "kubernetes debug", "k8s debug", "troubleshoot pod",
      ],
      systemPrompt: `You are a Kubernetes debugging specialist. Use this methodology:
1. Check pod status: \`kubectl get pods -n {namespace} -w\`
2. Describe the pod: \`kubectl describe pod {pod_name} -n {namespace}\`
3. Check events: \`kubectl get events --field-selector involvedObject.name={pod_name} -n {namespace}\`
4. Check logs: \`kubectl logs {pod_name} -n {namespace}\`
5. If CrashLoopBackOff, check previous logs: \`kubectl logs {pod_name} -n {namespace} --previous\`
6. For OOM: check resource limits vs actual usage: \`kubectl top pods -n {namespace}\`
7. For ImagePullBackOff: check image name, registry auth, and network: \`kubectl describe pod {pod_name} -n {namespace}\`

Be methodical. Do not restart pods or make changes without explaining why.`,
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["kubernetes", "debugging"] }),
  },

  {
    name: "docker-troubleshoot",
    category: "skill",
    version: "1.0",
    title: "Docker Troubleshooting",
    description: "Debugging methodology for Docker containers — image issues, resource problems, container lifecycle.",
    spec: JSON.stringify({
      triggerPatterns: [
        "docker", "container crash", "container not starting",
        "container stuck", "docker log", "image not found",
      ],
      systemPrompt: `You are a Docker troubleshooting specialist. Use this methodology:
1. Check container status: \`docker ps -a\`
2. Inspect the container: \`docker inspect {container_name}\`
3. Check logs: \`docker logs {container_name}\`
4. Check resource usage: \`docker stats {container_name}\`
5. For network issues: \`docker network ls\`, \`docker network inspect {network_name}\`
6. For image issues: \`docker images\`, \`docker pull {image_name}\`

Be methodical. Do not remove containers or images without explaining why.`,
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["docker", "debugging"] }),
  },

  {
    name: "cluster-health",
    category: "skill",
    version: "1.0",
    title: "Cluster Health",
    description: "Comprehensive cluster health checking — nodes, pods, resources, storage, networking.",
    spec: JSON.stringify({
      triggerPatterns: [
        "cluster health", "cluster status", "node health",
        "cluster overview", "cluster check", "is the cluster healthy",
        "health check", "cluster diagnostics",
      ],
      systemPrompt: `You are a cluster health specialist. Follow this diagnostic checklist:
1. Node status: \`kubectl get nodes -o wide\`
2. Pod health across all namespaces: \`kubectl get pods --all-namespaces --field-selector status.phase!=Running\`
3. Resource usage: \`kubectl top nodes\`, \`kubectl top pods --all-namespaces\`
4. Persistent volumes: \`kubectl get pv,pvc --all-namespaces\`
5. Core system pods: \`kubectl get pods -n kube-system\`
6. Ingress/DNS: \`kubectl get services -n kube-system\`, \`kubectl get ingress -A\`
7. ArgoCD apps (if available): \`kubectl get applications -n argocd\`

Report findings in priority order: Critical > Warning > Info.`,
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["kubernetes", "health-check"] }),
  },

  {
    name: "backup-recovery",
    category: "skill",
    version: "1.0",
    title: "Backup & Recovery",
    description: "Backup and recovery procedures for K8s clusters and Docker environments.",
    spec: JSON.stringify({
      triggerPatterns: [
        "backup", "restore", "recover", "snapshot",
        "velero", "velero backup", "backup restore",
        "data loss", "recovery",
      ],
      systemPrompt: `You are a backup and recovery specialist. Follow these procedures:
1. Check backup status: \`velero backup get\` (or equivalent)
2. List recent backups: \`velero backup get --limit 5\`
3. For restores: \`velero restore create --from-backup {backup_name}\`
4. Verify restored resources: \`kubectl get all -n {namespace}\`
5. For Docker: \`docker volume ls\`, \`docker ps -a\`

Always verify before and after states. Document what was restored.`,
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["backup", "recovery"] }),
  },

  {
    name: "dns-troubleshoot",
    category: "skill",
    version: "1.0",
    title: "DNS Troubleshooting",
    description: "DNS debugging for Kubernetes services and CoreDNS.",
    spec: JSON.stringify({
      triggerPatterns: [
        "dns", "coredns", "service discovery", "cannot resolve",
        "name resolution", "dns lookup", "dns failure",
      ],
      systemPrompt: `You are a DNS troubleshooting specialist. Follow this methodology:
1. Check CoreDNS pods: \`kubectl get pods -n kube-system -l k8s-app=kube-dns\`
2. Test DNS resolution: \`kubectl run dns-test --rm --image=busybox -- nslookup kubernetes.default.svc.cluster.local\`
3. Check CoreDNS config: \`kubectl get configmap coredns -n kube-system -o yaml\`
4. Check service endpoints: \`kubectl get endpoints -n {namespace}\`
5. Check node DNS config: \`kubectl get nodes -o jsonpath='{.items[*].status.nodeConfig}'\`

Test resolution step by step and report which layer fails.`,
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["kubernetes", "dns"] }),
  },

  // --- 5 HOOKS ---

  {
    name: "diagnose_pod_crashloop",
    category: "hook",
    version: "1.0",
    title: "Diagnose Pod CrashLoop",
    description: "When a pod enters CrashLoopBackOff, automatically run diagnostic commands (kubectl describe + logs).",
    spec: JSON.stringify({
      triggerType: "on_pod_crashloop",
      triggerFilter: {},
      actionType: "run_shell_command",
      actionConfig: {
        command: "kubectl describe pod {pod_name} -n {namespace} && kubectl logs --previous {pod_name} -n {namespace} --tail=50",
      },
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["kubernetes", "auto-diagnose"] }),
  },

  {
    name: "notify_oom_kill",
    category: "hook",
    version: "1.0",
    title: "Notify OOM Kill",
    description: "Send a notification when a container is OOM killed.",
    spec: JSON.stringify({
      triggerType: "on_pod_oom",
      triggerFilter: {},
      actionType: "send_notification",
      actionConfig: {
        channel: "cluster-alerts",
        message: "Pod {pod_name} in namespace {namespace} was OOM killed. Memory usage exceeded limits.",
      },
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["kubernetes", "notification"] }),
  },

  {
    name: "disk_full_warning",
    category: "hook",
    version: "1.0",
    title: "Disk Full Warning",
    description: "When a node disk usage exceeds 90%, report and list large files.",
    spec: JSON.stringify({
      triggerType: "on_node_disk_full",
      triggerFilter: { threshold: 90 },
      actionType: "run_shell_command",
      actionConfig: {
        command: "kubectl get nodes -o wide && df -h",
      },
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["kubernetes", "disk"] }),
  },

  {
    name: "argocd_sync_degraded",
    category: "hook",
    version: "1.0",
    title: "ArgoCD Sync Degraded",
    description: "When an ArgoCD application becomes degraded, report the health issues.",
    spec: JSON.stringify({
      triggerType: "on_sync_degraded",
      triggerFilter: { health: "Degraded" },
      actionType: "run_shell_command",
      actionConfig: {
        command: "kubectl get applications -n argocd -l health=Degraded -o wide",
      },
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["argocd", "health"] }),
  },

  {
    name: "tool_usage_audit",
    category: "hook",
    version: "1.0",
    title: "Tool Usage Audit",
    description: "Log when high-impact tools are used for auditing purposes.",
    spec: JSON.stringify({
      triggerType: "on_tool_execution",
      triggerFilter: { toolNames: ["kubectl_delete_*", "docker_rm_*", "kubectl_delete_namespace_*"] },
      actionType: "send_notification",
      actionConfig: {
        channel: "audit-log",
        message: "High-impact tool executed: {tool_name} with args: {tool_args}",
      },
    }),
    metadata: JSON.stringify({ author: "orion", tags: ["audit", "security"] }),
  },
]

export async function seedNovaDefinitions(prisma: any): Promise<void> {
  for (const nova of DEFAULT_NOVAS) {
    await prisma.novaDefinition.upsert({
      where: { name: nova.name },
      update: { spec: nova.spec, description: nova.description, title: nova.title, version: nova.version, metadata: nova.metadata },
      create: { ...nova },
    })
  }
}
