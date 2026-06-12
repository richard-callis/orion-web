-- SOC2: [M-006] Per-account login lockout fields
-- Tracks consecutive failed login attempts and locks the account temporarily
-- after 5 failures (15-minute lockout window).

ALTER TABLE "User" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);
