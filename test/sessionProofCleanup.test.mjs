// Revoke and Clear must not leave a replayable authorization proof behind.
//
// The stored addOwners hash is only a recovery proof for a legacy inactivity
// expiry, where the on-chain owner is still valid. After an explicit revoke or
// clear the user ended access for that agent, so keeping the hash made the
// status endpoint advertise a proof that could resurrect the old delegate and
// made the browser reconcile a UserOperation the user never re-approved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0xcccccccccccccccccccccccccccccccccccccccc'
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DELEGATE = '0x9999999999999999999999999999999999999999'
const USER_OP_HASH = `0x${'ab'.repeat(32)}`
const ARC_HASH = `0x${'cd'.repeat(32)}`
const AGENT_A = `client-a|${OWNER}`

function sessionRecord(extra = {}) {
  return {
    walletAddress: W1,
    delegateAddress: DELEGATE,
    delegatePrivateKey: 'encrypted-placeholder',
    chain: 'arc-testnet',
    active: true,
    pendingAuthorization: false,
    authorizationUserOpHash: USER_OP_HASH,
    authorizationUserOpHashes: { 'arc-testnet': ARC_HASH },
    lastAuthorizationOutcome: 'success',
    lastAuthorizationTransactionHash: `0x${'ef'.repeat(32)}`,
    createdAt: 100,
    activatedAt: 200,
    lastUsedAt: 300,
    ...extra,
  }
}

async function withSessionStore(initialStore, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-proof-cleanup-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = process.env.SESSION_KEY_ENCRYPTION_KEY || 'test-only-session-encryption-key'
  await writeFile(
    process.env.SESSION_KEYS_PATH,
    JSON.stringify({ users: {}, aliases: {}, agentBindings: {}, ...initialStore }),
    'utf8',
  )
  try {
    const service = await import('../src/services/sessionKeyService.mjs?proof-cleanup-' + Date.now() + '-' + Math.random())
    return await fn(service)
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    await rm(dir, { recursive: true, force: true })
  }
}

async function readRawStore() {
  return JSON.parse(await readFile(process.env.SESSION_KEYS_PATH, 'utf8'))
}

test('clear drops the stored authorization proof with the binding', async () => {
  await withSessionStore({
    users: { [W1]: sessionRecord() },
    agentBindings: { [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, active: true } },
  }, async ({ deleteAgentBinding }) => {
    assert.equal(deleteAgentBinding(AGENT_A), true)

    const entry = (await readRawStore()).users[W1]
    assert.equal(entry.authorizationUserOpHash, '', 'stale hash must not survive a clear')
    assert.deepEqual(entry.authorizationUserOpHashes, {})
    assert.equal(entry.lastAuthorizationOutcome, undefined)
    assert.equal(entry.lastAuthorizationTransactionHash, undefined)
    assert.equal(entry.active, false)
    assert.equal(entry.revokeReason, 'agent_deleted')
    // The delegate stays on-chain and the record keeps the address so the same
    // wallet can be re-bound later with a fresh owner proof.
    assert.equal(entry.delegateAddress, DELEGATE)
  })
})

test('clear keeps a wallet shared by another active agent untouched', async () => {
  await withSessionStore({
    users: { [W1]: sessionRecord() },
    agentBindings: {
      [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, active: true },
      [`client-b|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1, active: true },
    },
  }, async ({ deleteAgentBinding }) => {
    assert.equal(deleteAgentBinding(AGENT_A), true)

    const store = await readRawStore()
    assert.equal(store.users[W1].active, true, 'a sibling agent still needs this wallet session')
    assert.equal(store.users[W1].authorizationUserOpHash, USER_OP_HASH)
  })
})

test('revoke drops the stored authorization proof', async () => {
  await withSessionStore({
    users: { [W1]: sessionRecord() },
    agentBindings: { [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, active: true } },
  }, async ({ revokeAgentBinding }) => {
    assert.equal(revokeAgentBinding(AGENT_A), true)

    const store = await readRawStore()
    assert.equal(store.agentBindings[AGENT_A].active, false, 'the durable binding stays for relogin')
    assert.equal(store.users[W1].authorizationUserOpHash, '')
    assert.deepEqual(store.users[W1].authorizationUserOpHashes, {})
    assert.equal(store.users[W1].revokeReason, 'agent_manual')
  })
})

test('wallet-level session revoke drops the stored authorization proof', async () => {
  await withSessionStore({
    users: { [W1]: sessionRecord() },
  }, async ({ revokeSessionKey }) => {
    const entry = revokeSessionKey(W1)
    assert.equal(entry.revokeReason, 'manual')
    assert.equal(entry.authorizationUserOpHash, '')
    assert.deepEqual(entry.authorizationUserOpHashes, {})
    assert.equal(entry.active, false)
  })
})
