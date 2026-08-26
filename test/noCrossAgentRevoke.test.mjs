import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// L0: per-agent isolation guards.
//  1. A new session setup must NOT auto-revoke an MSCA while another agent
//     still holds a live OAuth token bound to it (anti-cross-revoke).
//  2. Without a live token the historical auto-revoke behavior is unchanged.
//  3. bindMcpIdentityToActiveSession writes per-agent bindings keyed
//     <clientId>|<userId>; two agents on one owner never overwrite each other.

const EOA = '0x1111111111111111111111111111111111111111'
const W1 = '0x2222222222222222222222222222222222222222'
const W2 = '0x3333333333333333333333333333333333333333'
const D1 = '0x4444444444444444444444444444444444444444'
const D2 = '0x5555555555555555555555555555555555555555'
const MSCA_KEY = '0x6666666666666666666666666666666666666666'

async function withEnvPaths(dir, fn) {
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousVaultPath = process.env.VAULT_PATH
  const previousActivityPath = process.env.VAULT_ACTIVITY_PATH
  const previousSessionPath = process.env.VAULT_SESSION_PATH
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'vault-activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify(arguments[2] || { users: {}, aliases: {} }), 'utf8')
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }), 'utf8')
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]', 'utf8')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }), 'utf8')
  try {
    return await fn()
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousVaultPath === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = previousVaultPath
    if (previousActivityPath === undefined) delete process.env.VAULT_ACTIVITY_PATH
    else process.env.VAULT_ACTIVITY_PATH = previousActivityPath
    if (previousSessionPath === undefined) delete process.env.VAULT_SESSION_PATH
    else process.env.VAULT_SESSION_PATH = previousSessionPath
    await rm(dir, { recursive: true, force: true })
  }
}

function activeSessionEntry(wallet, delegate) {
  return {
    walletAddress: wallet,
    delegateAddress: delegate,
    delegatePrivateKey: 'encrypted-test-key',
    chain: 'arc-testnet',
    createdAt: Date.now(),
    active: true,
    // 64-hex proof is required or getSessionKey marks the entry stale.
    authorizationUserOpHash: '0x' + 'ab'.repeat(32),
    authorizationUserOpHashes: { 'arc-testnet': '0x' + 'ab'.repeat(32) },
    lastUsedAt: Date.now(),
  }
}

test('storeSessionKey does not revoke an MSCA while a live OAuth token references it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-no-cross-revoke-'))
  await withEnvPaths(dir, async () => {
    const { storeSessionKey, registerMscaLiveTokenProbe } = await import('../src/services/sessionKeyService.mjs?ncr1-' + Date.now())
    registerMscaLiveTokenProbe(wallet => wallet === W1.toLowerCase()) // agent A still connected to W1

    storeSessionKey(EOA, { walletAddress: W2, delegateAddress: D2, delegatePrivateKey: 'k2', ownerAddress: EOA })

    const store = JSON.parse(await readFile(process.env.SESSION_KEYS_PATH, 'utf8'))
    assert.equal(store.users[W1.toLowerCase()]?.active, true, 'W1 session must survive when another agent holds a live token')
    assert.equal(store.users[EOA]?.active, true, 'new W2 session is active as usual')
    assert.equal(store.users[EOA]?.walletAddress?.toLowerCase(), W2)
  }, { users: { [W1.toLowerCase()]: activeSessionEntry(W1, D1) }, aliases: { [EOA]: W1 } })
})

test('storeSessionKey still revokes a prior MSCA when no live token references it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-no-cross-revoke-'))
  await withEnvPaths(dir, async () => {
    const { storeSessionKey } = await import('../src/services/sessionKeyService.mjs?ncr2-' + Date.now())
    // No probe registered → behaves exactly like the historical path.
    storeSessionKey(EOA, { walletAddress: W2, delegateAddress: D2, delegatePrivateKey: 'k2', ownerAddress: EOA })

    const store = JSON.parse(await readFile(process.env.SESSION_KEYS_PATH, 'utf8'))
    const old = store.users[W1.toLowerCase()]
    assert.equal(old?.active, false, 'W1 is deactivated when nothing depends on it')
    assert.equal(old?.replacedBy?.toLowerCase(), W2.toLowerCase())
  }, { users: { [W1.toLowerCase()]: activeSessionEntry(W1, D1) }, aliases: { [EOA]: W1 } })
})

test('bindMcpIdentityToActiveSession keys bindings by clientId|userId without cross-overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-bind-agents-'))
  await withEnvPaths(dir, async () => {
    // Import WITHOUT query strings so the test shares one vaultStore instance
    // (in-memory session tokens) with the mcpServer module under test.
    const vault = await import('../src/services/vaultStore.mjs')
    const mcp = await import('../src/services/mcpServer.mjs?bind-' + Date.now())
    const { getAgentBinding } = await import('../src/services/sessionKeyService.mjs?bind2-' + Date.now())

    const token = vault.createSession(MSCA_KEY) // passkey-proven vault session for the MSCA
    const bindingA = await mcp.bindMcpIdentityToActiveSession({ userId: EOA, mscaWalletAddress: MSCA_KEY, mscaSessionToken: token, clientId: 'agent_a' })
    const bindingB = await mcp.bindMcpIdentityToActiveSession({ userId: EOA, mscaWalletAddress: MSCA_KEY, mscaSessionToken: token, clientId: 'agent_b' })

    assert.equal(bindingA.ok, true, 'binding A ok, got: ' + JSON.stringify(bindingA))
    assert.equal(bindingB.ok, true)

    const rowA = getAgentBinding('agent_a|' + EOA)
    const rowB = getAgentBinding('agent_b|' + EOA)
    assert.equal(rowA?.walletAddress?.toLowerCase(), MSCA_KEY.toLowerCase(), 'agent A binding written under its own key')
    assert.equal(rowB?.walletAddress?.toLowerCase(), MSCA_KEY.toLowerCase(), 'agent B binding does not overwrite agent A')
    assert.notEqual(rowA, rowB, 'two distinct binding rows')
  }, { users: { [MSCA_KEY]: activeSessionEntry(MSCA_KEY, D1) }, aliases: {} })
})
