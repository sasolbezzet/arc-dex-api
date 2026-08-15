import test from 'node:test'
import assert from 'node:assert/strict'

test('waitForCctpBridgeStatus queues auto-mint once after the configured delay and preserves manual status polling', async () => {
  const { waitForCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?auto-mint-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  let now = 0
  let calls = 0
  let queued = 0
  const sleep = async ms => { now += Number(ms) || 0 }
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ messages: [] }), { status: 200 })
  }
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + 'a'.repeat(64),
      sourceDomain: 26,
      destinationDomain: 3,
    }, {
      attempts: 4,
      delayMs: 10_000,
      autoMintAfterMs: 30_000,
      onPending: async () => { queued++ },
      now: () => now,
      sleep,
    })
    assert.equal(result.status, 'pending')
    assert.equal(result.autoMintQueued, true)
    assert.equal(queued, 1)
    assert.equal(calls, 4)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('hashless destination recovery requires a cooldown and updated approval timestamp', async () => {
  const { HASHLESS_DESTINATION_RECOVERY_DELAY_MS, hashlessDestinationRetryAllowed } = await import('../src/services/mcpServer.mjs?hashless-recovery-' + Date.now() + '-' + Math.random())
  const now = 1_000_000
  assert.equal(hashlessDestinationRetryAllowed({ updatedAt: now - HASHLESS_DESTINATION_RECOVERY_DELAY_MS + 1 }, now), false)
  assert.equal(hashlessDestinationRetryAllowed({ updatedAt: now - HASHLESS_DESTINATION_RECOVERY_DELAY_MS }, now), true)
  assert.equal(hashlessDestinationRetryAllowed({ createdAt: now - HASHLESS_DESTINATION_RECOVERY_DELAY_MS }, now), true)
  assert.equal(hashlessDestinationRetryAllowed({ updatedAt: 0, createdAt: 0 }, now), false)
})

test('receipt errors retain the accepted UserOperation hash for destination recovery', async () => {
  const { annotateUserOperationError } = await import('../src/services/sessionKeyService.mjs?receipt-hash-' + Date.now() + '-' + Math.random())
  const original = new Error('Circle receipt indexer unavailable')
  const annotated = annotateUserOperationError(original, '0x' + 'a'.repeat(64), 'https://example.invalid/tx/0x' + 'a'.repeat(64))
  assert.equal(annotated, original)
  assert.equal(annotated.userOpHash, '0x' + 'a'.repeat(64))
  assert.match(annotated.explorerUrl, /0x[a]+$/)
  assert.equal(annotated.code, 'user_operation_receipt_unavailable')
})

test('destination bridge fee preparation prefers Circle Gas Station fee recommendations', async () => {
  const { buildUserOperationParams } = await import('../src/services/sessionKeyService.mjs?circle-gas-destination-' + Date.now() + '-' + Math.random())
  const methods = []
  const params = await buildUserOperationParams({
    account: {},
    calls: [],
    chainKey: 'base-sepolia',
    feeProfile: 'base-destination',
    baseClient: {
      request: async ({ method }) => {
        methods.push(method)
        if (method === 'circle_getUserOperationGasPrice') return { medium: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' } }
        return '0x1'
      },
      getGasPrice: async () => 1n,
    },
  })
  assert.ok(methods.includes('circle_getUserOperationGasPrice'))
  assert.equal(params.maxPriorityFeePerGas, 1_000_000_000n)
  assert.equal(params.maxFeePerGas, 3_000_000_000n)
  assert.equal(params.verificationGasLimit, 270_000n)
})

test('inbound Base/Arbitrum bridges use explicit Circle paymaster profiles', async () => {
  const { resolveMscaBridgeFeeProfile } = await import('../src/services/mcpServer.mjs?inbound-paymaster-' + Date.now() + '-' + Math.random())
  const sessionKeyModule = await import('../src/services/sessionKeyService.mjs?inbound-paymaster-fees-' + Date.now() + '-' + Math.random())
  const { buildUserOperationParams, resolveSessionPaymasterMode } = sessionKeyModule
  const gasPriceClient = {
    request: async ({ method }) => method === 'circle_getUserOperationGasPrice'
      ? { medium: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' } }
      : '0x1',
    getGasPrice: async () => 1n,
  }
  const baseRoute = { fromKey: 'Base_Sepolia', toKey: 'Arc_Testnet' }
  const arbitrumRoute = { fromKey: 'Arbitrum_Sepolia', toKey: 'Arc_Testnet' }
  assert.equal(resolveMscaBridgeFeeProfile(baseRoute), 'base-to-arc-source')
  assert.equal(resolveMscaBridgeFeeProfile(arbitrumRoute), 'arbitrum-to-arc-source')
  assert.equal(resolveSessionPaymasterMode({ chainKey: 'base-sepolia', feeProfile: 'base-to-arc-source', requested: true }), 'circle-gas-station')
  assert.equal(resolveSessionPaymasterMode({ chainKey: 'arbitrum-sepolia', feeProfile: 'arbitrum-to-arc-source', requested: true }), 'circle-gas-station')
  assert.equal(resolveSessionPaymasterMode({ chainKey: 'arc-testnet', feeProfile: 'arc-bridge', requested: true }), 'native')
  const baseParams = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'base-sepolia', baseClient: gasPriceClient, feeProfile: resolveMscaBridgeFeeProfile(baseRoute) })
  assert.equal(baseParams.maxPriorityFeePerGas, 1_000_000_000n)
  assert.equal(baseParams.maxFeePerGas, 3_000_000_000n)
  assert.equal(baseParams.verificationGasLimit, 270_000n)
  const arbitrumParams = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'arbitrum-sepolia', baseClient: gasPriceClient, feeProfile: resolveMscaBridgeFeeProfile(arbitrumRoute) })
  assert.equal(arbitrumParams.verificationGasLimit, 125_000n)
})

test('failed source burn before router execution does not block a fresh bridge quote', async () => {
  const { classifySourceBridgeBurn, hasUnresolvedSourceBridgeIntent } = await import('../src/services/mcpServer.mjs?source-burn-retry-' + Date.now() + '-' + Math.random())
  const approvalHash = '0x' + 'a'.repeat(64)
  const failed = {
    id: 'approval-only',
    action: 'bridge',
    status: 'error',
    userOpHash: approvalHash,
    details: JSON.stringify({
      fromChain: 'Arc_Testnet',
      toChain: 'Base_Sepolia',
      walletAddress: '0x2222222222222222222222222222222222222222',
      sourceApprovalUserOpHash: approvalHash,
      settlementPhase: 'source_submission_failed',
      reason: 'user_operation_precheck_failed',
      userOpAccepted: 'no',
      safeToRetry: true,
    }),
  }
  assert.equal(classifySourceBridgeBurn(JSON.parse(failed.details), failed), 'burn_failed')
  assert.equal(hasUnresolvedSourceBridgeIntent([failed], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: '0x2222222222222222222222222222222222222222',
  }), null)
})

test('accepted source burn remains blocked even when the preview id changes', async () => {
  const { classifySourceBridgeBurn, hasUnresolvedSourceBridgeIntent } = await import('../src/services/mcpServer.mjs?source-burn-accepted-' + Date.now() + '-' + Math.random())
  const burnUserOpHash = '0x' + 'b'.repeat(64)
  const pending = {
    id: 'burn-accepted',
    action: 'bridge',
    status: 'pending_confirmation',
    details: JSON.stringify({
      fromChain: 'Arc_Testnet',
      toChain: 'Base_Sepolia',
      previewId: 'old-preview',
      walletAddress: '0x2222222222222222222222222222222222222222',
      sourceUserOpHash: burnUserOpHash,
      settlementPhase: 'source_submitted',
      userOpAccepted: 'yes',
    }),
  }
  assert.equal(classifySourceBridgeBurn(JSON.parse(pending.details), pending), 'burn_unresolved')
  assert.equal(hasUnresolvedSourceBridgeIntent([pending], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: '0x2222222222222222222222222222222222222222',
  })?.approval.id, pending.id)
})
