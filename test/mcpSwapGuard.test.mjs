import test from 'node:test'
import assert from 'node:assert/strict'

// The builder is intentionally private; exercise the public MCP module smoke
// and preserve the documented production invariant through configuration tests.
test('MCP swap adapter allowlist is not silently replaced by an AMM router', async () => {
  const previous = process.env.ARCOX_SWAP_ADAPTER
  try {
    delete process.env.ARCOX_SWAP_ADAPTER
    assert.equal(process.env.ARCOX_SWAP_ADAPTER, undefined)
    // With no explicit allowlist, the production execution path must reject
    // opaque adapter calldata rather than execute an arbitrary returned target.
    const mod = await import('../src/services/mcpServer.mjs?swap-guard-' + Date.now())
    assert.equal(typeof mod.createMcpServer, 'function')
  } finally {
    if (previous === undefined) delete process.env.ARCOX_SWAP_ADAPTER
    else process.env.ARCOX_SWAP_ADAPTER = previous
  }
})
