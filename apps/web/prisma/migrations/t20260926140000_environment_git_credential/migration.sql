-- M2: per-environment, repo-scoped, read-only git credential for the gateway
-- (replaces handing every gateway the org-wide provider token).
CREATE TABLE IF NOT EXISTS "EnvironmentGitCredential" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "providerRef" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvironmentGitCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EnvironmentGitCredential_environmentId_key"
    ON "EnvironmentGitCredential"("environmentId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'EnvironmentGitCredential_environmentId_fkey'
    ) THEN
        ALTER TABLE "EnvironmentGitCredential"
            ADD CONSTRAINT "EnvironmentGitCredential_environmentId_fkey"
            FOREIGN KEY ("environmentId") REFERENCES "Environment"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
