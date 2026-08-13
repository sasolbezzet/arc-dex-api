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

test('hashless destination recovery requires a cooldown and updated approval timestamp', async () => {
  const { HASHLESS_DESTINATION_RECOVERY_DELAY_MS, hashlessDestinationRetryAllowed } = await import('../src/services/mcpServer.mjs?hashless-recovery-' + Date.now() + '-' + Math.random())
  const now = 1_000_000
  assert.equal(hashlessDestinationRetryAllowed({ updatedAt: now - HASHLESS_DESTINATION_RECOVERY_DELAY_MS + 1 }, now), false)
  assert.equal(hashlessDestinationRetryAllowed({ updatedAt: now - HASHLESS_DESTINATION_RECOVERY_DELAY_MS }, now), true)
  assert.equal(hashlessDestinationRetryAllowed({ createdAt: now - HASHLESS_DESTINATION_RECOVERY_DELAY_MS }, now), true)
  assert.equal(hashlessDestinationRetryAllowed({ updatedAt: 0, createdAt: 0 }, now), false)
})

test('receipt errors retain the accepted UserOperation hash for destination recovery', async () => {
  const { annotateUserOperationError } = await import('../src/services/sessionKeyService.mjs?receipt-hash-' + Date.now() + '-' + Math.random())
  const original = new Error('Circle receipt indexer unavailable')
  const annotated = annotateUserOperationError(original, '0x' + 'a'.repeat(64), 'https://example.invalid/tx/0x' + 'a'.repeat(64))
  assert.equal(annotated, original)
  assert.equal(annotated.userOpHash, '0x' + 'a'.repeat(64))
  assert.match(annotated.explorerUrl, /0x[a]+$/)
  assert.equal(annotated.code, 'user_operation_receipt_unavailable')
})
