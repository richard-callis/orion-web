-- Migration: LISTEN/NOTIFY triggers for SourceHealth + EnvironmentSourceHealth
--
-- Adds NOTIFY triggers on both source-health tables so the SSE stream's
-- 'sources' channel wakes instantly when ingestion health changes. Reuses
-- the shared orion_security_notify() function (TG_ARGV[0]='sources') created
-- in 13_siem_notify_triggers.
--
-- DROP TRIGGER IF EXISTS guards make this migration idempotent (safe to
-- re-run / re-apply against an existing database).

DROP TRIGGER IF EXISTS source_health_notify ON "SourceHealth";
CREATE TRIGGER source_health_notify
  AFTER INSERT OR UPDATE ON "SourceHealth"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('sources');

DROP TRIGGER IF EXISTS env_source_health_notify ON "EnvironmentSourceHealth";
CREATE TRIGGER env_source_health_notify
  AFTER INSERT OR UPDATE ON "EnvironmentSourceHealth"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('sources');
