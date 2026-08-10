import assert from 'node:assert/strict'
import test from 'node:test'

const TX = '0x' + 'a'.repeat(64)
const USER_OP = '0x' + 'b'.repeat(64)
const MSCA = '0x1111111111111111111111111111111111111111'

const walletEventPrefixes = ['transactions.', 'challenges.', 'contracts.', 'modularWallet.', 'travelRule.', 'rampSession.']
function isSupportedWalletEvent(eventType) {
  return eventType === 'webhooks.test' || walletEventPrefixes.some(prefix => eventType.startsWith(prefix))
}

test('Wallets webhook policy accepts Wallets notification families only', () => {
  assert.equal(isSupportedWalletEvent('transactions.inbound'), true)
  assert.equal(isSupportedWalletEvent('modularWallet.userOperation'), true)
  assert.equal(isSupportedWalletEvent('gateway.mint.finalized'), false)
  assert.equal(isSupportedWalletEvent('unknown.event'), false)
})

test('Circle Wallet webhook extracts transaction and UserOperation references', async () => {
  const { extractCircleWalletTransaction } = await import('../src/services/circleWalletWebhookService.mjs?extract=' + Date.now())
  const extracted = extractCircleWalletTransaction({
    notificationId: 'notification-1',
    notificationType: 'transactions.outbound',
    notification: {
      status: 'COMPLETE',
      transactionHash: TX,
      userOperation: { userOperationHash: USER_OP },
      walletAddress: MSCA,
    },
  })
  assert.equal(extracted.notificationId, 'notification-1')
  assert.equal(extracted.eventType, 'transactions.outbound')
  assert.equal(extracted.status, 'complete')
  assert.equal(extracted.txHash, TX)
  assert.equal(extracted.userOpHash, USER_OP)
  assert.equal(extracted.walletAddress, MSCA)
})

test('Circle Wallet final status classification is conservative and explicit', async () => {
  const { isFinalCircleWalletStatus, isSuccessfulCircleWalletStatus, isFailedCircleWalletStatus } = await import('../src/services/circleWalletWebhookService.mjs?status=' + Date.now())
  assert.equal(isFinalCircleWalletStatus('COMPLETE'), true)
  assert.equal(isSuccessfulCircleWalletStatus('CONFIRMED'), true)
  assert.equal(isFailedCircleWalletStatus('REVERTED'), true)
  assert.equal(isFinalCircleWalletStatus('PENDING'), false)
})

test('Circle Wallet webhook reconciliation requires an exact hash and is idempotent', async () => {
  const dir = await import('node:fs/promises').then(x => x.mkdtemp('/tmp/arcox-webhook-test-'))
  const previousVault = process.env.VAULT_PATH
  const previousActivity = process.env.VAULT_ACTIVITY_PATH
  process.env.VAULT_PATH = `${dir}/vault.json`
  process.env.VAULT_ACTIVITY_PATH = `${dir}/activity.json`
  try {
    const vault = await import('../src/services/vaultStore.mjs?reconcile=' + Date.now())
    const approval = vault.createApproval(MSCA, {
      agent: 'claude-mcp',
      action: 'bridge',
      amount: '0.1',
      token: 'USDC',
      source: 'session',
      details: JSON.stringify({ action: 'bridge', walletAddress: MSCA, sourceUserOpHash: USER_OP, fromChain: 'Arc_Testnet', toChain: 'Base_Sepolia' }),
      forcePending: true,
    })
    const walletOnly = vault.reconcileCircleWalletWebhook({ walletAddress: MSCA, status: 'COMPLETE', eventId: 'wallet-only' })
    assert.equal(walletOnly.matched, 0)
    assert.equal(walletOnly.reason, 'webhook_reference_missing')
    const first = vault.reconcileCircleWalletWebhook({
      walletAddress: MSCA,
      userOpHash: USER_OP,
      txHash: TX,
      status: 'COMPLETE',
      eventId: 'notification-1',
      eventType: 'transactions.outbound',
    })
    assert.equal(first.matched, 1)
    const updated = vault.listApprovals(MSCA).find(item => item.id === approval.id)
    assert.equal(updated.status, 'pending_confirmation')
    assert.equal(updated.userOpHash, USER_OP)
    assert.equal(JSON.parse(updated.details).webhookEventId, 'notification-1')
    const second = vault.reconcileCircleWalletWebhook({
      walletAddress: MSCA,
      userOpHash: USER_OP,
      txHash: TX,
      status: 'COMPLETE',
      eventId: 'notification-1',
      eventType: 'transactions.outbound',
    })
    assert.equal(second.matched, 0)
    assert.equal(second.reason, 'webhook_reference_not_found')
    assert.equal(vault.listApprovals(MSCA).length, 1)
  } finally {
    if (previousVault === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = previousVault
    if (previousActivity === undefined) delete process.env.VAULT_ACTIVITY_PATH
    else process.env.VAULT_ACTIVITY_PATH = previousActivity
    await import('node:fs/promises').then(x => x.rm(dir, { recursive: true, force: true }))
  }
})
