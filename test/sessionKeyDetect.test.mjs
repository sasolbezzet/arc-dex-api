import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two active MSCAs, EOA has no explicit alias. Auto-detect must resolve EOA to
// the most recently-USED (lastUsedAt) active MSCA — never hardcoded.
const EOA = '0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e'
const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

test('auto-detect resolves EOA to most recently used active MSCA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-sk-'))
  const path = join(dir, 'session-keys.json')
  const store = {
    users: {
      [A]: { walletAddress: A, delegateAddress: A, delegatePrivateKey: 'ZGVuZw==', chain: 'arc-testnet', createdAt: 2000, active: true, lastUsedAt: 1000 },
      [B]: { walletAddress: B, delegateAddress: B, delegatePrivateKey: 'ZGVuZw==', chain: 'arc-testnet', createdAt: 1000, active: true, lastUsedAt: 3000 },
    },
    aliases: {},
  }
  await writeFile(path, JSON.stringify(store))
  const prev = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test'

  try {
    const mod = await import('../src/services/sessionKeyService.mjs?t=' + Date.now())
    // B has newest lastUsedAt -> auto-detect picks B even though A is newer by createdAt
    const e = mod.getSessionKey(EOA)
    assert.ok(e, 'should resolve a session for EOA')
    assert.equal(e.walletAddress.toLowerCase(), B, 'picks most-recently-used MSCA')
    // Touching A (setting its lastUsedAt newest) makes A the resolved one next time
    const store2 = { ...store, users: { ...store.users, [A]: { ...store.users[A], lastUsedAt: 9999 } } }
    await writeFile(path, JSON.stringify(store2))
    const mod2 = await import('../src/services/sessionKeyService.mjs?t=' + Date.now())
    const e2 = mod2.getSessionKey(EOA)
    assert.equal(e2.walletAddress.toLowerCase(), A, 'after touch, resolves to newly-used MSCA')
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
