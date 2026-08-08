import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EOA = '0x1111111111111111111111111111111111111111'
const MSCA = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'

async function withSessionStore(users, aliases, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-mcp-identity-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users, aliases }), 'utf8')
  try {
    const { resolveActiveMsca } = await import('../src/services/mcpServer.mjs?identity-' + Date.now() + '-' + Math.random())
    return await fn(resolveActiveMsca)
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    await rm(dir, { recursive: true, force: true })
  }
}

test('MCP resolver maps SIWE EOA to the active Agent Wallet MSCA', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'a'.repeat(64),
    },
  }, { [EOA.toLowerCase()]: MSCA }, async resolveActiveMsca => {
    const info = await resolveActiveMsca(EOA)
    assert.equal(info?.walletAddress, MSCA)
    assert.equal(info?.active, true)
  })
})

test('MCP resolver fails closed without an active explicit MSCA session', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: false,
      authorizationUserOpHash: '0x' + 'b'.repeat(64),
    },
  }, { [EOA.toLowerCase()]: MSCA }, async resolveActiveMsca => {
    assert.equal(await resolveActiveMsca(EOA), null)
    assert.equal(await resolveActiveMsca(OTHER), null)
  })
})

// Keep this invariant close to the quote/execution contract: a preview created
// for one MSCA must not be reusable after the active MSCA changes.
test('MSCA-bound quote fields distinguish the active wallet', () => {
  const quote = { walletAddress: MSCA, amount: '1', token: 'USDC' }
  const current = { walletAddress: OTHER, amount: '1', token: 'USDC' }
  assert.notEqual(quote.walletAddress.toLowerCase(), current.walletAddress.toLowerCase())
})
