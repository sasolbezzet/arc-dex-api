import test from 'node:test'
import assert from 'node:assert/strict'

// The platform fee is charged on top of a service price and is quoted to
// buyers, so the arithmetic has to be exact in USDC base units: a rounding
// error is either an overcharge or a silent loss of margin.
process.env.X402_PLATFORM_FEE_BPS = '500'
process.env.X402_PLATFORM_FEE_FIXED_USDC = '0'
process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'false'

const {
  applyPlatformFee,
  fromUsdcBaseUnits,
  platformFeeBps,
  platformFeeConfigured,
  platformFeeEnabledForServices,
  publicPlatformFee,
  toUsdcBaseUnits,
} = await import('../src/services/platformFee.mjs')

test('default fee is 5% charged on top of the price', () => {
  assert.equal(platformFeeBps(), 500)
  const split = applyPlatformFee('0.05')
  assert.equal(split.netAmount, '0.050000')
  assert.equal(split.feeAmount, '0.002500')
  assert.equal(split.totalAmount, '0.052500')
  assert.equal(split.applied, true)
  assert.equal(split.totalBaseUnits, '52500')
})

test('percentage fee rounds down so a sub-cent price is never inflated past the seller cut', () => {
  const split = applyPlatformFee('0.001')
  assert.equal(split.netAmount, '0.001000')
  assert.equal(split.feeAmount, '0.000050')
  assert.equal(split.totalAmount, '0.001050')
})

test('fixed fee applies even when the percentage is zero', () => {
  const split = applyPlatformFee('0.02', { bps: 0, fixedUsdc: '0.005' })
  assert.equal(split.feeAmount, '0.005000')
  assert.equal(split.totalAmount, '0.025000')
  assert.equal(split.bps, 0)
  assert.equal(platformFeeConfigured({ bps: 0, fixedUsdc: '0.005' }), true)
})

test('an explicit zero keeps the buyer price untouched', () => {
  const split = applyPlatformFee('0.02', { enabled: false, bps: 500 })
  assert.equal(split.applied, false)
  assert.equal(split.feeAmount, '0.000000')
  assert.equal(split.totalAmount, '0.020000')
  assert.equal(split.bps, 0)
})

test('invalid amounts are rejected instead of silently treated as zero', () => {
  assert.throws(() => applyPlatformFee('0'), /Invalid USDC amount/)
  assert.throws(() => applyPlatformFee('-1'), /Invalid USDC amount/)
  assert.throws(() => applyPlatformFee('0.1234567'), /Invalid USDC amount/)
})

test('base unit conversion is a lossless round trip', () => {
  for (const amount of ['0.000001', '0.005', '0.05', '1', '12.345678']) {
    assert.equal(fromUsdcBaseUnits(toUsdcBaseUnits(amount)).replace(/0+$/, '').replace(/\.$/, ''), amount.replace(/0+$/, '').replace(/\.$/, ''))
  }
  assert.equal(toUsdcBaseUnits('1.5'), 1500000n)
})

test('env policy controls bps, fixed fee, and the services switch', () => {
  assert.equal(platformFeeEnabledForServices(), false)
  process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'TRUE'
  assert.equal(platformFeeEnabledForServices(), true)
  process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'false'

  process.env.X402_PLATFORM_FEE_BPS = 'not-a-number'
  assert.equal(platformFeeBps(), 0)
  process.env.X402_PLATFORM_FEE_BPS = '25000'
  assert.equal(platformFeeBps(), 10_000)
  process.env.X402_PLATFORM_FEE_BPS = '500'

  process.env.X402_PLATFORM_FEE_FIXED_USDC = 'nonsense'
  assert.equal(applyPlatformFee('0.01').feeAmount, '0.000500')
})

test('public policy exposes the fee with a worked example and never a key', () => {
  const policy = publicPlatformFee({ bps: 500, exampleAmount: '0.10' })
  assert.equal(policy.asset, 'USDC')
  assert.equal(policy.bps, 500)
  assert.equal(policy.percent, 5)
  assert.equal(policy.chargedOn, 'top-of-price')
  assert.equal(policy.servicesEnabled, false)
  assert.equal(policy.marketplaceEnabled, true)
  assert.equal(policy.example.feeAmount, '0.005000')
  assert.equal(policy.example.totalAmount, '0.105000')
  assert.deepEqual(Object.keys(policy).sort(), [
    'asset', 'bps', 'chargedOn', 'example', 'fixedUsdc', 'marketplaceEnabled', 'minChargeUsdc', 'percent', 'servicesEnabled',
  ])
})
