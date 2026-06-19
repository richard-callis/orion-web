-- Warden triage idempotency: timestamp set when Warden is first dispatched
-- to triage an incident, so the correlator does not re-trigger on every tick.
ALTER TABLE "Incident" ADD COLUMN "triageDispatchedAt" TIMESTAMP(3);
