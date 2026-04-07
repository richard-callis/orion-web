# Environment Repo Structure (Docker Host)

This repo is managed by ORION. Changes are applied via Gitea Actions runner.

## Directory Layout

services/
├── <service-name>/
│   ├── docker-compose.yml        # Service definition
│   ├── .env.example              # Non-secret env vars
│   └── README.md
└── ...

.gitea/
└── workflows/
    └── deploy.yml                # Gitea Actions workflow

## How Gitea Actions works

A Gitea Actions runner is deployed on the Docker host by ORION.
On push to main (after PR merge), the workflow:
  1. SSHes to the Docker host (or runs in act mode locally)
  2. Pulls new images
  3. Runs docker compose up -d
