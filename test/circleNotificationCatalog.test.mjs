import assert from 'node:assert/strict'
import test from 'node:test'

const TX = '0x' + 'a'.repeat(64)
const USER_OP = '0x' + 'b'.repeat(64)
const MSCA = '0x1111111111111111111111111111111111111111'
const CONTRACT = '0x4abcffb90897fe7ce86ed689d1178076544a021b'

// Source of truth: developers.circle.com/api-reference/contracts/common/create-subscription
// Every string Circle's notificationTypes enum accepts, minus the bare `*`.
const OFFICIAL_TYPES = [
  'transactions.*', 'transactions.inbound', 'transactions.outbound',
  'challenges.*', 'challenges.accelerateTransaction', 'challenges.cancelTransaction', 'challenges.changePin',
  'challenges.contractExecution', 'challenges.createTransaction', 'challenges.createWallet', 'challenges.initialize',
  'challenges.restorePin', 'challenges.setPin', 'challenges.setSecurityQuestions',
  'contracts.*', 'contracts.eventLog',
  'modularWallet.*', 'modularWallet.userOperation', 'modularWallet.inboundTransfer', 'modularWallet.outboundTransfer',
  'travelRule.*', 'travelRule.statusUpdate', 'travelRule.deny', 'travelRule.approve',
  'rampSession.*', 'rampSession.completed', 'rampSession.depositReceived', 'rampSession.expired',
  'rampSession.failed', 'rampSession.kycApproved', 'rampSession.kycRejected', 'rampSession.kycSubmitted',
]

async function load() {
  return import('../src/services/circleWalletWebhookService.mjs?catalog=' + Date.now())
}

test('the catalog covers every concrete Circle notification type', async () => {
  const { CIRCLE_NOTIFICATION_TYPES } = await load()
  const concrete = OFFICIAL_TYPES.filter(type => !type.endsWith('.*'))
  for (const type of concrete) {
    assert.ok(CIRCLE_NOTIFICATION_TYPES.includes(type), `missing ${type}`)
  }
  assert.equal(CIRCLE_NOTIFICATION_TYPES.length, concrete.length)
  assert.equal(new Set(CIRCLE_NOTIFICATION_TYPES).size, concrete.length)
})

test('the subscription list uses only family wildcards Circle accepts', async () => {
  const { CIRCLE_SUBSCRIPTION_NOTIFICATION_TYPES } = await load()
  assert.deepEqual(CIRCLE_SUBSCRIPTION_NOTIFICATION_TYPES, [
    'transactions.*', 'challenges.*', 'contracts.*', 'modularWallet.*', 'travelRule.*', 'rampSession.*',
  ])
  // The LIVE subscription API rejects `webhooks.test` ("API parameter invalid");
  // the synthetic probe is fired through the subscription's own /test operation.
  assert.equal(CIRCLE_SUBSCRIPTION_NOTIFICATION_TYPES.includes('webhooks.test'), false)
})

test('notification type policy accepts concrete types, wildcards, bare families and the test event', async () => {
  const { isSupportedCircleNotificationType } = await load()
  for (const type of OFFICIAL_TYPES) assert.equal(isSupportedCircleNotificationType(type), true, type)
  assert.equal(isSupportedCircleNotificationType('challenges'), true)
  assert.equal(isSupportedCircleNotificationType('contracts'), true)
  assert.equal(isSupportedCircleNotificationType('modularWallet'), true)
  assert.equal(isSupportedCircleNotificationType('transactions'), true)
  assert.equal(isSupportedCircleNotificationType('rampSession'), true)
  assert.equal(isSupportedCircleNotificationType('*'), true)
  assert.equal(isSupportedCircleNotificationType('webhooks.test'), true)
  assert.equal(isSupportedCircleNotificationType('gateway.mint.finalized'), false)
  assert.equal(isSupportedCircleNotificationType('unknown.event'), false)
  assert.equal(isSupportedCircleNotificationType(''), false)
})

test('notification family routing maps families and rejects unknown prefixes', async () => {
  const { circleNotificationFamily } = await load()
  assert.equal(circleNotificationFamily('transactions.inbound'), 'transactions')
  assert.equal(circleNotificationFamily('challenges.createWallet'), 'challenges')
  assert.equal(circleNotificationFamily('contracts.eventLog'), 'contracts')
  assert.equal(circleNotificationFamily('modularWallet.userOperation'), 'modularWallet')
  assert.equal(circleNotificationFamily('rampSession.kycApproved'), 'rampSession')
  assert.equal(circleNotificationFamily('travelRule.approve'), 'travelRule')
  assert.equal(circleNotificationFamily('webhooks.test'), 'test')
  assert.equal(circleNotificationFamily('gateway.mint.finalized'), 'unknown')
})

test('transactions.inbound normalizes the documented envelope', async () => {
  const { normalizeCircleNotification } = await load()
  const normalized = normalizeCircleNotification({
    subscriptionId: 'sub-1',
    notificationId: 'notif-1',
    notificationType: 'transactions.inbound',
    notification: {
      id: 'tx-1',
      amounts: ['6.62607015'],
      blockchain: 'ARC-TESTNET',
      state: 'CONFIRMED',
      walletId: 'wallet-1',
      contractAddress: CONTRACT,
      sourceAddress: MSCA,
      destinationAddress: '0xca9142d0b9804ef5e239d3bc1c7aa0d1c74e7350',
      txHash: TX,
      userOpHash: USER_OP,
      refId: 'grouptransaction123',
    },
    timestamp: '2023-11-07T05:31:56Z',
    version: 2,
  })
  assert.equal(normalized.eventType, 'transactions.inbound')
  assert.equal(normalized.notificationId, 'notif-1')
  assert.equal(normalized.subscriptionId, 'sub-1')
  assert.equal(normalized.family, 'transactions')
  assert.equal(normalized.subtype, 'inbound')
  assert.equal(normalized.status, 'confirmed')
  assert.equal(normalized.state, 'CONFIRMED')
  assert.equal(normalized.txHash, TX)
  assert.equal(normalized.userOpHash, USER_OP)
  assert.equal(normalized.walletId, 'wallet-1')
  assert.equal(normalized.contractAddress, CONTRACT)
  assert.equal(normalized.sourceAddress, MSCA)
  assert.equal(normalized.amount, '6.62607015')
  assert.equal(normalized.refId, 'grouptransaction123')
  assert.equal(normalized.version, 2)
})

test('challenges.* normalizes the challenge id and status', async () => {
  const { normalizeCircleNotification } = await load()
  const normalized = normalizeCircleNotification({
    notificationId: 'notif-challenge',
    notificationType: 'challenges.createWallet',
    notification: { id: 'challenge-1', status: 'COMPLETE', walletId: 'wallet-1', userToken: 'ignored' },
  })
  assert.equal(normalized.family, 'challenges')
  assert.equal(normalized.subtype, 'createWallet')
  assert.equal(normalized.challengeId, 'challenge-1')
  assert.equal(normalized.challengeType, 'challenges.createWallet')
  assert.equal(normalized.walletId, 'wallet-1')
  assert.equal(normalized.status, 'complete')
})

test('contracts.eventLog normalizes the Arc Docs payload', async () => {
  const { normalizeCircleNotification } = await load()
  const normalized = normalizeCircleNotification({
    subscriptionId: 'f0332621-a117-4b7b-bdf0-5c61a4681826',
    notificationId: '5c5eea9f-398f-426f-a4a5-1bdc28b36d2c',
    notificationType: 'contracts.eventLog',
    notification: {
      contractAddress: CONTRACT,
      blockchain: 'ARC-TESTNET',
      txHash: TX,
      userOpHash: USER_OP,
      blockHash: '0x0ad6bf57a110d42620defbcb9af98d6223f060de588ed96ae495ddeaf3565c8d',
      blockHeight: 22807198,
      eventSignature: 'Transfer(address,address,uint256)',
      eventSignatureHash: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
      data: '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
      firstConfirmDate: '2026-01-21T06:53:12Z',
    },
    timestamp: '2026-01-21T06:53:13.194467201Z',
    version: 2,
  })
  assert.equal(normalized.family, 'contracts')
  assert.equal(normalized.contractAddress, CONTRACT)
  assert.equal(normalized.blockchain, 'ARC-TESTNET')
  assert.equal(normalized.txHash, TX)
  assert.equal(normalized.eventSignature, 'Transfer(address,address,uint256)')
  assert.equal(normalized.blockHeight, 22807198)
  assert.equal(normalized.topics.length, 1)
  assert.equal(normalized.data, '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000')
  assert.equal(normalized.firstConfirmDate, '2026-01-21T06:53:12Z')
})

test('modularWallet and rampSession families normalize their references', async () => {
  const { normalizeCircleNotification } = await load()
  const userOperation = normalizeCircleNotification({
    notificationId: 'notif-op',
    notificationType: 'modularWallet.userOperation',
    notification: { walletAddress: MSCA, userOperationHash: USER_OP, status: 'COMPLETE' },
  })
  assert.equal(userOperation.family, 'modularWallet')
  assert.equal(userOperation.subtype, 'userOperation')
  assert.equal(userOperation.userOpHash, USER_OP)
  assert.equal(userOperation.walletAddress, MSCA)

  const kyc = normalizeCircleNotification({
    notificationId: 'notif-ramp',
    notificationType: 'rampSession.kycApproved',
    notification: { id: 'session-1', kycStatus: 'APPROVED', depositAddress: MSCA, amount: '25', currency: 'USDC' },
  })
  assert.equal(kyc.family, 'rampSession')
  assert.equal(kyc.subtype, 'kycApproved')
  assert.equal(kyc.sessionId, 'session-1')
  assert.equal(kyc.kycStatus, 'APPROVED')
  assert.equal(kyc.amount, '25')
  assert.equal(kyc.token, 'USDC')
})
