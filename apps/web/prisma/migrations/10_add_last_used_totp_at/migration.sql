-- SOC2: [M-002] Add lastUsedTotpAt to track the timestamp of the last accepted TOTP
-- code per user. Used to prevent TOTP code replay within the same 30-second time step.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastUsedTotpAt" TIMESTAMP(3);
