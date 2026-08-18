import test from 'node:test'
import assert from 'node:assert/strict'

test('CCTP maxFee uses the live minimumFee rate plus a 20% safety buffer', async () => {
  const { calculateCctpMaxFee } = await import('../src/services/mcpServer.mjs?cctp-fee-calc-' + Date.now())
  const fee = calculateCctpMaxFee({ amount: 100_000n, minimumFee: '1.3' })
  assert.equal(fee.protocolFee, 13n)
  assert.equal(fee.maxFee, 16n)
  assert.equal(fee.bufferBps, 2000)
})

test('CCTP fee quote calls Circle Iris for the exact source/destination domains', async () => {
  const { getCctpFeeQuote } = await import('../src/services/mcpServer.mjs?cctp-fee-api-' + Date.now())
  const route = {
    source: { domain: 6 },
    destination: { domain: 26, requiredFinalityThreshold: 1000 },
  }
  let requestedUrl = ''
  const result = await getCctpFeeQuote(route, 100_000n, async url => {
    requestedUrl = url
    return new Response(JSON.stringify([
      { finalityThreshold: 2000, minimumFee: 0 },
      { finalityThreshold: 1000, minimumFee: 1.3 },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  assert.equal(requestedUrl, 'https://iris-api-sandbox.circle.com/v2/burn/USDC/fees/6/26')
  assert.equal(result.minimumFee, '1.3')
  assert.equal(result.protocolFee, 13n)
  assert.equal(result.maxFee, 16n)
  assert.equal(result.finalityThreshold, 1000)
})

test('CCTP fee quote fails closed when Circle has no matching fee row', async () => {
  const { getCctpFeeQuote } = await import('../src/services/mcpServer.mjs?cctp-fee-missing-' + Date.now())
  await assert.rejects(
    getCctpFeeQuote({ source: { domain: 6 }, destination: { domain: 26, requiredFinalityThreshold: 1000 } }, 100_000n, async () => new Response(JSON.stringify([{ finalityThreshold: 2000, minimumFee: 0 }]), { status: 200 })),
    /fee unavailable for finality threshold 1000/,
  )
})

test('auto-mint timeout is retryable and preserves the original burn hash', async () => {
  const { AUTO_MINT_MAX_ATTEMPTS, markAutoMintRetryable, autoMintRetryDue } = await import('../src/services/autoMintState.mjs?auto-mint-retry-' + Date.now())
  const now = 1_000_000
  const burnTx = '0x' + 'a'.repeat(64)
  const next = markAutoMintRetryable({ burnTx, status: 'polling', attempts: AUTO_MINT_MAX_ATTEMPTS }, now)
  assert.equal(next.status, 'retryable')
  assert.equal(next.retryable, true)
  assert.equal(next.burnTx, burnTx)
  assert.equal(next.nextRetryAt, now + 60_000)
  assert.equal(autoMintRetryDue(next, now), false)
  assert.equal(autoMintRetryDue(next, now + 60_000), true)
})
