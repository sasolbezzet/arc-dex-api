import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'bridge-history-'))
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
process.env.VAULT_ACTIVITY_PATH = join(tempDir, 'activity.json')
writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
// Mainnet records must resolve to the mainnet explorer URLs; the network is read
// at import time, so it has to be set before the service is loaded.
process.env.ARC_NETWORK = 'mainnet'

const {
  bridgeRecordsFromApprovals,
  bridgeHistoryStatus,
  frontendChainLabel,
  mergeBridgeRecordsIntoHistory,
  normalizeBridgeApproval,
  summarizeBridgeHistory,
} = await import('../src/services/bridgeHistory.mjs?bridge-history-' + Date.now() + '-' + Math.random())

const MSCA = '0x08223b59f3Dc0135500Fbc62d5537A5c501cf017'
const OWNER = '0xe43007a7f4a01f020f9ee11cabcd880f0ea25aa9'

// Real shape of the mainnet Arc → Arbitrum test bridge (verified on-chain).
const arcToArbitrum = {
  id: '235b91ca-6c61-4dcf-8a0d-b430fb8d7f6c',
  owner: OWNER,
  agent: 'mcp-agent',
  action: 'bridge',
  amount: '0.02',
  token: 'USDC',
  source: 'session',
  to: '',
  status: 'success',
  createdAt: 1790556200000,
  details: JSON.stringify({
    fromChain: 'Arc',
    toChain: 'Arbitrum',
    amount: '0.02',
    burnTxHash: '0xf7a06474d1bee4aad04d7df16a5a707e031de45367e88780d95a4850269a3a09',
    sourceChainKey: 'arc-mainnet',
    destinationChainKey: 'arbitrum-mainnet',
    walletAddress: MSCA,
    settlementStatus: 'success',
    settlementPhase: 'destination_minted',
    safeToRetry: false,
  }),
}

test('frontendChainLabel maps mainnet and testnet chain identifiers to UI labels', () => {
  assert.equal(frontendChainLabel('Arc'), 'Arc')
  assert.equal(frontendChainLabel('Arc_Testnet'), 'Arc')
  assert.equal(frontendChainLabel('Base_Sepolia'), 'Base')
  assert.equal(frontendChainLabel('base-mainnet'), 'Base')
  assert.equal(frontendChainLabel('arbitrum-sepolia'), 'Arbitrum')
  assert.equal(frontendChainLabel('Ethereum'), 'Ethereum')
  assert.equal(frontendChainLabel(''), '')
})

test('normalizeBridgeApproval produces a TxRecord row with explorer links', () => {
  const record = normalizeBridgeApproval(arcToArbitrum)
  assert.equal(record.id, `bridge-${arcToArbitrum.id}`)
  assert.equal(record.action, 'bridge')
  assert.equal(record.source, 'agent-mcp')
  assert.equal(record.walletSource, 'circle')
  assert.equal(record.from, 'Arc')
  assert.equal(record.to, 'Arbitrum')
  assert.equal(record.amount, '0.02')
  assert.equal(record.status, 'success')
  assert.match(record.burnExplorerUrl, /^https:\/\/explorer\.arc\.io\/tx\/0xf7a06474/)
  assert.equal(record.mintTx, '')
  assert.equal(record.pendingMint, false)
  assert.equal(record.ownerAddress, OWNER)
  assert.equal(record.owner, undefined, 'field owner sengaja tidak dipakai agar browser history merge tidak menjatuhkan baris')
  assert.equal(record.walletAddress, MSCA)
})

test('non-bridge approvals and wallet-less intents are ignored or filtered', () => {
  assert.equal(normalizeBridgeApproval({ action: 'swap', amount: '1' }), null)
  assert.equal(normalizeBridgeApproval({ action: 'bridge', details: '{}' }), null)
  const withoutWallet = { ...arcToArbitrum, id: 'no-wallet', details: JSON.stringify({ fromChain: 'Arc', toChain: 'Base' }) }
  assert.equal(bridgeRecordsFromApprovals([withoutWallet], {}).length, 1, 'tanpa filter wallet tetap tampil')
  assert.equal(bridgeRecordsFromApprovals([withoutWallet], { walletAddress: MSCA }).length, 0, 'filter wallet tidak boleh menebak baris tanpa wallet')
  assert.equal(bridgeRecordsFromApprovals([arcToArbitrum], { walletAddress: MSCA.toUpperCase() }).length, 1)
})

test('a burned bridge with unknown destination settlement stays pending, not failed', () => {
  assert.equal(bridgeHistoryStatus('error', 'pending'), 'pending')
  assert.equal(bridgeHistoryStatus('success', 'pending'), 'pending')
  assert.equal(bridgeHistoryStatus('success', 'success'), 'success')
  assert.equal(bridgeHistoryStatus('error', 'error'), 'error')
  assert.equal(bridgeHistoryStatus('rejected', ''), 'error')

  const pendingBurn = {
    ...arcToArbitrum,
    id: 'pending-burn',
    status: 'error',
    error: 'destination nonce unavailable',
    details: JSON.stringify({
      fromChain: 'Arbitrum',
      toChain: 'Arc',
      burnTxHash: '0x4fe9d53b11d5c05ccd62337ff231133f17cc0c35330fa019c8ae47a861823b35',
      sourceChainKey: 'arbitrum-mainnet',
      destinationChainKey: 'arc-mainnet',
      walletAddress: MSCA,
      settlementStatus: 'pending',
      settlementPhase: 'submission_unknown',
      safeToRetry: false,
    }),
  }
  const record = normalizeBridgeApproval(pendingBurn)
  assert.equal(record.status, 'pending')
  assert.equal(record.pendingMint, true)
  assert.equal(record.safeToRetry, false)
  assert.match(record.note, /auto-mint/)
  assert.match(record.burnExplorerUrl, /^https:\/\/arbiscan\.io\/tx\/0x4fe9d53b/)
})

test('approvals that reference the same burn collapse into one row', () => {
  const healedIntent = {
    ...arcToArbitrum,
    id: 'healed-intent',
    amount: '0.01',
    agent: 'Grok',
    createdAt: 1790751613354,
    error: 'Verification gas limit efficiency too low',
  }
  const executedIntent = { ...arcToArbitrum, id: 'executed-intent', amount: '0.0095', createdAt: 1790781536373 }
  const rows = bridgeRecordsFromApprovals([healedIntent, executedIntent], { walletAddress: MSCA })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amount, '0.0095', 'baris terbaru yang mengeksekusi burn dipakai')
  assert.equal(rows[0].id, 'bridge-executed-intent')

  const withMintPreference = bridgeRecordsFromApprovals([
    executedIntent,
    { ...healedIntent, id: 'with-mint', details: JSON.stringify({ ...JSON.parse(healedIntent.details), mintTxHash: '0x' + 'c'.repeat(64) }) },
  ], { walletAddress: MSCA })
  assert.equal(withMintPreference[0].id, 'bridge-with-mint', 'baris dengan bukti mint menang')
})

test('mergeBridgeRecordsIntoHistory dedupes by id and keeps fresher mint hashes', () => {
  const record = normalizeBridgeApproval({
    ...arcToArbitrum,
    id: 'merged-bridge',
    details: JSON.stringify({
      fromChain: 'Arc',
      toChain: 'Base',
      burnTxHash: '0x' + 'a'.repeat(64),
      walletAddress: MSCA,
      settlementStatus: 'success',
      settlementPhase: 'destination_minted',
      mintTxHash: '0x' + 'b'.repeat(64),
    }),
  })
  const localRow = { id: record.id, ts: record.ts, action: 'bridge', from: 'Arc', to: 'Base', amount: '0.02', status: 'pending', note: 'local note', mintTx: '' }
  const merged = mergeBridgeRecordsIntoHistory([localRow], [record], 10)
  assert.equal(merged.length, 1, 'baris yang sama tidak boleh dobel')
  assert.equal(merged[0].status, 'success')
  assert.equal(merged[0].mintTx, '0x' + 'b'.repeat(64))
  assert.equal(merged[0].note, record.note, 'catatan server yang lebih baru menggantikan catatan lokal')
  assert.equal(merged[0].localOnly, undefined)

  const withLocalError = mergeBridgeRecordsIntoHistory([{ ...localRow, error: 'local hiccup' }], [record], 10)
  assert.equal(withLocalError[0].error, 'local hiccup', 'field yang kosong di record server tetap memakai nilai lokal')

  const withExtra = mergeBridgeRecordsIntoHistory([localRow], [record, localRow], 10)
  assert.equal(withExtra.length, 1)
})

test('summarizeBridgeHistory counts status and nets per-chain amounts exactly', () => {
  const outRecord = normalizeBridgeApproval(arcToArbitrum)
  const backRecord = normalizeBridgeApproval({
    ...arcToArbitrum,
    id: 'back',
    amount: '0.015',
    details: JSON.stringify({
      fromChain: 'Arbitrum',
      toChain: 'Arc',
      amount: '0.015',
      walletAddress: MSCA,
      settlementStatus: 'success',
    }),
  })
  const summary = summarizeBridgeHistory([outRecord, backRecord])
  assert.equal(summary.total, 2)
  assert.equal(summary.success, 2)
  assert.equal(summary.pending, 0)
  assert.equal(summary.chains.Arbitrum.in.USDC, '0.02')
  assert.equal(summary.chains.Arbitrum.out.USDC, '0.015')
  assert.equal(summary.chains.Arc.out.USDC, '0.02')
  assert.equal(summary.chains.Arc.in.USDC, '0.015')
})
