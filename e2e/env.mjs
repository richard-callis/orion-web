// Shared settings for the e2e scripts and specs. Never hard-code credentials.
//
//   ORION_E2E_BASE_URL   default http://localhost:3000
//   ORION_E2E_USER       login username (required for authenticated checks)
//   ORION_E2E_PASSWORD   login password (required for authenticated checks)

export const BASE = process.env.ORION_E2E_BASE_URL ?? 'http://localhost:3000'
export const USER = process.env.ORION_E2E_USER ?? ''
export const PASSWORD = process.env.ORION_E2E_PASSWORD ?? ''
export const HAS_CREDENTIALS = Boolean(USER && PASSWORD)

export function requireCredentials() {
  if (!HAS_CREDENTIALS) {
    console.error('Set ORION_E2E_USER and ORION_E2E_PASSWORD (see e2e/README.md).')
    process.exit(2)
  }
  return { user: USER, password: PASSWORD }
}
