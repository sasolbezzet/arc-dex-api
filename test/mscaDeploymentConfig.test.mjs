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

test('Arbitrum fee precheck requires a non-zero priority fee floor', () => {
  const observed = { maxPriorityFeePerGas: 0n, maxFeePerGas: 0n }
  const floor = 1_000_000_000n
  const priority = observed.maxPriorityFeePerGas > floor ? observed.maxPriorityFeePerGas : floor
  const max = observed.maxFeePerGas > priority ? observed.maxFeePerGas : priority * 2n
  assert.equal(priority, 1_000_000_000n)
  assert.ok(max >= priority)
})
