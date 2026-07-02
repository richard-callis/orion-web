-- AddColumn: per-user GitHub repo allowlist (empty = allow all)
ALTER TABLE "User" ADD COLUMN "githubAllowedRepos" TEXT[] NOT NULL DEFAULT '{}';
