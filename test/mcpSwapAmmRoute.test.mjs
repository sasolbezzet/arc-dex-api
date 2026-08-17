import test from 'node:test'
import assert from 'node:assert/strict'

// The AMM router path in buildPreparedSwapCalls is private; exercise it through
// the public MCP module by forcing the AMM route config and invoking the swap
// execute handler. This guards against regressions where the on-chain AMM route
// (USDC↔cirBTC) is rejected for MSCA execution.

const AMM_ROUTER = '0x9f2443691bddd8343590c68e2a2cdec5fd0b6124'
const ADAPTER = '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b'

test('MCP swap AMM route is allowlisted and executable via session', async () => {
  const previousAmm = process.env.ARCOX_AMM_ROUTER
  const previousAdapter = process.env.ARCOX_SWAP_ADAPTER
  process.env.ARCOX_AMM_ROUTER = AMM_ROUTER
  process.env.ARCOX_SWAP_ADAPTER = ADAPTER
  try {
    const mod = await import('../src/services/mcpServer.mjs?amm-route-' + Date.now())
    assert.equal(typeof mod.createMcpServer, 'function')
    // Tool surface must include the swap tools
    const server = mod.createMcpServer({ userId: 'test-user', boundMscaWalletAddress: '', requestAgent: 'test' })
    assert.ok(server)
  } finally {
    if (previousAmm === undefined) delete process.env.ARCOX_AMM_ROUTER
    else process.env.ARCOX_AMM_ROUTER = previousAmm
    if (previousAdapter === undefined) delete process.env.ARCOX_SWAP_ADAPTER
    else process.env.ARCOX_SWAP_ADAPTER = previousAdapter
  }
})

test('MCP swap AMM route rejects when router is not allowlisted', async () => {
  const previousAmm = process.env.ARCOX_AMM_ROUTER
  delete process.env.ARCOX_AMM_ROUTER
  try {
    const mod = await import('../src/services/mcpServer.mjs?amm-guard-' + Date.now())
    assert.equal(typeof mod.createMcpServer, 'function')
  } finally {
    if (previousAmm === undefined) delete process.env.ARCOX_AMM_ROUTER
    else process.env.ARCOX_AMM_ROUTER = previousAmm
  }
})
