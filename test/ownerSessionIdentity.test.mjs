// Owner session identities must be one representation.
//
// /api/auth/session used to store the checksummed address in the vault session,
// while every owner-gated route compares `getAddress(...).toLowerCase()`. That
// mismatch rejected a perfectly valid SIWE owner proof with
// "ownerAddress is not authenticated by the supplied EOA session" during Agent
// Wallet creation and Clear re-login — the exact bug this file locks down.
//
// Records written before the normalization (limits/approvals keyed by a
// checksummed address) must keep resolving for the lowercase owner.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHECKSUMMED = '0xEaE1193E9cBe3f9156f5d09AD3dA1d8e01513adC'
const LOWERCASE = CHECKSUMMED.toLowerCase()
const OTHER = '0x0a1b2c3d4e5f60718293a4b5c6d7e8f901234567'

async function withVault(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-owner-identity-'))
  const previous = {
    vault: process.env.VAULT_PATH,
    activity: process.env.VAULT_ACTIVITY_PATH,
    session: process.env.VAULT_SESSION_PATH,
  }
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'sessions.json')
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], approvals: [] }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  try {
    const vault = await import('../src/services/vaultStore.mjs?owner-identity-' + Date.now() + '-' + Math.random())
    return await fn(vault)
  } finally {
    for (const [key, value] of Object.entries({ VAULT_PATH: previous.vault, VAULT_ACTIVITY_PATH: previous.activity, VAULT_SESSION_PATH: previous.session })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('a checksummed session identity resolves to the lowercase address', async () => {
  await withVault(({ createSession, validateSession, normalizeSessionIdentity }) => {
    assert.equal(normalizeSessionIdentity(CHECKSUMMED), LOWERCASE)
    assert.equal(normalizeSessionIdentity(LOWERCASE), LOWERCASE)
    // Non-address identities (connection tokens) pass through untouched.
    assert.equal(normalizeSessionIdentity('client-a|0x1111111111111111111111111111111111111111'), 'client-a|0x1111111111111111111111111111111111111111')

    const token = createSession(CHECKSUMMED)
    assert.equal(validateSession(token), LOWERCASE, 'owner proof comparisons expect one representation')
  })
})

test('the minted session matches the lowercase comparison used by owner-gated routes', async () => {
  await withVault(({ createSession, validateSession }) => {
    const token = createSession(CHECKSUMMED)
    const authenticated = validateSession(token)
    // This is the exact comparison /api/session/generate-key performs.
    const claimedOwnerAddress = '0xEaE1193E9cBe3f9156f5d09AD3dA1d8e01513adC'
    assert.equal(authenticated, claimedOwnerAddress.toLowerCase())
  })
})

test('limits written under a checksummed key stay readable for the lowercase owner', async () => {
  await withVault(({ setLimits, getLimits }) => {
    setLimits(CHECKSUMMED, { maxPerTx: 7 })
    assert.equal(getLimits(LOWERCASE).maxPerTx, 7, 'legacy mixed-case key must still resolve')
    setLimits(LOWERCASE, { dailyLimit: 42 })
    assert.equal(getLimits(CHECKSUMMED).dailyLimit, 42)
    assert.equal(getLimits(CHECKSUMMED).maxPerTx, 7, 'update must not drop the other fields')
    assert.equal(getLimits(OTHER).maxPerTx, 100, 'another owner keeps the defaults')
  })
})

test('approvals owned by a checksummed address are visible to the lowercase owner', async () => {
  await withVault(({ createApproval, listApprovals }) => {
    createApproval(CHECKSUMMED, { agent: 'e2e', action: 'send', amount: 1, token: 'USDC' })
    assert.equal(listApprovals(LOWERCASE).length, 1)
    assert.equal(listApprovals(OTHER).length, 0)
  })
})
