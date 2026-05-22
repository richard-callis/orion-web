-- Migration: LISTEN/NOTIFY triggers for SSE real-time stream
--
-- Creates a trigger function and triggers on SecurityEvent, Incident,
-- and ActionAudit tables so that every INSERT/UPDATE/DELETE fires a
-- pg_notify('orion_security_<channel>', NEW.id::text) call.
--
-- The SSE stream endpoint (stream/route.ts) listens on these channels
-- and broadcasts ID-only frames to connected clients.

-- ── Trigger function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orion_security_notify() RETURNS TRIGGER AS $notify$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('orion_security_events', OLD.id::text || ':deleted');
    PERFORM pg_notify('orion_security_incidents', OLD.id::text || ':deleted');
    PERFORM pg_notify('orion_security_approvals', OLD.id::text || ':deleted');
  ELSE
    PERFORM pg_notify('orion_security_events', NEW.id::text || ':created');
    PERFORM pg_notify('orion_security_incidents', NEW.id::text || ':created');
    PERFORM pg_notify('orion_security_approvals', NEW.id::text || ':created');
  END IF;
  RETURN NEW;
END;
$notify$ LANGUAGE plpgsql;

-- ── SecurityEvent triggers ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS security_event_notify ON "SecurityEvent";
CREATE TRIGGER security_event_notify
  AFTER INSERT OR UPDATE OR DELETE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify();

-- ── Incident triggers ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS incident_notify ON "Incident";
CREATE TRIGGER incident_notify
  AFTER INSERT OR UPDATE OR DELETE ON "Incident"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify();

-- ── ActionAudit triggers ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS action_audit_notify ON "ActionAudit";
CREATE TRIGGER action_audit_notify
  AFTER INSERT OR UPDATE OR DELETE ON "ActionAudit"
  FOR EACH ROW EXECUTE FUNCTION orion_security_notify();
