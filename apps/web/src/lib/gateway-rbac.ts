/**
 * Read-only RBAC for an in-cluster gateway (infra-manager design §5.1), shared by
 * the join manifest and cluster bootstrap so the two can't drift apart.
 *
 * `name` prefixes the cluster-scoped objects: the two install paths use different
 * namespaces, and one name for both would let the second install rebind the
 * first one's ServiceAccount.
 */
export function gatewayReadRbac({ name, namespace }: { name: string; namespace: string }): string {
  return `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${name}-view
# Read-only (infra-manager design §5.1): the built-in "view" role covers
# namespaced workloads, services, config, events, HPAs and PDBs, excludes
# Secrets and pods/exec, and grows with CRDs that aggregate-to-view.
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: ${namespace}

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${name}
# Read-only extras "view" doesn't cover: cluster-scoped kinds and the operator
# CRDs Orion's tools read. No Secrets, no pods/exec, no RBAC objects, no writes.
# Changes to the cluster go through GitOps PRs or approved runbooks, never
# through the gateway. Re-applying this downgrades an older, writable role.
rules:
  - apiGroups: [""]
    resources: ["nodes", "namespaces", "persistentvolumes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "volumeattachments", "csidrivers", "csinodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["scheduling.k8s.io"]
    resources: ["priorityclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["node.k8s.io"]
    resources: ["runtimeclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingressclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apiextensions.k8s.io"]
    resources: ["customresourcedefinitions"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["cert-manager.io", "acme.cert-manager.io"]
    resources: ["certificates", "issuers", "clusterissuers", "certificaterequests", "orders", "challenges"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metallb.io"]
    resources: ["ipaddresspools", "l2advertisements", "bgpadvertisements"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["argoproj.io"]
    resources: ["applications", "appprojects"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["longhorn.io"]
    resources: ["nodes", "volumes", "replicas", "engines", "backups", "backupvolumes", "recurringjobs", "settings"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["ceph.rook.io"]
    resources: ["cephclusters"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["velero.io"]
    resources: ["backups", "restores", "schedules", "backupstoragelocations"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["traefik.io", "traefik.containo.us"]
    resources: ["ingressroutes", "ingressroutetcps", "middlewares", "tlsoptions"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["gateways", "gatewayclasses", "httproutes"]
    verbs: ["get", "list", "watch"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${name}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${name}
subjects:
  - kind: ServiceAccount
    name: orion-gateway
    namespace: ${namespace}
`
}
