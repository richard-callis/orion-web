/**
 * Central write path + startup self-heal for SystemSetting rows that must
 * always hold an encrypted (enc:v1:-prefixed) value.
 *
 * Root cause this exists to prevent: git.provider.config was written as a
 * plain JSON object (no encryptJson wrapper) sometime before the setup
 * wizard's write path was updated to encrypt, and the corrupted row sat
 * silently in the DB for months — nothing failed until gitops_propose tried
 * to decryptJsonStrict() it, which took hours of agent debugging to diagnose
 * because the failure was so far removed from the original bad write.
 *
 * Two defenses:
 *   1. writeEncryptedSetting() — the one write path all current and future
 *      encrypted settings should go through, so a call-site can't forget to
 *      encrypt.
 *   2. healUnencryptedSettings() — run once at worker startup, scans the
 *      known-sensitive keys and auto-re-encrypts any that were written as
 *      plaintext (by an older binary, a migration, or a manual DB edit)
 *      instead of leaving them to fail at first use.
 */

import { prisma } from '@/lib/db'
import { encrypt, encryptJson, decrypt, PREFIX } from '@/lib/encryption'

/**
 * Every SystemSetting key that must always hold an enc:v1:-prefixed value,
 * and how its plaintext is encoded before encryption. Getting this wrong for
 * a given key breaks decryption on the read side, so it's tracked per-key
 * rather than assumed uniform:
 *   - 'json'   — value is JSON.stringify'd first (encryptJson), read back with
 *                decryptJson/decryptJsonStrict. Used for structured config.
 *   - 'string' — value is encrypted as-is (encrypt), read back with plain
 *                decrypt/decryptStrict. Used for bare secret strings (tokens)
 *                — JSON-encoding one of these would wrap it in quotes and
 *                the raw-string read path would use the token, quotes and all.
 */
export const ENCRYPTED_SETTING_KEYS = {
  'git.provider.config': 'json',
  'vault.adminToken': 'string',
  'vault.unsealKeys': 'json',
} as const

export type EncryptedSettingKey = keyof typeof ENCRYPTED_SETTING_KEYS

/** Encrypt and upsert a SystemSetting value, using the encoding registered for `key`. */
export async function writeEncryptedSetting(key: EncryptedSettingKey, value: unknown): Promise<void> {
  const encoding = ENCRYPTED_SETTING_KEYS[key]
  if (encoding === 'string' && typeof value !== 'string') {
    // String(someObject) silently produces "[object Object]" — a plausible-looking
    // but garbage encrypted value with no error anywhere. Only bare strings are
    // valid for a 'string'-encoded key.
    throw new Error(`writeEncryptedSetting('${key}', …): expected a string value, got ${typeof value}`)
  }
  const encrypted = encoding === 'string' ? encrypt(value as string) : encryptJson(value)
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: encrypted },
    create: { key, value: encrypted },
  })
}

/**
 * Startup self-heal: for each known-sensitive key, if the stored value isn't
 * an enc:v1:-prefixed string, re-encrypt it in place. Logs loudly either way —
 * this should never be silent, since a corrupted row here breaks whatever
 * feature reads it, potentially much later and far from this code path.
 */
export async function healUnencryptedSettings(): Promise<void> {
  for (const key of Object.keys(ENCRYPTED_SETTING_KEYS) as EncryptedSettingKey[]) {
    try {
      const setting = await prisma.systemSetting.findUnique({ where: { key } })
      if (!setting) continue // not configured yet — nothing to heal

      if (typeof setting.value === 'string' && setting.value.startsWith(PREFIX)) {
        continue // already correctly encrypted
      }

      console.error(
        `[encrypted-settings] SystemSetting '${key}' is not encrypted (found ${typeof setting.value}) — ` +
        `auto-re-encrypting. This should not happen from normal operation; if it recurs, a write path for ` +
        `this key is bypassing writeEncryptedSetting().`,
      )

      // The stored value is whatever the corrupted write left behind. Two shapes
      // are possible for a 'json'-encoded key: the raw parsed object (jsonb column
      // holding it directly — decrypt() no-op passthrough leaves it untouched
      // since it's not even a string), or a JSON string that was never parsed back
      // out (e.g. '{"type":"gitea"}' sitting in the column as a string). Re-running
      // that through encryptJson as-is would double-encode it — decryptJsonStrict
      // would later hand back a string instead of the config object. Try to parse
      // it back to the real object first; if it's not valid JSON, it's presumably
      // already the intended value (a 'string'-encoded key, or genuinely a plain
      // string) and passes through unchanged.
      const encoding = ENCRYPTED_SETTING_KEYS[key]
      let rawValue: unknown = typeof setting.value === 'string' ? decrypt(setting.value) : setting.value
      if (encoding === 'json' && typeof rawValue === 'string') {
        try {
          rawValue = JSON.parse(rawValue)
        } catch {
          // Not JSON — leave as the raw string and let writeEncryptedSetting's
          // encryptJson wrap it, same as before this check existed.
        }
      }
      await writeEncryptedSetting(key, rawValue)

      console.error(`[encrypted-settings] '${key}' re-encrypted successfully.`)
    } catch (e) {
      // Isolate per-key failures — one bad key must not block the others or crash startup.
      console.error(`[encrypted-settings] failed to heal '${key}':`, e)
    }
  }
}
