-- Seed storage_stats tool into existing cluster and localhost environments.
-- Idempotent: skips environments that already have the tool.
INSERT INTO "McpTool" (
  "id", "environmentId", "name", "description",
  "inputSchema", "execType", "execConfig",
  "enabled", "builtIn", "status",
  "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  e."id",
  'storage_stats',
  'Get storage capacity stats for the cluster. Auto-detects Longhorn or Rook-Ceph and returns total/used/free bytes per node.',
  '{"type":"object","properties":{}}'::jsonb,
  'builtin',
  '{"fn":"storage_stats"}'::jsonb,
  true,
  true,
  'active',
  NOW(),
  NOW()
FROM "Environment" e
WHERE e."type" IN ('cluster', 'localhost')
  AND NOT EXISTS (
    SELECT 1 FROM "McpTool" t
    WHERE t."environmentId" = e."id"
      AND t."name" = 'storage_stats'
  );
