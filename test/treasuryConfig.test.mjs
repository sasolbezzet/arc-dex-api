import test from 'node:test'
import assert from 'node:assert/strict'
import { requireTreasuryAddress, treasuryAddress, treasuryConfigurationIssues } from '../src/config/treasury.mjs'

const NAMES = [
  'ARCOX_TREASURY_WALLET_ADDRESS',
  'ARCOX_FEE_TREASURY',
  'ARCOX_TREASURY_WALLET',
  'AI_ROUTER_TREASURY_ADDRESS',
  'X402_RECIPIENT_ADDRESS',
  'CIRCLE_X402_TREASURY_ADDRESS',
]

function withTreasuryEnv(values, fn) {
  const previous = Object.fromEntries(NAMES.map(name => [name, process.env[name]]))
  for (const name of NAMES) delete process.env[name]
  Object.assign(process.env, values)
  try { return fn() } finally {
    for (const name of NAMES) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

test('canonical treasury overrides legacy flow-specific recipients', () => {
  const canonical = `0x${'11'.repeat(20)}`
  const legacy = `0x${'22'.repeat(20)}`
  withTreasuryEnv({ ARCOX_TREASURY_WALLET_ADDRESS: canonical, X402_RECIPIENT_ADDRESS: legacy }, () => {
    assert.equal(treasuryAddress(), canonical)
    assert.equal(requireTreasuryAddress(), canonical)
    assert.match(treasuryConfigurationIssues().join(' '), /X402_RECIPIENT_ADDRESS differs/)
  })
})

test('invalid canonical treasury fails closed', () => {
  withTreasuryEnv({ ARCOX_TREASURY_WALLET_ADDRESS: 'invalid', X402_RECIPIENT_ADDRESS: `0x${'33'.repeat(20)}` }, () => {
    assert.throws(() => treasuryAddress(), /must be a valid EVM address/)
  })
})

test('missing treasury fails financial operations', () => {
  withTreasuryEnv({}, () => assert.throws(() => requireTreasuryAddress(), /is not configured/))
})
