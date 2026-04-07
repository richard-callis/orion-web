# Environment Repo Structure (K8s)

This repo is managed by ORION. Do not edit manifests directly — propose changes via ORION.

## Directory Layout

clusters/<cluster-name>/
├── namespaces/
│   └── <namespace>.yaml          # Namespace definitions
├── deployments/
│   └── <namespace>/
│       └── <service>/
│           ├── deployment.yaml
│           ├── service.yaml
│           ├── ingress.yaml
│           └── pvc.yaml
├── configs/
│   └── <namespace>/
│       └── <name>-configmap.yaml
├── rbac/
│   └── <name>-clusterrole.yaml
├── network-policies/
│   └── <namespace>-netpol.yaml
└── argocd/
    ├── appproject.yaml            # ArgoCD AppProject for this cluster
    └── root-application.yaml     # App-of-apps root Application

## How ArgoCD is configured

ArgoCD watches the root path of this repo.
The root-application.yaml uses `path: clusters/<cluster-name>` and syncs
all subdirectories recursively with `recurse: true`.

## Auto-merge policy

| Change type          | Policy         |
|----------------------|----------------|
| Scale replicas       | Auto-merge     |
| ConfigMap update     | Auto-merge     |
| Rolling restart      | Auto-merge     |
| Image patch/minor    | Auto-merge     |
| New deployment       | Human review   |
| Ingress change       | Human review   |
| RBAC change          | Human review   |
| Network policy       | Human review   |
| Anything destructive | Human review   |
