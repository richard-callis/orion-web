-- SOC2 [M-002]: Add encrypted columns for TOTP secret and recovery codes.
-- The plaintext columns (totpSecret, totpRecoveryCodes) are kept for rollback
-- safety and are cleared by the application after migration is confirmed.
-- The startup migration utility (totp-migration.ts) backfills existing rows.

ALTER TABLE "User" ADD COLUMN "totpSecretEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "totpRecoveryCodesEncrypted" TEXT;
