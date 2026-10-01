import test from 'node:test'
import assert from 'node:assert/strict'

const BURN = '0x' + 'a'.repeat(64)

test('bridge intent matching reconciles mainnet chain spellings by burn hash', async () => {
  const { bridgeIntentMatchesBurn } = await import('../src/services/mcpServer.mjs?intent-match-' + Date.now() + '-' + Math.random())
  // The registry keys the destination as `Base`, while the persisted bridge
  // record stores `base-mainnet`. Both must match the same burn hash, otherwise
  // a retry cannot find the original intent and creates a duplicate audit row.
  const persisted = { fromChain: 'Arc', toChain: 'Base', burnTxHash: BURN, destinationChainKey: 'base-mainnet' }
  assert.equal(bridgeIntentMatchesBurn(persisted, { burnTxHash: BURN, toKey: 'Base' }), true)
  assert.equal(bridgeIntentMatchesBurn(persisted, { burnTxHash: BURN, toKey: 'base-mainnet' }), true)
  assert.equal(bridgeIntentMatchesBurn(persisted, { burnTxHash: BURN, toKey: 'Arbitrum' }), false)
  assert.equal(bridgeIntentMatchesBurn(persisted, { burnTxHash: '0x' + 'b'.repeat(64), toKey: 'Base' }), false)
  assert.equal(bridgeIntentMatchesBurn(null, { burnTxHash: BURN, toKey: 'Base' }), false)
  assert.equal(bridgeIntentMatchesBurn(persisted, {}), false)

  const arbitrum = { burnTxHash: BURN, toChain: 'Arbitrum', destinationChainKey: 'arbitrum-mainnet' }
  assert.equal(bridgeIntentMatchesBurn(arbitrum, { burnTxHash: BURN, toKey: 'Arbitrum' }), true)

  const testnet = { burnTxHash: BURN, toChain: 'Base_Sepolia', destinationChainKey: 'base-sepolia' }
  assert.equal(bridgeIntentMatchesBurn(testnet, { burnTxHash: BURN, toKey: 'Base_Sepolia' }), true)
})

test('every audit row for a burn is healed and carries the mint evidence', async () => {
  const { bridgeIntentRows, bridgeIntentMintEvidence } = await import('../src/services/mcpServer.mjs?intent-rows-' + Date.now() + '-' + Math.random())
  const stale = { details: { settlementPhase: 'destination_submission_failed' }, approval: { id: 'stale', txHash: BURN } }
  const minted = {
    details: { settlementPhase: 'destination_minted', destinationUserOpHash: '0x' + 'c'.repeat(64), mintTxHash: '0x' + 'd'.repeat(64) },
    approval: { id: 'minted', explorerUrl: 'https://basescan.org/tx/0x' + 'd'.repeat(64) },
  }
  const intent = { ...stale, all: [stale, minted] }
  assert.deepEqual(bridgeIntentRows(intent).map(row => row.approval.id), ['stale', 'minted'])
  assert.equal(bridgeIntentRows(stale).length, 1)
  assert.deepEqual(bridgeIntentRows(null), [])
  assert.deepEqual(bridgeIntentMintEvidence(intent), {
    txHash: '0x' + 'd'.repeat(64),
    userOpHash: '0x' + 'c'.repeat(64),
    explorerUrl: 'https://basescan.org/tx/0x' + 'd'.repeat(64),
  })
  assert.deepEqual(bridgeIntentMintEvidence(stale), { txHash: null, userOpHash: null, explorerUrl: null })
})
