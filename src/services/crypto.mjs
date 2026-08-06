// crypto.mjs — AES-256-GCM encrypt/decrypt for sensitive vault fields.
// ponytail: single-key envelope encryption. Upgrade: per-user keys or HSM.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const ALGO = 'aes-256-gcm'
const KEY_LEN = 32
const IV_LEN = 12
const TAG_LEN = 16
const SALT_LEN = 16

// Derive a 32-byte key from the env passphrase + salt.
function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LEN, { N: 2 ** 15, r: 8, p: 1 })
}

/**
 * Encrypt a plaintext string. Returns base64: salt(16) + iv(12) + tag(16) + ciphertext.
 */
export function encrypt(plaintext) {
  const passphrase = process.env.SESSION_KEY_ENCRYPTION_KEY
  if (!passphrase) throw new Error('SESSION_KEY_ENCRYPTION_KEY not set')
  const salt = randomBytes(SALT_LEN)
  const key = deriveKey(passphrase, salt)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, tag, encrypted]).toString('base64')
}

/**
 * Decrypt an encrypted string produced by encrypt().
 */
export function decrypt(encoded) {
  const passphrase = process.env.SESSION_KEY_ENCRYPTION_KEY
  if (!passphrase) throw new Error('SESSION_KEY_ENCRYPTION_KEY not set')
  const buf = Buffer.from(encoded, 'base64')
  const salt = buf.subarray(0, SALT_LEN)
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN)
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN)
  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
}
