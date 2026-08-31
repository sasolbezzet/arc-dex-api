// Fase 1 — per-agent binding store (TDD).
// Each agent identity (`userId|delegateEoa`) binds to exactly one Agent Wallet
// MSCA owned by one owner EOA. Bindings live beside users/aliases in the
// session key store and must never clobber each other across agents.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0xcccccccccccccccccccccccccccccccccccccccc'
const OTHER_OWNER = '0xdddddddddddddddddddddddddddddddddddddddd'
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const W2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const EOA_A = '0x1111111111111111111111111111111111111111'
const EOA_B = '0x2222222222222222222222222222222222222222'
const AGENT_A = `client-a|${EOA_A}`
const AGENT_B = `client-b|${EOA_B}`
const USER_OP_HASH = `0x${'ab'.repeat(32)}`

async function withSessionStore(initialStore, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-agent-bindings-'))
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
    const service = await import('../src/services/sessionKeyService.mjs?agent-bindings-' + Date.now() + '-' + Math.random())
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

test('bindAgent stores the wallet binding for one agent key', async () => {
  await withSessionStore({}, async ({ bindAgent, getAgentBinding }) => {
    const bound = bindAgent(AGENT_A, OWNER.toUpperCase(), W1.toUpperCase())
    assert.equal(bound.walletAddress, W1)
    const binding = getAgentBinding(AGENT_A)
    assert.ok(binding, 'binding must exist after bindAgent')
    assert.equal(binding.walletAddress, W1)
    assert.equal(binding.ownerAddress, OWNER)
    assert.equal(typeof binding.boundAt, 'number')
    assert.equal(typeof binding.lastUsedAt, 'number')

    // Persisted to the shared session key store, addresses lowercased.
    const raw = await readRawStore()
    assert.equal(raw.agentBindings[AGENT_A].walletAddress, W1)
    assert.equal(raw.agentBindings[AGENT_A].ownerAddress, OWNER)
  })
})

test('different agent keys keep different wallets without overwriting each other', async () => {
  await withSessionStore({}, async ({ bindAgent, getAgentBinding }) => {
    bindAgent(AGENT_A, OWNER, W1)
    bindAgent(AGENT_B, OWNER, W2)
    assert.equal(getAgentBinding(AGENT_A)?.walletAddress, W1)
    assert.equal(getAgentBinding(AGENT_B)?.walletAddress, W2)

    const raw = await readRawStore()
    assert.equal(Object.keys(raw.agentBindings).length, 2)
    assert.notEqual(raw.agentBindings[AGENT_A].walletAddress, raw.agentBindings[AGENT_B].walletAddress)
  })
})

test('agent bindings reject reusing one wallet for another agent', async () => {
  await withSessionStore({}, async ({ bindAgent }) => {
    process.env.ENFORCE_UNIQUE_AGENT_WALLETS = 'true'
    try {
      bindAgent(AGENT_A, OWNER, W1)
      assert.throws(() => bindAgent(AGENT_B, OWNER, W1), /wallet.*already.*agent|wallet.*reuse|agent.*wallet/i)
    } finally {
      delete process.env.ENFORCE_UNIQUE_AGENT_WALLETS
    }
  })
})

test('revokeAgentBinding removes exactly one row', async () => {
  await withSessionStore({
    agentBindings: {
      [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 100, lastUsedAt: 100 },
      [AGENT_B]: { ownerAddress: OWNER, walletAddress: W2, boundAt: 200, lastUsedAt: 200 },
    },
  }, async ({ revokeAgentBinding, getAgentBinding }) => {
    assert.equal(revokeAgentBinding(AGENT_A.toUpperCase()), true, 'agentKey lookup is case-insensitive')
    assert.equal(getAgentBinding(AGENT_A), null)
    assert.equal(getAgentBinding(AGENT_B)?.walletAddress, W2, 'sibling binding survives')

    const raw = await readRawStore()
    assert.deepEqual(Object.keys(raw.agentBindings), [AGENT_B])
    assert.equal(revokeAgentBinding('unknown-agent'), false, 'revoking an absent binding changes nothing')
  })
})

test('revoke cleans legacy duplicate rows and removes the wallet alias when unused', async () => {
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, active: true } },
    aliases: { [OWNER]: W1, [W1]: W1 },
    agentBindings: {
      [`oauth:client-a`]: { ownerAddress: OWNER, walletAddress: W1 },
      [`client-a|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1 },
    },
  }, async ({ revokeAgentBinding, getAgentBinding, listRelatedAddresses }) => {
    assert.equal(revokeAgentBinding(`client-a|${OWNER}`), true)
    assert.equal(getAgentBinding('oauth:client-a'), null)
    assert.equal(getAgentBinding(`client-a|${OWNER}`), null)
    assert.deepEqual(listRelatedAddresses(OWNER), [OWNER])
    const raw = await readRawStore()
    assert.equal(raw.users[W1].active, false)
    assert.equal(raw.aliases[OWNER], undefined)
  })
})

test('bindAgent fills the legacy user alias so getSessionKey resolves the agent wallet', async () => {
  await withSessionStore({
    users: {
      // The agent wallet itself holds an active session record, exactly like
      // the production passkey flow, so the alias can resolve through it.
      [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true, authorizationUserOpHash: USER_OP_HASH },
    },
  }, async ({ bindAgent, getSessionKey }) => {
    bindAgent(AGENT_A, OWNER, W1)
    const entry = getSessionKey('client-a')
    assert.ok(entry, 'legacy userId must resolve through the alias')
    assert.equal(entry.walletAddress, W1)
  })
})

test('touchAgentBinding only advances lastUsedAt', async () => {
  await withSessionStore({
    agentBindings: {
      [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 100, lastUsedAt: 100 },
    },
  }, async ({ touchAgentBinding }) => {
    const touched = touchAgentBinding(AGENT_A)
    assert.ok(touched, 'touching an existing binding returns it')
    assert.equal(touched.ownerAddress, OWNER)
    assert.equal(touched.walletAddress, W1)
    assert.equal(touched.boundAt, 100)
    assert.ok(touched.lastUsedAt > 100, 'lastUsedAt advanced')

    const raw = await readRawStore()
    const stored = raw.agentBindings[AGENT_A]
    assert.deepEqual(
      { ...stored, lastUsedAt: 0 },
      { ownerAddress: OWNER, walletAddress: W1, boundAt: 100, lastUsedAt: 0 },
      'only lastUsedAt may change',
    )
  })
})

test('listAgentBindings returns only bindings owned by the requested address', async () => {
  await withSessionStore({
    agentBindings: {
      [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 100, lastUsedAt: 100 },
      [AGENT_B]: { ownerAddress: OTHER_OWNER, walletAddress: W2, boundAt: 200, lastUsedAt: 200 },
    },
  }, async ({ listAgentBindings }) => {
    const mine = listAgentBindings(OWNER.toUpperCase())
    assert.equal(mine.length, 1)
    assert.equal(mine[0].agentKey, AGENT_A)
    assert.equal(mine[0].walletAddress, W1)
    assert.equal(listAgentBindings(OTHER_OWNER).length, 1)
    assert.equal(listAgentBindings('0x9999999999999999999999999999999999999999').length, 0)
  })
})

test('legacy OAuth namespace is migrated into one durable binding', async () => {
  const clientId = 'oauth-client'
  const legacyKey = `oauth:${clientId}`
  const durableKey = `${clientId}|${OWNER}`
  await withSessionStore({
    agentBindings: {
      [legacyKey]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 100, lastUsedAt: 200, credentialIds: ['legacy-credential'] },
      [durableKey]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 150, lastUsedAt: 300, credentialIds: ['durable-credential'] },
    },
  }, async ({ listAgentBindingsForIdentity }) => {
    const visible = listAgentBindingsForIdentity(W1)
    assert.equal(visible.length, 1)
    assert.equal(visible[0].agentKey, durableKey)
    assert.equal(visible[0].walletAddress, W1)
    assert.deepEqual(visible[0].credentialIds.sort(), ['durable-credential', 'legacy-credential'])

    const raw = await readRawStore()
    assert.equal(raw.agentBindings[legacyKey], undefined)
    assert.ok(raw.agentBindings[durableKey])
  })
})

test('different OAuth clients remain separate when wallet addresses match', async () => {
  await withSessionStore({
    agentBindings: {
      [`claude|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 100 },
      [`chatgpt|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 200 },
    },
  }, async ({ listAgentBindingsForIdentity }) => {
    const visible = listAgentBindingsForIdentity(OWNER)
    assert.equal(visible.length, 2)
    assert.deepEqual(visible.map(row => row.agentKey), [`claude|${OWNER}`, `chatgpt|${OWNER}`])
  })
})
