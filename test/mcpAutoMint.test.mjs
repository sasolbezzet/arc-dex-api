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
  assert.equal(params.verificationGasLimit, 130_000n)
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
  // Mainnet registry keys must canonicalize like the persisted bridge records:
  // `Base` and `base-mainnet` are the same execution chain, so the inbound
  // profile (and the burn-hash intent lookup) resolve instead of returning
  // undefined while the destination record used the other spelling.
  assert.equal(resolveMscaBridgeFeeProfile({ fromKey: 'Base', toKey: 'Arc_Testnet' }), 'base-to-arc-source')
  assert.equal(resolveMscaBridgeFeeProfile({ fromKey: 'Arbitrum', toKey: 'Arc_Testnet' }), 'arbitrum-to-arc-source')
  assert.equal(resolveMscaBridgeFeeProfile({ fromKey: 'Arc_Testnet', toKey: 'Base' }), 'arc-bridge')
  assert.equal(resolveSessionPaymasterMode({ chainKey: 'base-sepolia', feeProfile: 'base-to-arc-source', requested: true }), 'circle-gas-station')
  assert.equal(resolveSessionPaymasterMode({ chainKey: 'arbitrum-sepolia', feeProfile: 'arbitrum-to-arc-source', requested: true }), 'circle-gas-station')
  assert.equal(resolveSessionPaymasterMode({ chainKey: 'arc-testnet', feeProfile: 'arc-bridge', requested: true }), 'native')
  const baseParams = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'base-sepolia', baseClient: gasPriceClient, feeProfile: resolveMscaBridgeFeeProfile(baseRoute) })
  assert.equal(baseParams.maxPriorityFeePerGas, 1_000_000_000n)
  assert.equal(baseParams.maxFeePerGas, 3_000_000_000n)
  // Base account validation matches Arbitrum (~55k-82k), so the old 270k
  // limit fell under Circle's 40% efficiency floor for source burns too.
  assert.equal(baseParams.verificationGasLimit, 130_000n)
  const arbitrumParams = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'arbitrum-sepolia', baseClient: gasPriceClient, feeProfile: resolveMscaBridgeFeeProfile(arbitrumRoute) })
  assert.equal(arbitrumParams.verificationGasLimit, 130_000n)
  const arbitrumDestinationParams = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'arbitrum-sepolia', baseClient: gasPriceClient, feeProfile: 'arbitrum-destination' })
  // The receiveMessage precheck uses about 56k-82k verification gas. 130k
  // retains execution headroom while satisfying Circle's 40% efficiency requirement.
  assert.equal(arbitrumDestinationParams.verificationGasLimit, 130_000n)
})

test('Base mainnet bridge UserOperations stay above Circle verification gas efficiency floor', async () => {
  const { buildUserOperationParams } = await import('../src/services/sessionKeyService.mjs?base-destination-gas-' + Date.now() + '-' + Math.random())
  const gasPriceClient = {
    request: async ({ method }) => method === 'circle_getUserOperationGasPrice'
      ? { medium: { maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000000' } }
      : '0x1',
    getGasPrice: async () => 1n,
  }
  // Measured ~69.6k account validation on Base mainnet: the old 270k limit was
  // 25.8% efficient, so the bundler rejected both the destination mint and the
  // inbound source burn (`Verification gas limit efficiency too low`).
  for (const feeProfile of ['base-destination', 'base-to-arc-source']) {
    const params = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'base-mainnet', baseClient: gasPriceClient, feeProfile })
    assert.equal(params.verificationGasLimit, 130_000n, `${feeProfile} verification gas limit`)
    assert.ok(69_614 / Number(params.verificationGasLimit) > 0.4, `${feeProfile} stays above the 40% floor`)
  }
  // Arc keeps the larger budget: its bundler sponsors a different validation
  // profile and has not shown the rollup efficiency rejection.
  const arcDestination = await buildUserOperationParams({ account: {}, calls: [], chainKey: 'arc-testnet', baseClient: gasPriceClient, feeProfile: 'arc-destination' })
  assert.equal(arcDestination.verificationGasLimit, 270_000n)
})

test('Arbitrum verification precheck errors are classified as safe destination retries', async () => {
  const { classifyUserOperationPrecheckError, normalizeUserOperationFees } = await import('../src/services/sessionKeyService.mjs?arb-precheck-' + Date.now() + '-' + Math.random())
  const error = new Error('Invalid fields set on User Operation. Details: Verification gas limit efficiency too low. Required: 0.4, Actual: 0.13628142857142858')
  assert.equal(classifyUserOperationPrecheckError(error), 'user_operation_precheck_failed')
  assert.deepEqual(normalizeUserOperationFees({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }), {
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  })
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
