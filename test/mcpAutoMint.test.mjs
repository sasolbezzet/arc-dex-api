import test from 'node:test'
import assert from 'node:assert/strict'

test('waitForCctpBridgeStatus queues auto-mint once after the configured delay and preserves manual status polling', async () => {
  const { waitForCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?auto-mint-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  let now = 0
  let calls = 0
  let queued = 0
  const sleep = async ms => { now += Number(ms) || 0 }
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ messages: [] }), { status: 200 })
  }
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + 'a'.repeat(64),
      sourceDomain: 26,
      destinationDomain: 3,
    }, {
      attempts: 4,
      delayMs: 10_000,
      autoMintAfterMs: 30_000,
      onPending: async () => { queued++ },
      now: () => now,
      sleep,
    })
    assert.equal(result.status, 'pending')
    assert.equal(result.autoMintQueued, true)
    assert.equal(queued, 1)
    assert.equal(calls, 4)
  } finally {
    globalThis.fetch = previousFetch
  }
})
