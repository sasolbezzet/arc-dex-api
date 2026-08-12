import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// An OAuth/SIWE identity must have an explicit alias to its MSCA. There is
// intentionally no global "most recently used wallet" fallback.
const EOA = '0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e'
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

test('EOA without explicit MSCA alias cannot resolve a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const store = {
    users: {
      [A]: { walletAddress: A, delegateAddress: A, delegatePrivateKey: 'ZGVuZw==', chain: 'arc-testnet', createdAt: 2000, active: true, authorizationUserOpHash: '0x' + '11'.repeat(32), lastUsedAt: 1000 },
      [B]: { walletAddress: B, delegateAddress: B, delegatePrivateKey: 'ZGVuZw==', chain: 'arc-testnet', createdAt: 1000, active: true, authorizationUserOpHash: '0x' + '22'.repeat(32), lastUsedAt: 3000 },
    },
    aliases: {},
  }
  await writeFile(path, JSON.stringify(store))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'

  try {
    const mod = await import('../src/services/sessionKeyService.mjs?t=' + Date.now())
    assert.equal(mod.getSessionKey(EOA), null, 'unbound EOA must not inherit another wallet session')
    const aliased = { ...store, aliases: { [EOA]: B } }
    await writeFile(path, JSON.stringify(aliased))
    const mod2 = await import('../src/services/sessionKeyService.mjs?t=' + Date.now())
    const e2 = mod2.getSessionKey(EOA)
    assert.equal(e2.walletAddress.toLowerCase(), B, 'explicit alias resolves the selected MSCA')
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('inactive legacy OAuth owner does not shadow an active explicit MSCA alias', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const EOA = '0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e'
  const MSCA = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  await writeFile(path, JSON.stringify({
    users: {
      [EOA]: { walletAddress: EOA, delegateAddress: EOA, chain: 'arc-testnet', createdAt: 1, active: false },
      [MSCA]: { walletAddress: MSCA, delegateAddress: MSCA, chain: 'arc-testnet', createdAt: 2, active: true, authorizationUserOpHash: '0x' + '44'.repeat(32) },
    },
    aliases: { [EOA]: MSCA },
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?alias-shadow-' + Date.now())
    const entry = mod.getSessionKey(EOA)
    assert.equal(entry?.active, true)
    assert.equal(entry?.walletAddress.toLowerCase(), MSCA)
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('explicit alias takes precedence over an active exact identity with stale authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const MSCA = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  await writeFile(path, JSON.stringify({
    users: {
      [EOA]: { walletAddress: EOA, delegateAddress: EOA, chain: 'arc-testnet', createdAt: 1, active: true, authorizationUserOpHash: '' },
      [MSCA]: { walletAddress: MSCA, delegateAddress: MSCA, chain: 'arc-testnet', createdAt: 2, active: true, authorizationUserOpHash: '0x' + '55'.repeat(32) },
    },
    aliases: { [EOA]: MSCA },
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?stale-exact-' + Date.now())
    const entry = mod.getSessionKey(EOA)
    assert.equal(entry?.active, true)
    assert.equal(entry?.walletAddress.toLowerCase(), MSCA)
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('touchSessionKey updates the active aliased MSCA, not inactive legacy OAuth owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const MSCA = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  await writeFile(path, JSON.stringify({
    users: {
      [EOA]: { walletAddress: EOA, delegateAddress: EOA, chain: 'arc-testnet', createdAt: 1, active: false, lastUsedAt: 1 },
      [MSCA]: { walletAddress: MSCA, delegateAddress: MSCA, chain: 'arc-testnet', createdAt: 2, active: true, authorizationUserOpHash: '0x' + '66'.repeat(32), lastUsedAt: 1 },
    },
    aliases: { [EOA]: MSCA },
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?touch-alias-' + Date.now())
    const before = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    const touched = mod.touchSessionKey(EOA)
    assert.equal(touched?.walletAddress.toLowerCase(), MSCA)
    const after = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    assert.equal(after.users[EOA].lastUsedAt, before.users[EOA].lastUsedAt)
    assert.ok(after.users[MSCA].lastUsedAt > before.users[MSCA].lastUsedAt)
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('inactive aliased MSCA blocks touching an active legacy EOA record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const initialActivity = Date.now()
  await writeFile(path, JSON.stringify({
    users: {
      [EOA]: { walletAddress: EOA, delegateAddress: EOA, chain: 'arc-testnet', createdAt: initialActivity, active: true, lastUsedAt: initialActivity },
      ['0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5']: { walletAddress: '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5', delegateAddress: EOA, chain: 'arc-testnet', createdAt: initialActivity, active: false, lastUsedAt: initialActivity },
    },
    aliases: { [EOA]: '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5' },
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?touch-inactive-alias-' + Date.now())
    assert.equal(mod.touchSessionKey(EOA), null)
    const after = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    assert.equal(after.users[EOA].lastUsedAt, initialActivity)
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('inactive legacy owner with walletAddress but no explicit alias remains inactive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const MSCA = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  await writeFile(path, JSON.stringify({
    users: {
      [EOA]: { walletAddress: MSCA, delegateAddress: EOA, chain: 'arc-testnet', createdAt: 1, active: false },
      [MSCA]: { walletAddress: MSCA, delegateAddress: MSCA, chain: 'arc-testnet', createdAt: 2, active: true, authorizationUserOpHash: '0x' + '77'.repeat(32) },
    },
    aliases: {},
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?no-wallet-promotion-' + Date.now())
    assert.equal(mod.getSessionKey(EOA)?.active, false)
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('listRelatedAddresses clusters EOA and MSCA bidirectionally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const EOA = '0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e'
  const MSCA = '0x949db01670147884fe3d4e8832747807fef52063'
  const store = {
    users: { [MSCA]: { walletAddress: MSCA, delegateAddress: MSCA, delegatePrivateKey: 'ZGVuZw==', chain: 'arc-testnet', createdAt: 1, active: true } },
    aliases: { [EOA]: MSCA },
  }
  await writeFile(path, JSON.stringify(store))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?c=' + Date.now())
    const fromEoa = mod.listRelatedAddresses(EOA)
    const fromMsca = mod.listRelatedAddresses(MSCA)
    assert.ok(fromEoa.includes(MSCA), 'EOA cluster includes MSCA')
    assert.ok(fromMsca.includes(EOA), 'MSCA cluster includes EOA')
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('hashless pending reservation stays bound and never rotates automatically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const MSCA = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  const pendingDelegate = '0xf59dbe98c0863519d5f8f7e82a6b5451763782af'
  await writeFile(path, JSON.stringify({
    users: {
      [MSCA]: {
        walletAddress: MSCA,
        delegateAddress: pendingDelegate,
        delegatePrivateKey: 'ZGVuZw==',
        chain: 'arc-testnet',
        createdAt: 1,
        active: false,
        pendingAuthorization: true,
      },
    },
    aliases: {},
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?orphan-stable-' + Date.now())
    const result = mod.reserveSessionKey(MSCA, { walletAddress: MSCA })
    assert.equal(result.pending, true)
    assert.equal(result.hashless, true)
    assert.equal(result.address.toLowerCase(), pendingDelegate)
    const after = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    assert.equal(after.users[MSCA].delegateAddress.toLowerCase(), pendingDelegate)
    assert.equal(after.users[MSCA].pendingAuthorization, true)
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})


test('canExecuteViaSession parses human amounts tolerantly and rejects bad ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const A = '0x1111111111111111111111111111111111111111'
  await writeFile(path, JSON.stringify({
    users: { [A]: { walletAddress: A, delegateAddress: A, delegatePrivateKey: 'ZGVuZw==', chain: 'arc-testnet', createdAt: 1, active: true, authorizationUserOpHash: '0x' + '33'.repeat(32) } },
    aliases: {},
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?a=' + Date.now())
    assert.ok(mod.canExecuteViaSession(A, '1.5').ok, 'plain decimal ok')
    assert.ok(mod.canExecuteViaSession(A, '1.5 USDC').ok, 'with unit ok')
    assert.ok(mod.canExecuteViaSession(A, '$10').ok, 'dollar ok')
    assert.ok(mod.canExecuteViaSession(A, '2 USDC swap').ok, 'phrase ok')
    assert.equal(mod.canExecuteViaSession(A, 'abc').reason, 'bad_amount', 'text rejected')
    assert.equal(mod.canExecuteViaSession(A, '').reason, 'bad_amount', 'empty rejected')
    assert.equal(mod.canExecuteViaSession(A, '0').reason, 'bad_amount', 'zero rejected')
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('Circle/viem owns UserOperation fee selection without a local fee floor', async () => {
  const mod = await import('../src/services/sessionKeyService.mjs?fee-floor-' + Date.now())
  const params = mod.buildUserOperationParams({ account: {}, calls: [] })
  assert.deepEqual(params, { account: {}, calls: [] })
  assert.equal(mod.shouldUseSessionPaymaster, undefined)
  assert.equal(mod.normalizeArbitrumUserOperationFees, undefined)
  assert.equal(mod.validateSignedUserOperationFees, undefined)
})

test('UserOperation status can explicitly target a destination chain instead of session default', async () => {
  const mod = await import('../src/services/sessionKeyService.mjs?chain-override-' + Date.now())
  assert.deepEqual(mod.resolveUserOpChainKey({ chain: 'arc-testnet' }, 'arbitrum-sepolia'), {
    chainKey: 'arbitrum-sepolia',
    explicit: true,
  })
  assert.deepEqual(mod.resolveUserOpChainKey({ chain: 'arc-testnet' }), {
    chainKey: 'arc-testnet',
    explicit: false,
  })
})

test('session is automatically revoked after 24 hours without agent activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const MSCA = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  const now = Date.now()
  await writeFile(path, JSON.stringify({
    users: {
      [MSCA]: {
        walletAddress: MSCA,
        delegateAddress: MSCA,
        chain: 'arbitrum-sepolia',
        createdAt: now - (48 * 60 * 60 * 1000),
        activatedAt: now - (25 * 60 * 60 * 1000),
        lastUsedAt: now - (24 * 60 * 60 * 1000),
        active: true,
        authorizationUserOpHash: '0x' + '88'.repeat(32),
      },
    },
    aliases: {},
  }))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'
  try {
    const mod = await import('../src/services/sessionKeyService.mjs?expiry-' + Date.now())
    const entry = mod.getSessionKey(MSCA)
    assert.equal(entry?.active, false)
    const after = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'))
    assert.equal(after.users[MSCA].revokeReason, 'inactivity_24h')
    assert.ok(after.users[MSCA].revokedAt >= now)
    assert.equal(mod.canExecuteViaSession(MSCA, '1', 'arbitrum-sepolia').reason, 'no_session')
  } finally {
    if (prev === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = prev
    await rm(dir, { recursive: true, force: true })
  }
})
