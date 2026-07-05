import test from 'node:test'
import assert from 'node:assert/strict'
import { delegatedDestination } from '../src/services/aiRouterSpendService.mjs'

test('delegated EVM settlement uses the local adapter instead of the paid Forwarder', () => {
  const adapter = { kind: 'test-adapter' }
  const recipient = `0x${'12'.repeat(20)}`
  const destination = delegatedDestination('Arc_Testnet', recipient, adapter)
  assert.deepEqual(destination, {
    adapter,
    chain: 'Arc_Testnet',
    recipientAddress: recipient,
  })
  assert.equal('useForwarder' in destination, false)
})
