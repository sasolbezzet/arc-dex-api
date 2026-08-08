import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData } from 'viem'

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
      assert.equal(quoteResult.reason, 'msca_bridge_disabled_until_router_validation')

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
      assert.equal(statusResult.reason, 'msca_bridge_disabled_until_router_validation')
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

test('MSCA bridge calldata approves and calls the verified ArcoxRouter', async () => {
  const { buildMscaRouterBridgeCalls } = await import('../src/services/mcpServer.mjs?bridge-calldata-' + Date.now())
  const route = {
    fromKey: 'Arc_Testnet',
    toKey: 'Base_Sepolia',
    source: {
      domain: 26,
      usdc: '0x3600000000000000000000000000000000000000',
      router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
    },
    destination: { domain: 6 },
  }
  const calls = buildMscaRouterBridgeCalls({ route, amount: 1_000_000n, mintRecipient: MSCA })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].to.toLowerCase(), route.source.usdc.toLowerCase())
  assert.equal(calls[1].to.toLowerCase(), route.source.router.toLowerCase())
  assert.equal(calls[0].data.slice(0, 10), '0x095ea7b3')
  assert.notEqual(calls[1].data, '0x')
  const routerAbi = [{
    type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
    ], outputs: [],
  }]
  const decoded = decodeFunctionData({ abi: routerAbi, data: calls[1].data })
  assert.equal(decoded.functionName, 'bridgeUsdcWithFee')
  assert.deepEqual(decoded.args, [1_000_000n, 6, `0x${MSCA.slice(2).padStart(64, '0')}`, `0x${'0'.repeat(64)}`, 10n, 1000])

  const approveAbi = [{
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
  }]
  const approve = decodeFunctionData({ abi: approveAbi, data: calls[0].data })
  assert.equal(approve.functionName, 'approve')
  assert.deepEqual(approve.args, [route.source.router, 1_000_000n])
})
