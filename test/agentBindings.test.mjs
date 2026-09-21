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

test('revokeAgentBinding preserves the binding while disabling the session', async () => {
  await withSessionStore({
    agentBindings: {
      [AGENT_A]: { ownerAddress: OWNER, walletAddress: W1, boundAt: 100, lastUsedAt: 100 },
      [AGENT_B]: { ownerAddress: OWNER, walletAddress: W2, boundAt: 200, lastUsedAt: 200 },
    },
  }, async ({ revokeAgentBinding, getAgentBinding }) => {
    assert.equal(revokeAgentBinding(AGENT_A.toUpperCase()), true, 'agentKey lookup is case-insensitive')
    assert.equal(getAgentBinding(AGENT_A)?.active, false)
    assert.equal(getAgentBinding(AGENT_B)?.walletAddress, W2, 'sibling binding survives')

    const raw = await readRawStore()
    assert.deepEqual(Object.keys(raw.agentBindings), [AGENT_A, AGENT_B])
    assert.equal(raw.agentBindings[AGENT_A].revokeReason, 'agent_manual')
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
    assert.equal(getAgentBinding('oauth:client-a')?.active, false)
    assert.equal(getAgentBinding(`client-a|${OWNER}`)?.active, false)
    assert.equal(listRelatedAddresses(OWNER).includes(W1), true)
    const raw = await readRawStore()
    assert.equal(raw.users[W1].active, false)
    assert.equal(raw.aliases[OWNER], W1)
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

test('Hermes passkey namespace resolves the canonical connection binding over a legacy row', async () => {
  const canonicalKey = `arcox_conn_hermes123|${OWNER}`
  await withSessionStore({
    agentBindings: {
      // This stale row was created by the old browser namespace and points at
      // another wallet. It must not shadow the durable connection binding.
      'hermes-mcp': { ownerAddress: OWNER, walletAddress: W2, active: true },
      [canonicalKey]: {
        ownerAddress: OWNER,
        walletAddress: W1,
        active: false,
        revokedAt: 123,
        revokeReason: 'agent_manual',
        credentialIds: ['hermes-credential'],
      },
    },
  }, async ({ findAgentBindingForAgent, activateAgentBinding }) => {
    const resolved = findAgentBindingForAgent('hermes-mcp', W1)
    assert.equal(resolved?.agentKey, canonicalKey)
    assert.equal(resolved?.walletAddress, W1)

    const activated = activateAgentBinding(canonicalKey, W1)
    assert.equal(activated?.agentKey, canonicalKey)
    assert.equal(activated?.active, true)
    assert.deepEqual(activated?.credentialIds, ['hermes-credential'])
    assert.equal(activated?.revokeReason, undefined)
    assert.equal(activated?.revokedAt, undefined)
    assert.equal(findAgentBindingForAgent('hermes-mcp', W2)?.agentKey, 'hermes-mcp')
  })
})

test('legacy wallet with missing agent row can recover one canonical binding for the proven owner', async () => {
  const legacyAgentKey = 'oauth:client-a'
  await withSessionStore({
    users: {
      [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true, authorizationUserOpHash: USER_OP_HASH },
    },
    aliases: { [OWNER]: W1 },
    agentBindings: {},
  }, async ({ ensureAgentBindingForWallet, getAgentBinding, findAgentBindingForAgent }) => {
    const recovered = ensureAgentBindingForWallet(legacyAgentKey, OWNER, W1, { credentialId: 'recovered-credential' })
    const canonicalKey = `client-a|${OWNER}`
    assert.equal(recovered?.agentKey, canonicalKey)
    assert.equal(recovered?.walletAddress, W1)
    assert.equal(recovered?.ownerAddress, OWNER)
    assert.equal(recovered?.active, true)
    assert.deepEqual(getAgentBinding(canonicalKey)?.credentialIds, ['recovered-credential'])
    assert.equal(findAgentBindingForAgent(legacyAgentKey, W1)?.agentKey, canonicalKey)
  })
})

test('legacy wallet recovery rejects an owner without a persisted wallet relationship', async () => {
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true } },
    aliases: { [OTHER_OWNER]: W2 },
    agentBindings: {},
  }, async ({ ensureAgentBindingForWallet }) => {
    assert.throws(
      () => ensureAgentBindingForWallet('oauth:client-a', OWNER, W1),
      /agent_owner_wallet_relationship_missing/,
    )
  })
})

test('Hermes passkey resolution fails closed when the same wallet belongs to multiple owners', async () => {
  const otherOwner = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  await withSessionStore({
    agentBindings: {
      [`arcox_conn_one|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1 },
      [`arcox_conn_two|${otherOwner}`]: { ownerAddress: otherOwner, walletAddress: W1 },
    },
  }, async ({ findAgentBindingForAgent }) => {
    assert.equal(findAgentBindingForAgent('hermes-mcp', W1), null)
  })
})

test('a generic namespace owned by another owner cannot block a new owner wallet', async () => {
  const legacyOwner = '0xffffffffffffffffffffffffffffffffffffffff'
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true } },
    aliases: { [OWNER]: W1 },
    agentBindings: {
      // Legacy row from a different owner squatting on the shared generic key.
      'hermes-mcp': { ownerAddress: legacyOwner, walletAddress: '0x9999999999999999999999999999999999999999', active: true },
    },
  }, async ({ ensureAgentBindingForWallet, findAgentBindingForAgent }) => {
    const binding = ensureAgentBindingForWallet('hermes-mcp', OWNER, W1)
    assert.equal(binding.agentKey, `hermes-mcp|${OWNER}`, 'the new owner gets an owner-scoped durable row')
    assert.equal(binding.walletAddress, W1)

    const raw = await readRawStore()
    assert.equal(
      raw.agentBindings['hermes-mcp'].ownerAddress,
      legacyOwner,
      'the other owner legacy row must stay untouched',
    )
    assert.equal(findAgentBindingForAgent('hermes-mcp', W1)?.agentKey, `hermes-mcp|${OWNER}`)
  })
})

test('the same owner still cannot rotate the generic namespace to a second wallet', async () => {
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true } },
    aliases: { [OWNER]: W1 },
    agentBindings: {
      'hermes-mcp': { ownerAddress: OWNER, walletAddress: W2, active: true },
    },
  }, async ({ ensureAgentBindingForWallet }) => {
    assert.throws(() => ensureAgentBindingForWallet('hermes-mcp', OWNER, W1), /agent_wallet_rotation_forbidden/)
  })
})

// ── Hermes stores one logical agent in two namespaces: the durable
// connection-token row (`arcox_conn_*|owner`) that the dashboard card is built
// from, and the browser/passkey row (`hermes-mcp`). Clear and Revoke must reach
// both, otherwise the surviving row keeps rendering the card after the user
// removed the agent.

const CONN_A = `arcox_conn_abc123|${OWNER}`

test('clear via the Hermes connection row also removes the passkey row', async () => {
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true } },
    agentBindings: {
      [CONN_A]: { ownerAddress: OWNER, walletAddress: W1, active: true },
      'hermes-mcp': { ownerAddress: OWNER, walletAddress: W1, active: true },
      [`client-x|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1, active: true },
      [`arcox_conn_zzz99|${OTHER_OWNER}`]: { ownerAddress: OTHER_OWNER, walletAddress: W2, active: true },
    },
  }, async ({ deleteAgentBinding }) => {
    assert.equal(deleteAgentBinding(CONN_A), true)
    const raw = await readRawStore()
    assert.equal(raw.agentBindings[CONN_A], undefined, 'the connection row is gone')
    assert.equal(raw.agentBindings['hermes-mcp'], undefined, 'the passkey namespace row is gone too')
    assert.ok(raw.agentBindings[`client-x|${OWNER}`], 'another agent on the same wallet stays')
    assert.ok(raw.agentBindings[`arcox_conn_zzz99|${OTHER_OWNER}`], "another owner's wallet stays")
  })
})

test('clear via the Hermes passkey row also removes the connection row', async () => {
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true } },
    agentBindings: {
      [CONN_A]: { ownerAddress: OWNER, walletAddress: W1, active: true },
      'hermes-mcp': { ownerAddress: OWNER, walletAddress: W1, active: true },
    },
  }, async ({ deleteAgentBinding, findAgentBindingForAgent }) => {
    assert.equal(deleteAgentBinding('hermes-mcp'), true)
    const raw = await readRawStore()
    assert.equal(raw.agentBindings[CONN_A], undefined)
    assert.equal(raw.agentBindings['hermes-mcp'], undefined)
    assert.equal(findAgentBindingForAgent('hermes-mcp', W1), null, 'no Hermes binding survives a clear')
  })
})

test('revoke disables both Hermes namespaces and leaves other agents active', async () => {
  await withSessionStore({
    users: { [W1]: { walletAddress: W1, delegateAddress: EOA_A, active: true } },
    agentBindings: {
      [CONN_A]: { ownerAddress: OWNER, walletAddress: W1, active: true },
      'hermes-mcp': { ownerAddress: OWNER, walletAddress: W1, active: true },
      [`client-x|${OWNER}`]: { ownerAddress: OWNER, walletAddress: W1, active: true },
    },
  }, async ({ revokeAgentBinding }) => {
    assert.equal(revokeAgentBinding(CONN_A), true)
    const raw = await readRawStore()
    assert.equal(raw.agentBindings[CONN_A].active, false, 'connection row is revoked')
    assert.equal(raw.agentBindings['hermes-mcp'].active, false, 'passkey row cannot stay active')
    assert.notEqual(raw.agentBindings[`client-x|${OWNER}`].active, false, 'another agent keeps working')
  })
})
