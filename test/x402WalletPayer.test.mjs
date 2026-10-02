import test from 'node:test'
import assert from 'node:assert/strict'
import { getAddress, verifyTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// The wallet payer moves real money out of an ARCOX-controlled key, so these
// tests pin the three things that can go wrong quietly: signing the wrong
// EIP-712 domain, paying a rail we cannot settle, and paying above the quoted
// price cap.
const TEST_KEY = '0x' + '11'.repeat(32)
const TEST_ACCOUNT = privateKeyToAccount(TEST_KEY)
process.env.X402_MARKETPLACE_PAYER_PRIVATE_KEY = TEST_KEY
process.env.X402_MARKETPLACE_MAX_UPSTREAM_USDC = '5'

const {
  payWithWallet, walletPayerStatus, parsePaymentRequired, selectWalletAccept,
  buildEip3009Authorization, encodePaymentSignatureHeader,
} = await import('../src/services/x402WalletPayer.mjs')

const VANILLA_BASE = {
  scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x6d6E695b09861467c7d462f5AAF31cF3540B9192', amount: '7000', maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2' },
}
const GATEWAY_BASE = {
  ...VANILLA_BASE,
  amount: '5000',
  extra: { name: 'GatewayWalletBatched', version: '1', assets: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }] },
}
const SOLANA = {
  scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  payTo: '12Ec2cJmfR1C9uwejzxcuMhUgEC7wDrLgm1wBvvR5w9E', amount: '7000', maxTimeoutSeconds: 60,
  extra: { name: 'USD Coin', version: '2', feePayer: 'BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F' },
}
const ARC_VANILLA = { ...VANILLA_BASE, network: 'eip155:5042', asset: '0x3600000000000000000000000000000000000000', payTo: '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC' }

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    json: async () => body,
  }
}

function requirementsHeader(accepts) {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString('base64')
}

test('the payer only reports itself ready when a private key is present', () => {
  const status = walletPayerStatus()
  assert.equal(status.mode, 'wallet')
  assert.equal(status.configured, true)
  assert.equal(status.payerAddress, TEST_ACCOUNT.address)
  assert.deepEqual(status.problems, [])

  delete process.env.X402_MARKETPLACE_PAYER_PRIVATE_KEY
  const missing = walletPayerStatus()
  assert.equal(missing.configured, false)
  assert.deepEqual(missing.problems, ['payer_private_key_missing'])
  assert.match(missing.hint, /X402_MARKETPLACE_PAYER_PRIVATE_KEY/)
  process.env.X402_MARKETPLACE_PAYER_PRIVATE_KEY = TEST_KEY
})

test('payment requirements are read from the v2 header and the v1 body', () => {
  const fromHeader = parsePaymentRequired({ headers: new Headers({ 'payment-required': requirementsHeader([VANILLA_BASE]) }), body: null })
  assert.equal(fromHeader.accepts[0].amount, '7000')

  const fromBody = parsePaymentRequired({ headers: new Headers(), body: { x402Version: 1, accepts: [VANILLA_BASE] } })
  assert.equal(fromBody.x402Version, 1)

  const fromWrapped = parsePaymentRequired({ headers: new Headers(), body: { x402: { accepts: [VANILLA_BASE] } } })
  assert.equal(fromWrapped.accepts.length, 1)

  assert.equal(parsePaymentRequired({ headers: new Headers(), body: { error: 'nope' } }), null)
  assert.equal(parsePaymentRequired({ headers: new Headers({ 'payment-required': 'not-base64!!' }), body: null }), null)
})

test('only rails the wallet can settle are selected', () => {
  const selected = selectWalletAccept([GATEWAY_BASE, SOLANA, VANILLA_BASE], { maxAmountUsdc: 1 })
  assert.equal(selected.accept, VANILLA_BASE)
  assert.equal(selected.chain.cliChain, 'BASE')

  // Gateway batches and Solana sponsors are excluded on their own.
  assert.equal(selectWalletAccept([GATEWAY_BASE], { maxAmountUsdc: 1 }), null)
  assert.equal(selectWalletAccept([SOLANA], { maxAmountUsdc: 1 }), null)

  // Price cap, Permit2, and a seller that is us are all refused.
  assert.equal(selectWalletAccept([VANILLA_BASE], { maxAmountUsdc: 0.001 }), null)
  assert.equal(selectWalletAccept([{ ...VANILLA_BASE, extra: { ...VANILLA_BASE.extra, assetTransferMethod: 'permit2' } }], { maxAmountUsdc: 1 }), null)
  assert.equal(selectWalletAccept([VANILLA_BASE], { maxAmountUsdc: 1, payerAddress: VANILLA_BASE.payTo }), null)

  // An explicit chain wins over the cheaper option.
  const preferred = selectWalletAccept([GATEWAY_BASE, ARC_VANILLA, VANILLA_BASE], { chain: 'ARC', maxAmountUsdc: 1 })
  assert.equal(preferred.accept.network, 'eip155:5042')
})

test('the signed authorization is a valid EIP-3009 signature for the seller domain', async () => {
  const authorization = buildEip3009Authorization({ payerAddress: TEST_ACCOUNT.address, accept: VANILLA_BASE, now: 1_800_000_000_000 })
  assert.equal(authorization.from, getAddress(TEST_ACCOUNT.address))
  assert.equal(authorization.to, getAddress(VANILLA_BASE.payTo))
  assert.equal(authorization.value, '7000')
  assert.equal(authorization.validAfter, '1799999400')
  assert.equal(authorization.validBefore, '1800000060')
  assert.match(authorization.nonce, /^0x[0-9a-f]{64}$/)

  const signature = await TEST_ACCOUNT.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: getAddress(VANILLA_BASE.asset) },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(authorization.from), to: getAddress(authorization.to), value: 7000n,
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
    },
  })
  const valid = await verifyTypedData({
    address: TEST_ACCOUNT.address,
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: getAddress(VANILLA_BASE.asset) },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ] },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(authorization.from), to: getAddress(authorization.to), value: 7000n,
      validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
    },
    signature,
  })
  assert.equal(valid, true)

  const header = JSON.parse(Buffer.from(encodePaymentSignatureHeader({ accept: VANILLA_BASE, authorization, signature, resource: 'https://api.exa.ai/search' }), 'base64').toString('utf8'))
  assert.equal(header.x402Version, 2)
  assert.deepEqual(header.accepted, VANILLA_BASE, 'accepted harus ikut supaya server tahu rail yang dipilih')
  assert.equal(header.payload.authorization.nonce, authorization.nonce)
  assert.equal(header.payload.signature, signature)
})

test('a 402 is answered with a signed payment and the provider body is returned', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    if (requests.length === 1) return jsonResponse(402, { error: 'Payment Required' }, { 'payment-required': requirementsHeader([GATEWAY_BASE, VANILLA_BASE]) })
    return jsonResponse(200, { results: [{ title: 'arcox' }] }, { 'payment-response': 'c2V0dGxlZA==' })
  }
  const result = await payWithWallet({
    resource: 'https://api.exa.ai/search', method: 'POST', data: { query: 'arcox' }, maxAmountUsdc: 0.01, fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.providerPayload, { results: [{ title: 'arcox' }] })
  assert.equal(result.settlement.amountUsdc, '0.007000')
  assert.equal(result.settlement.payer, TEST_ACCOUNT.address)
  assert.equal(result.settlement.paymentResponse, 'c2V0dGxlZA==')

  const sent = JSON.parse(Buffer.from(requests[1].init.headers['PAYMENT-SIGNATURE'], 'base64').toString('utf8'))
  assert.equal(sent.accepted.extra.name, 'USD Coin', 'rail Gateway tidak boleh dipakai walau lebih murah')
  assert.equal(sent.payload.authorization.value, '7000')
  assert.equal(requests[0].init.headers['PAYMENT-SIGNATURE'], undefined, 'permintaan pertama tanpa pembayaran')
  assert.equal(requests[1].init.headers['content-type'], 'application/json')
})

test('an endpoint that never returns 402 is passed through, not paid twice', async () => {
  let calls = 0
  const result = await payWithWallet({
    resource: 'https://api.free.example/data',
    fetchImpl: async () => { calls += 1; return jsonResponse(200, { free: true }) },
  })
  assert.equal(result.ok, true)
  assert.equal(result.providerPayload.free, true)
  assert.equal(calls, 1)
})

test('unsupported rails and rejected payments are reported instead of silently failing', async () => {
  const gatewayOnly = await payWithWallet({
    resource: 'https://api.gateway.example/x',
    maxAmountUsdc: 1,
    fetchImpl: async () => jsonResponse(402, { error: 'Payment Required' }, { 'payment-required': requirementsHeader([GATEWAY_BASE]) }),
  })
  assert.equal(gatewayOnly.ok, false)
  assert.equal(gatewayOnly.reason, 'no_supported_accept')

  const rejected = await payWithWallet({
    resource: 'https://api.exa.ai/search',
    maxAmountUsdc: 1,
    fetchImpl: async (_url, init) => (init.headers['PAYMENT-SIGNATURE']
      ? jsonResponse(402, { error: 'insufficient_funds' })
      : jsonResponse(402, { error: 'Payment Required' }, { 'payment-required': requirementsHeader([VANILLA_BASE]) })),
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'payment_rejected')
  assert.match(rejected.error, /insufficient_funds/)

  const noRequirements = await payWithWallet({ resource: 'https://api.x/y', fetchImpl: async () => jsonResponse(402, { error: 'nope' }) })
  assert.equal(noRequirements.reason, 'payment_requirements_missing')
})

test('without a key the payer refuses before touching the network', async () => {
  delete process.env.X402_MARKETPLACE_PAYER_PRIVATE_KEY
  let calls = 0
  const result = await payWithWallet({ resource: 'https://api.exa.ai/search', fetchImpl: async () => { calls += 1; return jsonResponse(200, {}) } })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'payer_private_key_missing')
  assert.equal(calls, 0)
  process.env.X402_MARKETPLACE_PAYER_PRIVATE_KEY = TEST_KEY
})
