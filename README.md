# ORION

**Operations & Resource Infrastructure Orchestration Node**

ORION is a self-hosted management platform that lives *outside* the infrastructure it controls. It bootstraps, manages, and automates Kubernetes clusters and Docker hosts through an AI-driven GitOps pipeline — so when your cluster goes down, your management plane stays up.

---

## How It Works

ORION runs on a dedicated management node (a Raspberry Pi 4 8GB works great). On first boot it spins up its own dependencies, then you register environments through the UI. From that point on, every infrastructure change flows through Git.

```
GitHub
  └── ORION (this repo) ──docker pull──► Management RPi
                                              │
                              ┌───────────────┼───────────────┐
                              │               │               │
                           Gitea           Vault          CoreDNS
                        (source of       (secrets)    (*.khalis.corp)
                          truth)
                              │
                    ┌─────────┴──────────┐
                    │                    │
             Kubernetes             Docker Host
              Cluster                   │
                    │              ORION Gateway
             ArgoCD + ORION        (Docker type)
              Gateway              + Gitea Actions
           (cluster type)
                    │
              GitOps sync
           manifests → cluster
```

**The AI GitOps loop:**

1. AI agent (via ORION) decides a change is needed
2. ORION writes to Gitea via REST API — creates branch, commits manifest, opens PR
3. PR is tagged `auto-merge` or `needs-review` based on operation type
4. Auto-merge operations merge immediately → ArgoCD detects → syncs to cluster
5. Review operations wait for human approval in Gitea → then ArgoCD syncs
6. ORION Gateway (MCP server inside the cluster) reports sync status back to ORION
7. Full audit trail — every cluster change is a Gitea commit with AI reasoning attached

---

## Features

- **Self-bootstrapping** — one `docker run` starts everything; ORION spins up Gitea, Vault, PostgreSQL, CoreDNS, and Traefik automatically on first boot
- **Multi-environment** — register Kubernetes clusters or Docker hosts; each gets an isolated Gitea repo, Vault secret path, and auth policy
- **AI-driven GitOps** — AI agents propose changes as Git PRs; configurable auto-merge policy per environment
- **Pluggable AI providers** — Anthropic API key, Claude Code OAuth, OpenAI, Ollama, or any OpenAI-compatible endpoint; swap without code changes
- **Secrets management** — single Vault instance serves all environments with full isolation via path + auth method per environment
- **Internal DNS** — CoreDNS on the management node is authoritative for your internal domain; ORION manages records directly
- **Cluster bootstrap** — register a Talos or K3s cluster and ORION automatically deploys ArgoCD, ESO, and the ORION Gateway
- **MCP gateway** — ORION Gateway exposes kubectl/Docker tools to AI agents via the Model Context Protocol

---

## Stack

| Component | Role |
|---|---|
| **ORION Web** | Next.js 14 dashboard + API + AI agent orchestrator |
| **ORION Gateway** | MCP server deployed inside each managed environment |
| **Gitea** | Self-hosted Git — one repo per registered environment |
| **Vault** | Secrets store with per-environment isolation |
| **PostgreSQL 16** | ORION database |
| **Traefik** | Reverse proxy for management node services |
| **CoreDNS** | Authoritative DNS for internal domain |

---

## Auto-Merge Policy

Operations are classified at PR creation time. Policy is configurable per environment.

| Operation | Default |
|---|---|
| Scale replicas, rolling restart | ✅ Auto-merge |
| Image tag update (patch/minor) | ✅ Auto-merge |
| ConfigMap update, resource limits | ✅ Auto-merge |
| New deployment, service, ingress | 👤 Human review |
| RBAC, network policies, namespaces | 👤 Human review |
| Secrets, destructive operations | 👤 Human review |

---

## Quick Start

### Prerequisites

- Docker + Docker Compose on your management node
- ARM64 or amd64 architecture (RPi 4/5 or any Linux box)

### 1. Clone and configure

```bash
git clone https://github.com/richard-callis/orion-web.git
cd orion-web/deploy
cp .env.example .env
# Edit .env — set RPI_IP and POSTGRES_PASSWORD at minimum
```

### 2. Bootstrap

```bash
./bootstrap.sh
```

On first run this will:
- Pull all images
- Start the full stack
- Print a one-time setup token to the logs

### 3. Complete setup

Visit `https://orion.khalis.corp` (or your configured domain), paste the setup token, and follow the first-run wizard to configure your admin account, domain, Vault, and AI provider.

### 4. Register an environment

In the ORION UI, go to **Environments → Add Environment** and select:
- **Kubernetes** — provide a kubeconfig; ORION deploys ArgoCD + Gateway + ESO
- **Docker** — provide Docker socket/TCP; ORION deploys Gateway + Gitea Actions runner

---

## Repository Structure

```
orion-web/
├── apps/
│   ├── web/          # ORION dashboard (Next.js 14 + Prisma + TypeScript)
│   └── gateway/      # ORION Gateway MCP server (Express + TypeScript)
├── deploy/
│   ├── docker-compose.yml   # Full management node stack
│   ├── bootstrap.sh         # First-run setup script
│   ├── .env.example         # Environment variable template
│   └── coredns/             # CoreDNS config + zone files
└── .github/workflows/       # Multi-arch builds (amd64 + arm64) → ghcr.io
```

---

## CI/CD

Pushing to `main` triggers GitHub Actions that build multi-arch Docker images (`linux/amd64` + `linux/arm64`) and push to the GitHub Container Registry:

- `ghcr.io/richard-callis/orion-web:latest`
- `ghcr.io/richard-callis/orion-gateway:latest`

> **Note:** Enable write permissions for packages in repo Settings → Actions → General → Workflow permissions → Read and write.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `RPI_IP` | Static IP of the management node | — |
| `ORION_DOMAIN` | Domain for the ORION UI | `orion.khalis.corp` |
| `GITEA_DOMAIN` | Domain for Gitea | `gitea.khalis.corp` |
| `VAULT_DOMAIN` | Domain for Vault UI | `vault.khalis.corp` |
| `POSTGRES_PASSWORD` | PostgreSQL password | — |
| `NEXTAUTH_SECRET` | NextAuth secret (generate with `openssl rand -base64 32`) | — |
| `ORION_VERSION` | Image tag to deploy | `latest` |

See `deploy/.env.example` for the full list.

---

## Architecture Notes

- **Management plane is external** — ORION runs outside the clusters it manages; cluster outages don't affect the management node
- **Gitea is source of truth for clusters** — ORION's own source of truth is this GitHub repo (avoids circular dependency)
- **One Vault, N environments** — secret paths and auth methods are scoped per environment; cross-environment access is impossible by policy
- **CoreDNS on RPi is authoritative** — `*.khalis.corp` resolves via the management node; cluster CoreDNS forwards to it; DNS survives cluster outages
- **Failover** — ORION is also accessible internally at `orion.khalis.corp` directly from the management node; if the cluster goes down, flip your router's port forward to the management node IP

---

## License

MIT
