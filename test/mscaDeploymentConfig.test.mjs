import test from 'node:test'
import assert from 'node:assert/strict'

const chains = await import('../src/services/chains.mjs?msca-config-' + Date.now())

test('Arbitrum Sepolia uses the canonical Modular Wallet transport slug', () => {
  assert.equal(chains.CHAINS['arbitrum-sepolia'].id, 421614)
  assert.equal(chains.CHAINS['arbitrum-sepolia'].transportSlug, 'arbitrumSepolia')
  assert.ok(chains.MSCA_SUPPORTED_CHAIN_KEYS.includes('arbitrum-sepolia'))
})

test('Ethereum Sepolia is not advertised as an MSCA-supported chain', () => {
  assert.equal(chains.CHAINS['ethereum-sepolia'].id, 11155111)
  assert.ok(!chains.MSCA_SUPPORTED_CHAIN_KEYS.includes('ethereum-sepolia'))
})

test('the supported MSCA set is explicit for paymaster deployment', () => {
  assert.deepEqual(chains.MSCA_SUPPORTED_CHAIN_KEYS, ['arc-testnet', 'base-sepolia', 'arbitrum-sepolia'])
  assert.ok(!chains.MSCA_SUPPORTED_CHAIN_KEYS.includes('ethereum-sepolia'))
})

test('Arbitrum and Ethereum use distinct documented support outcomes', () => {
  assert.equal(chains.CHAINS['arbitrum-sepolia'].transportSlug, 'arbitrumSepolia')
  assert.equal(chains.CHAINS['ethereum-sepolia'].transportSlug, 'ethSepolia')
  assert.ok(chains.MSCA_SUPPORTED_CHAIN_KEYS.includes('arbitrum-sepolia'))
  assert.ok(!chains.MSCA_SUPPORTED_CHAIN_KEYS.includes('ethereum-sepolia'))
})

test('Arbitrum destination verification has enough gas for MSCA validation', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/services/sessionKeyService.mjs', import.meta.url), 'utf8'))
  assert.match(source, /'arbitrum-sepolia': 300_000n/)
})

test('Arbitrum fee precheck requires a non-zero priority fee floor', async () => {
  const { normalizeUserOperationFees } = await import('../src/services/sessionKeyService.mjs?arb-fees-' + Date.now())
  const fees = normalizeUserOperationFees({ maxPriorityFeePerGas: 0n, maxFeePerGas: 0n })
  assert.equal(fees.maxPriorityFeePerGas, 1_000_000_000n)
  assert.equal(fees.maxFeePerGas, 2_000_000_000n)
})

test('Arbitrum fee envelope adds headroom above a live max fee', async () => {
  const { normalizeUserOperationFees } = await import('../src/services/sessionKeyService.mjs?arb-fee-headroom-' + Date.now())
  const fees = normalizeUserOperationFees({ maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n })
  assert.equal(fees.maxPriorityFeePerGas, 1_000_000_000n)
  assert.equal(fees.maxFeePerGas, 3_000_000_000n)
})
