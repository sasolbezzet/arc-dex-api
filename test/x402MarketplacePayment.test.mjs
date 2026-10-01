import test from 'node:test'
import assert from 'node:assert/strict'

// Outbound settlement for mirrored marketplace resources. The values being
// passed here come from provider metadata, so the guards (URL shape, method
// whitelist, header charset, price cap) are security controls, not formatting.
process.env.X402_MARKETPLACE_EXECUTOR = 'cli'
process.env.X402_MARKETPLACE_PAYER_ADDRESS = '0x08223b59f3Dc0135500Fbc62d5537A5c501cf017'
process.env.X402_MARKETPLACE_MAX_UPSTREAM_USDC = '5'
process.env.X402_MARKETPLACE_PAYER_CHAIN = 'ARC'

const {
  marketplaceExecutorStatus, validateMarketplaceRequest, buildMarketplacePayArgs, payMarketplaceEndpoint,
} = await import('../src/services/x402MarketplacePayment.mjs')

function fakeRunner(result) {
  const calls = []
  const runner = (bin, args, options, callback) => {
    calls.push({ bin, args, options })
    callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
  }
  return { runner, calls }
}

test('the executor reports itself as misconfigured rather than silently failing later', () => {
  const status = marketplaceExecutorStatus()
  assert.equal(status.mode, 'cli')
  assert.equal(status.configured, true)
  assert.equal(status.payerAddress, process.env.X402_MARKETPLACE_PAYER_ADDRESS)
  assert.deepEqual(status.problems, [])

  process.env.X402_MARKETPLACE_EXECUTOR = 'disabled'
  const disabled = marketplaceExecutorStatus()
  assert.equal(disabled.configured, false)
  assert.deepEqual(disabled.problems, ['executor_disabled'])
  assert.match(disabled.hint, /X402_MARKETPLACE_EXECUTOR=cli/)

  process.env.X402_MARKETPLACE_EXECUTOR = 'cli'
  process.env.X402_MARKETPLACE_PAYER_ADDRESS = 'not-an-address'
  assert.deepEqual(marketplaceExecutorStatus().problems, ['payer_address_missing'])
  process.env.X402_MARKETPLACE_PAYER_ADDRESS = '0x08223b59f3Dc0135500Fbc62d5537A5c501cf017'
})

test('provider-supplied request values cannot escape their argument', () => {
  assert.equal(validateMarketplaceRequest({ resource: 'https://api.example.com/x' }).ok, true)
  assert.match(validateMarketplaceRequest({ resource: 'file:///etc/passwd' }).error, /http or https/)
  assert.match(validateMarketplaceRequest({ resource: 'not a url' }).error, /absolute http\(s\) URL/)
  assert.match(validateMarketplaceRequest({ resource: 'https://api.example.com/x;rm -rf /' }).error, /unsupported characters/)
  assert.match(validateMarketplaceRequest({ resource: 'https://api.example.com/x', method: 'TRACE' }).error, /unsupported method/)
  assert.match(validateMarketplaceRequest({ resource: 'https://api.example.com/x', headers: { 'x bad': 'v' } }).error, /invalid header name/)
  assert.match(validateMarketplaceRequest({ resource: 'https://api.example.com/x', headers: { 'x-key': 'v;drop table' } }).error, /invalid header value/)
  assert.match(validateMarketplaceRequest({ resource: 'https://api.example.com/x', headers: { 'x-key': 'ünïcode' } }).error, /invalid header value/)
  const ok = validateMarketplaceRequest({ resource: 'https://api.example.com/x', method: 'post', headers: { 'X-Arcox-Key': 'abc-123' } })
  assert.equal(ok.ok, true)
  assert.equal(ok.method, 'POST')
})

test('the CLI invocation pins method, payer, chain, price cap, body, and headers', () => {
  const args = buildMarketplacePayArgs({
    config: { payerAddress: '0xPayer', defaultChain: 'ARC', timeoutMs: 60_000 },
    resource: 'https://api.example.com/analyze',
    method: 'POST',
    data: { text: 'hello' },
    headers: { 'X-Arcox-Key': 'abc-123' },
    chain: 'BASE',
    maxAmountUsdc: '0.2',
  })
  assert.deepEqual(args.slice(0, 3), ['services', 'pay', 'https://api.example.com/analyze'])
  assert.equal(args[args.indexOf('-X') + 1], 'POST')
  assert.equal(args[args.indexOf('--address') + 1], '0xPayer')
  assert.equal(args[args.indexOf('--chain') + 1], 'BASE')
  assert.equal(args[args.indexOf('--max-amount') + 1], '0.2')
  assert.equal(args[args.indexOf('--data') + 1], '{"text":"hello"}')
  assert.equal(args[args.indexOf('-H') + 1], 'X-Arcox-Key: abc-123')
  // The upstream price cap is what the buyer agreed to quote, never the fee.
  assert.ok(!args.some(arg => String(arg).includes('platform')))
})

test('a successful provider call returns the payload and an auditable command', async () => {
  const { runner, calls } = fakeRunner({ stdout: JSON.stringify({ data: { odds: 0.62 } }) })
  const result = await payMarketplaceEndpoint({
    resource: 'https://api.example.com/quote', method: 'GET', chain: 'ARC', maxAmountUsdc: 0.1, spawnImpl: runner,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.providerPayload, { odds: 0.62 })
  assert.equal(result.chain, 'ARC')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].bin, 'circle')
  assert.ok(result.command.includes('0x08223b59f3Dc0135500Fbc62d5537A5c501cf017'))
})

test('a CLI error envelope is reported as a failed delivery, not a success', async () => {
  const { runner } = fakeRunner({ stdout: JSON.stringify({ error: { code: 'INSUFFICIENT_BALANCE', message: 'payer has no USDC on ARC' } }) })
  const result = await payMarketplaceEndpoint({ resource: 'https://api.example.com/quote', chain: 'ARC', maxAmountUsdc: 0.1, spawnImpl: runner })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'upstream_payment_failed')
  assert.match(result.error, /payer has no USDC on ARC/)
  assert.equal(result.providerPayload, null)
})

test('a timeout is distinguishable so the invoice can be marked for refund review', async () => {
  const { runner } = fakeRunner({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })
  const result = await payMarketplaceEndpoint({ resource: 'https://api.example.com/quote', chain: 'ARC', maxAmountUsdc: 0.1, spawnImpl: runner })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'upstream_timeout')
  assert.equal(result.exitCode, 'ETIMEDOUT')
})

test('the per-call price cap blocks an over-priced resource before any payment', async () => {
  const { runner, calls } = fakeRunner({ stdout: '{}' })
  const result = await payMarketplaceEndpoint({ resource: 'https://api.example.com/quote', chain: 'ARC', maxAmountUsdc: 200, spawnImpl: runner })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'upstream_price_above_cap')
  assert.equal(calls.length, 0)
})

test('an unconfigured executor never reaches the CLI', async () => {
  process.env.X402_MARKETPLACE_EXECUTOR = 'disabled'
  const { runner, calls } = fakeRunner({ stdout: '{}' })
  const result = await payMarketplaceEndpoint({ resource: 'https://api.example.com/quote', chain: 'ARC', maxAmountUsdc: 0.1, spawnImpl: runner })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'executor_not_configured')
  assert.equal(calls.length, 0)
  process.env.X402_MARKETPLACE_EXECUTOR = 'cli'
})
