/**
 * TOTP (Time-based One-Time Password) utilities for SOC2 [M-002] compliance.
 *
 * Implements RFC 6238 using HMAC-SHA1 with 30-second time steps.
 * Compatible with Google Authenticator, Authy, 1Password, and other TOTP apps.
 */

const otplib = require("otplib") as any
const { authenticator } = otplib
import crypto from 'crypto'

// Configure TOTP settings
authenticator.window = 1 // Allow ±1 time step (±30s) for clock skew
authenticator.digit = 6
authenticator.step = 30
authenticator.type = 'sha1'

const TOTP_ISSUER = 'ORION'
const TOTP_LABEL = 'ORION'

/**
 * Generate a new TOTP secret (Base32 encoded).
 * 20 bytes = 160-bit key, standard for TOTP.
 */
export function generateSecret(): string {
  return authenticator.generateSecret()
}

/**
 * Generate a QR code URL for TOTP enrollment.
 * The user scans this URL with their authenticator app.
 */
export function generateQRCodeUrl(secret: string, username: string): string {
  return authenticator.keyuri(username, TOTP_ISSUER, secret)
}

/**
 * Verify a TOTP code against a secret.
 * Returns true if the code is valid within the ±1 window.
 */
export function verifyTOTP(secret: string, code: string): boolean {
  return authenticator.verify({ token: code, secret })
}

/**
 * Generate recovery codes for MFA fallback.
 * Returns 8 unique 8-character alphanumeric codes.
 */
export function generateRecoveryCodes(): string[] {
  const codes: string[] = []
  while (codes.length < 8) {
    const raw = crypto.randomBytes(6).toString('hex').slice(0, 8)
    if (!codes.includes(raw)) {
      codes.push(raw)
    }
  }
  return codes
}

/**
 * Hash a single recovery code using bcrypt (cost 14, consistent with password hashing).
 */
export async function hashRecoveryCode(code: string, cost: number = 14): Promise<string> {
  const { hash } = await import('bcryptjs')
  return hash(code, cost)
}

/**
 * Verify a recovery code against a set of hashed recovery codes.
 * Takes O(n) time where n = number of recovery codes (8 by default).
 */
export async function verifyRecoveryCode(
  code: string,
  hashedCodes: string[],
  cost: number = 14,
): Promise<boolean> {
  const { compare } = await import('bcryptjs')
  for (const hashed of hashedCodes) {
    if (await compare(code, hashed)) return true
  }
  return false
}

/**
 * Consume a recovery code by removing it from the stored set.
 * Returns the updated set of hashed recovery codes, or null if not found.
 */
export async function consumeRecoveryCode(
  code: string,
  hashedCodes: string[],
  cost: number = 14,
): Promise<string[] | null> {
  const { compare } = await import('bcryptjs')

  // Find the index of the matching recovery code
  let matchedIndex = -1
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await compare(code, hashedCodes[i])) {
      matchedIndex = i
      break
    }
  }

  // If no match found, return null
  if (matchedIndex === -1) {
    return null
  }

  // Return array without the consumed code
  return hashedCodes.filter((_, i) => i !== matchedIndex)
}
