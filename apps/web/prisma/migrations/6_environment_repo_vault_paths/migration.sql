-- Add repoPath and vaultPathPrefix to Environment
-- repoPath:        ArgoCD-watched sub-directory in the repo (e.g. "deployments")
-- vaultPathPrefix: Vault KV prefix for this environment's secrets (e.g. "Talos Cluster")

ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "repoPath" TEXT;
ALTER TABLE "Environment" ADD COLUMN IF NOT EXISTS "vaultPathPrefix" TEXT;
