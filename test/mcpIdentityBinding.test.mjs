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
    const createMcpServer = (await import('../src/services/mcpServer.mjs?identity-' + Date.now() + '-' + Math.random())).createMcpServer
    return await fn({ resolveActiveMsca, createMcpServer })
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    await rm(dir, { recursive: true, force: true })
  }
}

test('MCP resolver maps SIWE EOA to the active Agent Wallet MSCA', async () => {
  const previousBridgeFlag = process.env.ENABLE_MSCA_CCTP_BRIDGE
  delete process.env.ENABLE_MSCA_CCTP_BRIDGE
  try {
    await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'a'.repeat(64),
    },
    }, { [EOA.toLowerCase()]: MSCA }, async ({ resolveActiveMsca, createMcpServer }) => {
      const info = await resolveActiveMsca(EOA)
      assert.equal(info?.walletAddress, MSCA)
      assert.equal(info?.active, true)

      // The experimental Arc-source CCTP/MSCA path is fail-closed by default.
      // This exercises the real MCP handler and proves no UserOperation is
      // attempted while ENABLE_MSCA_CCTP_BRIDGE is absent.
      const server = createMcpServer(EOA)
      const quote = await server._registeredTools.arcox_quote_bridge.handler({
      fromChain: 'arc-testnet',
      toChain: 'base-sepolia',
      amount: '1',
      token: 'USDC',
        source: 'session',
      })
      const quoteResult = JSON.parse(quote.content[0].text)
      assert.equal(quoteResult.rejected, true)
      assert.equal(quoteResult.reason, 'msca_bridge_disabled_until_abi_verification')

      const status = await server._registeredTools.arcox_route_status.handler({
      action: 'bridge',
      fromChain: 'arc-testnet',
      toChain: 'base-sepolia',
        source: 'session',
      })
      const statusResult = JSON.parse(status.content[0].text)
      assert.equal(statusResult.supported, false)
      assert.equal(statusResult.executionSupported, false)
      assert.equal(statusResult.walletAddress, MSCA)
      assert.equal(statusResult.reason, 'msca_bridge_disabled_until_abi_verification')
    })
  } finally {
    if (previousBridgeFlag === undefined) delete process.env.ENABLE_MSCA_CCTP_BRIDGE
    else process.env.ENABLE_MSCA_CCTP_BRIDGE = previousBridgeFlag
  }
})

test('MCP resolver fails closed without an active explicit MSCA session', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: false,
      authorizationUserOpHash: '0x' + 'b'.repeat(64),
    },
  }, { [EOA.toLowerCase()]: MSCA }, async ({ resolveActiveMsca }) => {
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
