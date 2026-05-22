-- Migration: LISTEN/NOTIFY triggers for SSE real-time stream
--
-- Creates a trigger function and triggers on SecurityEvent, Incident,
-- and ActionAudit tables. Each trigger fires pg_notify on its OWN
-- channel only (events / incidents / approvals) — driven by TG_ARGV[0]
-- so that one shared function can serve all three tables without
-- cross-broadcasting every change to every channel.
--
-- The SSE stream endpoint (stream/route.ts) listens on the channel
-- it cares about and receives ID-only frames.

-- ── Trigger function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orion_security_notify() RETURNS TRIGGER AS $notify$
DECLARE
  channel_suffix TEXT;
  channel_name TEXT;
BEGIN
  -- TG_ARGV[0] is supplied per trigger: 'events' | 'incidents' | 'approvals'
  channel_suffix := TG_ARGV[0];
  channel_name := 'orion_security_' || channel_suffix;

  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify(channel_name, OLD.id::text || ':deleted');
  ELSE
    PERFORM pg_notify(channel_name, NEW.id::text || ':created');
  END IF;

  RETURN NULL; -- AFTER trigger: return value is ignored
END;
$notify$ LANGUAGE plpgsql;

-- ── SecurityEvent triggers ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS security_event_notify ON "SecurityEvent";
CREATE TRIGGER security_event_notify
  AFTER INSERT OR UPDATE OR DELETE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('events');

-- ── Incident triggers ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS incident_notify ON "Incident";
CREATE TRIGGER incident_notify
  AFTER INSERT OR UPDATE OR DELETE ON "Incident"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('incidents');

-- ── ActionAudit triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS action_audit_notify ON "ActionAudit";
CREATE TRIGGER action_audit_notify
  AFTER INSERT OR UPDATE OR DELETE ON "ActionAudit"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify('approvals');
