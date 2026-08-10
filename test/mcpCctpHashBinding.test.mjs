import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData } from 'viem'

const MSCA = '0x2222222222222222222222222222222222222222'
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'
const MESSAGE_TRANSMITTER = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'

const ROUTE = {
  fromKey: 'Arc_Testnet',
  toKey: 'Base_Sepolia',
  source: { tokenMessenger: TOKEN_MESSENGER, router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7', usdc: '0x3600000000000000000000000000000000000000' },
  destination: { domain: 6, requiredFinalityThreshold: 1000, tokenMessenger: TOKEN_MESSENGER, messageTransmitter: MESSAGE_TRANSMITTER, rpcUrl: 'https://example.invalid/base' },
}
const BASE_TO_ARC_ROUTE = {
  fromKey: 'Base_Sepolia',
  toKey: 'Arc_Testnet',
  source: { tokenMessenger: TOKEN_MESSENGER, router: '0x9425cC5b3C8B9e0FCb35beBdE737B4365A614Acc', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
  destination: { domain: 26, requiredFinalityThreshold: 1000, tokenMessenger: TOKEN_MESSENGER, messageTransmitter: MESSAGE_TRANSMITTER, rpcUrl: 'https://example.invalid/arc' },
}
const ARC_TO_ARBITRUM_ROUTE = {
  fromKey: 'Arc_Testnet',
  toKey: 'Arbitrum_Sepolia',
  source: { tokenMessenger: TOKEN_MESSENGER, router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7', usdc: '0x3600000000000000000000000000000000000000' },
  destination: { domain: 3, requiredFinalityThreshold: 1000, tokenMessenger: TOKEN_MESSENGER, messageTransmitter: MESSAGE_TRANSMITTER, rpcUrl: 'https://example.invalid/arbitrum' },
}
const ARBITRUM_TO_ARC_ROUTE = {
  fromKey: 'Arbitrum_Sepolia',
  toKey: 'Arc_Testnet',
  source: { tokenMessenger: TOKEN_MESSENGER, router: '0x5dCAA895dDc7350cF0f9eb69E69536a4548b0cA7', usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
  destination: { domain: 26, requiredFinalityThreshold: 1000, tokenMessenger: TOKEN_MESSENGER, messageTransmitter: MESSAGE_TRANSMITTER, rpcUrl: 'https://example.invalid/arc' },
}

function messageFor(recipient, route = ROUTE) {
  const word = value => String(value).replace(/^0x/i, '').padStart(64, '0')
  const uint32 = value => String(value).replace(/^0x/i, '').padStart(8, '0')
  const finalityThreshold = Number(route.destination.domain) === 26 ? '0x7d0' : '0x3e8'
  const header = [
    uint32('0x1'),
    uint32(route.fromKey === 'Base_Sepolia' ? '0x6' : '0x1a'),
    uint32(route.toKey === 'Arc_Testnet' ? '0x1a' : '0x6'),
    word('1'), word(route.source.tokenMessenger), word(route.destination.tokenMessenger), word('0'), uint32(finalityThreshold), uint32(finalityThreshold),
  ].join('')
  const body = [
    uint32('1'), word(route.source.usdc), word(recipient), word('0x0f4240'),    word(route.source.router), word('0x0a'), word('0x0a'), word('0'),

  ].join('')
  return '0x' + header + body
}

test('router validation fails closed on wrong deployment configuration', async () => {
  const { compareRouterRouteConfiguration } = await import('../src/services/mcpServer.mjs?router-validation-' + Date.now() + '-' + Math.random())
  assert.deepEqual(compareRouterRouteConfiguration({
    code: '0x1234',
    configuredUsdc: BASE_TO_ARC_ROUTE.source.usdc,
    configuredMessenger: BASE_TO_ARC_ROUTE.source.tokenMessenger,
    localDomain: 6,
    supportedDestination: true,
    route: BASE_TO_ARC_ROUTE,
  }), ['router_source_domain_mismatch'])
  assert.deepEqual(compareRouterRouteConfiguration({
    code: '0x',
    configuredUsdc: '0x0000000000000000000000000000000000000001',
    configuredMessenger: '0x0000000000000000000000000000000000000002',
    localDomain: 26,
    supportedDestination: false,
    route: BASE_TO_ARC_ROUTE,
  }), [
    'router_not_deployed',
    'router_usdc_mismatch',
    'router_token_messenger_mismatch',
    'router_source_domain_mismatch',
    'router_destination_domain_not_enabled',
  ])
})

test('Base→Arc bridge status binds source router, Base USDC, and Arc recipient', async () => {
  const { getCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?base-arc-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ message: messageFor(MSCA, BASE_TO_ARC_ROUTE), attestation: '0xattestation', status: 'complete' }] }), { status: 200 })
  try {
    const result = await getCctpBridgeStatus({ burnTxHash: '0x' + 'c'.repeat(64), sourceDomain: 6, destinationDomain: 26, walletAddress: MSCA, route: BASE_TO_ARC_ROUTE, expectedBurnAmount: 1_000_000n })
    assert.equal(result.status, 'attestation_ready')
    assert.equal(result.messageBody.mintRecipient, MSCA)
    assert.equal(result.messageBody.messageSender, BASE_TO_ARC_ROUTE.source.router.toLowerCase())
    assert.equal(result.messageBody.burnToken, BASE_TO_ARC_ROUTE.source.usdc.toLowerCase())
    assert.equal(result.cctpFeeExecuted, '10')
    assert.equal(result.netMintAmount, '999990')
    assert.equal(result.messageHeader.sourceDomain, 6)
    assert.equal(result.messageHeader.destinationDomain, 26)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('route mismatch exposes the exact decoded candidate and expected binding', async () => {
  const { getCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?route-diagnostics-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ message: messageFor('0x3333333333333333333333333333333333333333', BASE_TO_ARC_ROUTE), attestation: '0xattestation', status: 'complete' }] }), { status: 200 })
  try {
    const result = await getCctpBridgeStatus({
      burnTxHash: '0x' + 'e'.repeat(64), sourceDomain: 6, destinationDomain: 26,
      walletAddress: MSCA, route: BASE_TO_ARC_ROUTE, expectedBurnAmount: 1_000_000n,
    })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'cctp_message_route_unverified')
    assert.equal(result.messageHeader.messageBody.mintRecipient, '0x3333333333333333333333333333333333333333')
    assert.equal(result.expectedRoute.headerSender, TOKEN_MESSENGER.toLowerCase())
    assert.equal(result.expectedRoute.headerRecipient, TOKEN_MESSENGER.toLowerCase())
    assert.equal(result.expectedRoute.messageSender, BASE_TO_ARC_ROUTE.source.router.toLowerCase())
    assert.equal(result.expectedRoute.amount, '1000000')
    assert.equal(result.messageCandidates[0].mintRecipient, '0x3333333333333333333333333333333333333333')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('destination nonce check supports Arc and fails closed on RPC errors', async () => {
  const { destinationMintAlreadyProcessed } = await import('../src/services/mcpServer.mjs?nonce-arc-' + Date.now() + '-' + Math.random())
  const status = { message: messageFor(MSCA, BASE_TO_ARC_ROUTE) }
  const calls = []
  const processed = await destinationMintAlreadyProcessed({ status, route: BASE_TO_ARC_ROUTE, client: { readContract: async args => { calls.push(args); return 1n } } })
  assert.equal(processed.checked, true)
  assert.equal(processed.processed, true)
  assert.equal(calls[0].functionName, 'usedNonces')
  assert.equal(calls[0].args[0], '0x' + '0'.repeat(63) + '1')
  const notProcessed = await destinationMintAlreadyProcessed({ status, route: BASE_TO_ARC_ROUTE, client: { readContract: async () => 0n } })
  assert.equal(notProcessed.checked, true)
  assert.equal(notProcessed.processed, false)
  const unavailable = await destinationMintAlreadyProcessed({ status, route: BASE_TO_ARC_ROUTE, client: { readContract: async () => { throw new Error('rpc unavailable') } } })
  assert.equal(unavailable.checked, false)
  assert.equal(unavailable.reason, 'destination_nonce_check_unavailable')
})

test('route mismatch is terminal and is not repeatedly polled', async () => {
  const { waitForCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?cctp-terminal-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response(JSON.stringify({ messages: [{ message: messageFor('0x3333333333333333333333333333333333333333', BASE_TO_ARC_ROUTE), attestation: '0xattestation', status: 'complete' }] }), { status: 200 })
  }
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + 'f'.repeat(64), sourceDomain: 6, destinationDomain: 26,
      walletAddress: MSCA, route: BASE_TO_ARC_ROUTE, expectedBurnAmount: 1_000_000n,
    }, { attempts: 5, delayMs: 0 })
    assert.equal(result.status, 'rejected')
    assert.equal(result.reason, 'cctp_message_route_unverified')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('transient Iris route candidate is polled until the exact Base→Arc message is indexed', async () => {
  const { waitForCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?cctp-transient-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    const messages = calls === 1
      ? []
      : [{ message: messageFor(MSCA, BASE_TO_ARC_ROUTE), attestation: '0xattestation', status: 'complete' }]
    return new Response(JSON.stringify({ messages }), { status: 200 })
  }
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + 'd'.repeat(64), sourceDomain: 6, destinationDomain: 26,
      walletAddress: MSCA, route: BASE_TO_ARC_ROUTE, expectedBurnAmount: 1_000_000n,
    }, { attempts: 2, delayMs: 0 })
    assert.equal(calls, 2)
    assert.equal(result.status, 'attestation_ready')
    assert.equal(result.verified, true)
    assert.equal(result.messageBody.mintRecipient, MSCA)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('bridge status fetches and binds the requested burnTxHash', async () => {
  const { getCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?cctp-hash-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async url => {
    requested.push(String(url))
    const burnHash = new URL(url).searchParams.get('transactionHash')
    const recipient = burnHash === '0x' + 'a'.repeat(64) ? MSCA : '0x3333333333333333333333333333333333333333'
    return new Response(JSON.stringify({ messages: [{ message: messageFor(recipient), attestation: '0xattestation', status: 'complete' }] }), { status: 200 })
  }
  try {
    const first = await getCctpBridgeStatus({ burnTxHash: '0x' + 'a'.repeat(64), sourceDomain: 26, destinationDomain: 6, walletAddress: MSCA, route: ROUTE, expectedBurnAmount: 1_000_000n })
    const second = await getCctpBridgeStatus({ burnTxHash: '0x' + 'b'.repeat(64), sourceDomain: 26, destinationDomain: 6, walletAddress: MSCA, route: ROUTE, expectedBurnAmount: 1_000_000n })
    assert.equal(first.status, 'attestation_ready')
    assert.equal(first.messageBody.mintRecipient, MSCA)
    assert.equal(second.status, 'rejected')
    assert.equal(second.reason, 'cctp_message_route_unverified')
    const permanent = await getCctpBridgeStatus({ burnTxHash: '0x' + 'b'.repeat(64), sourceDomain: 26, destinationDomain: 6, walletAddress: MSCA, route: ROUTE, expectedBurnAmount: 1_000_000n })
    assert.equal(permanent.status, 'rejected')
    assert.equal(permanent.verified, false)
    assert.equal(requested.length, 3)
    assert.match(requested[0], /transactionHash=0x[a]+$/)
    assert.match(requested[1], /transactionHash=0x[b]+$/)
    assert.match(requested[2], /transactionHash=0x[b]+$/)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('Arc→Base calldata keeps the proven standard CCTP threshold 1000', async () => {
  const { buildMscaRouterBridgeCalls } = await import('../src/services/mcpServer.mjs?arc-base-regression-' + Date.now() + '-' + Math.random())
  const calls = buildMscaRouterBridgeCalls({ route: ROUTE, amount: 1_000_000n, mintRecipient: MSCA })
  const decoded = decodeFunctionData({
    abi: [{
      type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable',
      inputs: [
        { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
        { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
        { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
      ], outputs: [],
    }],
    data: calls[1].data,
  })
  assert.equal(calls[0].to.toLowerCase(), ROUTE.source.usdc.toLowerCase())
  assert.equal(calls[1].to.toLowerCase(), ROUTE.source.router.toLowerCase())
  assert.equal(decoded.args?.[1], 6)
  assert.equal(decoded.args?.[5], 1000)
  assert.equal(decoded.args?.[2], '0x' + MSCA.slice(2).toLowerCase().padStart(64, '0'))
})

test('Base→Arc calldata mirrors frontend fast CCTP threshold 1000', async () => {
  const { buildMscaRouterBridgeCalls } = await import('../src/services/mcpServer.mjs?base-arc-finality-' + Date.now() + '-' + Math.random())
  const route = {
    fromKey: 'Base_Sepolia',
    toKey: 'Arc_Testnet',
    source: {
      domain: 6,
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      router: '0x9425cC5b3C8B9e0FCb35beBdE737B4365A614Acc',
    },
    destination: { domain: 26, requiredFinalityThreshold: 1000 },
  }
  const calls = buildMscaRouterBridgeCalls({ route, amount: 1_000_000n, mintRecipient: MSCA })
  const decoded = decodeFunctionData({
    abi: [{
      type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable',
      inputs: [
        { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
        { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
        { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
      ], outputs: [],
    }],
    data: calls[1].data,
  })
  assert.equal(decoded.args?.[5], 1000)
})

test('all four Arc↔Base and Arc↔Arbitrum MSCA routes are advertised', async () => {
  const { isMscaCctpRouteConfigured } = await import('../src/services/mcpServer.mjs?four-route-capability-' + Date.now() + '-' + Math.random())
  assert.deepEqual([
    ['arc-testnet', 'base-sepolia'],
    ['base-sepolia', 'arc-testnet'],
    ['arc-testnet', 'arbitrum-sepolia'],
    ['arbitrum-sepolia', 'arc-testnet'],
  ].map(([from, to]) => isMscaCctpRouteConfigured(from, to)), [true, true, true, true])
})

test('all four route calldata builders bind the correct source router, domain, and MSCA', async () => {
  const { buildMscaRouterBridgeCalls } = await import('../src/services/mcpServer.mjs?four-route-calldata-' + Date.now() + '-' + Math.random())
  const routes = [ROUTE, BASE_TO_ARC_ROUTE, ARC_TO_ARBITRUM_ROUTE, ARBITRUM_TO_ARC_ROUTE]
  for (const route of routes) {
    const calls = buildMscaRouterBridgeCalls({ route, amount: 1_000_000n, mintRecipient: MSCA })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].to.toLowerCase(), route.source.usdc.toLowerCase())
    assert.equal(calls[1].to.toLowerCase(), route.source.router.toLowerCase())
    const decoded = decodeFunctionData({
      abi: [{ type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable', inputs: [
        { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
      ], outputs: [] }],
      data: calls[1].data,
    })
    assert.equal(decoded.args?.[1], route.destination.domain)
    assert.equal(decoded.args?.[2], `0x${MSCA.slice(2).toLowerCase().padStart(64, '0')}`)
    assert.equal(decoded.args?.[5], 1000)
  }
})

test('decoded pending Iris message remains retryable until attestation exists', async () => {
  const { waitForCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?decoded-pending-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const message = messageFor(MSCA, BASE_TO_ARC_ROUTE)
    const response = calls === 1
      ? { messages: [{ message, status: 'pending_confirmations' }] }
      : { messages: [{ message, attestation: '0xattestation', status: 'complete' }] }
    return new Response(JSON.stringify(response), { status: 200 })
  }
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + '2'.repeat(64), sourceDomain: 6, destinationDomain: 26,
      walletAddress: MSCA, route: BASE_TO_ARC_ROUTE, expectedBurnAmount: 1_000_000n,
    }, { attempts: 2, delayMs: 0 })
    assert.equal(calls, 2)
    assert.equal(result.status, 'attestation_ready')
    assert.equal(result.verified, true)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('invalid finality values are normalized to a supported CCTP threshold', async () => {
  const previous = process.env.CCTP_MIN_FINALITY_THRESHOLD
  process.env.CCTP_MIN_FINALITY_THRESHOLD = '1234'
  try {
    const { buildMscaRouterBridgeCalls } = await import('../src/services/mcpServer.mjs?finality-normalize-' + Date.now() + '-' + Math.random())
    const route = { fromKey: 'Arc_Testnet', toKey: 'Base_Sepolia', source: { domain: 26, usdc: ROUTE.source.usdc, router: ROUTE.source.router }, destination: { domain: 6, requiredFinalityThreshold: 1000 } }
    const calls = buildMscaRouterBridgeCalls({ route, amount: 1_000_000n, mintRecipient: MSCA })
    const decoded = decodeFunctionData({
      abi: [{ type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable', inputs: [
        { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' }, { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' }, { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
      ], outputs: [] }], data: calls[1].data,
    })
    assert.equal(decoded.args?.[5], 1000)
  } finally {
    if (previous === undefined) delete process.env.CCTP_MIN_FINALITY_THRESHOLD
    else process.env.CCTP_MIN_FINALITY_THRESHOLD = previous
  }
})

test('Iris non-2xx and pending confirmations remain retryable', async () => {
  const { waitForCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?cctp-http-pending-' + Date.now())
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return new Response('temporarily unavailable', { status: 503 })
    return new Response(JSON.stringify({ messages: [{ status: 'pending_confirmations' }] }), { status: 200 })
  }
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + '1'.repeat(64), sourceDomain: 6, destinationDomain: 26,
      walletAddress: MSCA, route: BASE_TO_ARC_ROUTE, expectedBurnAmount: 1_000_000n,
    }, { attempts: 2, delayMs: 0 })
    assert.equal(calls, 2)
    assert.equal(result.status, 'pending')
    assert.equal(result.reason, 'cctp_message_pending')
    assert.equal(result.messageStatus, 'pending_confirmations')
  } finally {
    globalThis.fetch = previousFetch
  }
})
