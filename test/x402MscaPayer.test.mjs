import test from 'node:test'
import assert from 'node:assert/strict'

// The MSCA payer is the money path for marketplace purchases: the buying
// agent's own Agent Wallet signs an EIP-3009 authorization that the seller
// settles via ERC-1271. These tests pin the accept selection (vanilla only),
// the signed terms, and every refusal path that precedes a refund.
const {
  selectMscaAccept, buildEip3009Authorization, eip3009Domain, encodePaymentSignatureHeader,
  acceptMatchesSnapshot, parsePaymentRequired, mscaNetworkForChainKey, payFromMsca,
} = await import('../src/services/x402MscaPayer.mjs')

const PAYER = '0xC9796A7C3c5205b0f05fE2A070003cDFfadAE331'
const USDC_ARC = '0x3600000000000000000000000000000000000000'
const PAY_TO = '0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC'
const VANILLA = {
  scheme: 'exact', network: 'eip155:5042', asset: USDC_ARC, payTo: PAY_TO,
  amount: '7000', maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
}
const GATEWAY = {
  ...VANILLA, extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee' },
}

test('only vanilla EIP-3009 accepts on MSCA chains are selectable', () => {
  assert.equal(selectMscaAccept([GATEWAY], { network: 'eip155:5042' }), null)
  const selected = selectMscaAccept([GATEWAY, VANILLA], { network: 'eip155:5042' })
  assert.equal(selected.accept.amount, '7000')
  assert.equal(selected.chain.label, 'Arc')

  // An accept on a chain without an Agent Wallet is not payable from one, and
  // the payer's own chain stays a hard requirement.
  const polygon = { ...VANILLA, network: 'eip155:137' }
  assert.equal(selectMscaAccept([polygon], { network: 'eip155:137' }), null)
  const baseMainnet = { ...VANILLA, network: 'eip155:8453' }
  assert.equal(selectMscaAccept([baseMainnet], { network: 'eip155:5042' }), null)
  assert.ok(selectMscaAccept([baseMainnet], { network: 'eip155:8453' }))

  // The payer never pays itself, and the cap is a hard bound.
  assert.equal(selectMscaAccept([{ ...VANILLA, payTo: PAYER }], { network: 'eip155:5042', payerAddress: PAYER }), null)
  assert.equal(selectMscaAccept([VANILLA], { network: 'eip155:5042', maxAmountUsdc: 0.001 }), null)
  assert.ok(selectMscaAccept([VANILLA], { network: 'eip155:5042', maxAmountUsdc: 0.01 }))
})

test('the signed authorization uses the seller domain and a settlement-sized window', () => {
  const authorization = buildEip3009Authorization({ payerAddress: PAYER, accept: VANILLA, now: 1_700_000_000_000 })
  assert.equal(authorization.from, PAYER)
  assert.equal(authorization.to, PAY_TO)
  assert.equal(authorization.value, '7000')
  assert.match(authorization.nonce, /^0x[0-9a-f]{64}$/)
  const window = Number(authorization.validBefore) - Number(authorization.validAfter)
  assert.ok(window >= 300, 'window must cover facilitator settlement')

  assert.deepEqual(eip3009Domain(VANILLA), { name: 'USDC', version: '2', chainId: 5042, verifyingContract: USDC_ARC })
  assert.throws(() => eip3009Domain({ ...VANILLA, extra: null }), /EIP-712 domain/)
  assert.equal(mscaNetworkForChainKey('arc-mainnet'), 'eip155:5042')
  assert.equal(mscaNetworkForChainKey('polygon-mainnet'), '')
})

test('the payment header carries the full x402 payload the seller will verify', () => {
  const authorization = buildEip3009Authorization({ payerAddress: PAYER, accept: VANILLA })
  const header = encodePaymentSignatureHeader({ accept: VANILLA, authorization, signature: '0x' + 'ab'.repeat(65), resource: 'https://api.exa.ai/search' })
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  assert.equal(decoded.x402Version, 2)
  assert.deepEqual(decoded.accepted, VANILLA)
  assert.equal(decoded.resource.url, 'https://api.exa.ai/search')
  assert.deepEqual(decoded.payload.authorization, authorization)
  assert.match(decoded.payload.signature, /^0xab/)
})

test('the quoted terms are locked: a changed price or payee is detected', () => {
  assert.equal(acceptMatchesSnapshot(VANILLA, VANILLA), true)
  assert.equal(acceptMatchesSnapshot({ ...VANILLA, amount: '8000' }, VANILLA), false)
  assert.equal(acceptMatchesSnapshot({ ...VANILLA, payTo: PAYER }, VANILLA), false)
  assert.equal(acceptMatchesSnapshot(GATEWAY, VANILLA), false)
})

function paymentRequiredResponse(accepts) {
  return {
    status: 402, ok: false,
    headers: new Headers({ 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString('base64') }),
    json: async () => ({}),
  }
}

test('a successful MSCA payment signs with the session wallet and returns the seller settlement', async () => {
  const requests = []
  const signed = []
  const fetchImpl = async (url, init) => {
    requests.push(init)
    if (init.headers['PAYMENT-SIGNATURE']) {
      return {
        status: 200, ok: true,
        headers: new Headers({ 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: '0xdead', network: 'eip155:5042', payer: PAYER })).toString('base64') }),
        json: async () => ({ results: [{ title: 'arc' }] }),
      }
    }
    return paymentRequiredResponse([GATEWAY, VANILLA])
  }
  const result = await payFromMsca({
    resource: 'https://api.exa.ai/search', method: 'POST', data: { query: 'x' },
    payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.007,
    fetchImpl, balanceReader: async () => 10_000n,
    signer: async (address, typedData, options) => {
      signed.push({ address, typedData, options })
      return '0x' + 'cd'.repeat(65)
    },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.providerPayload, { results: [{ title: 'arc' }] })
  assert.equal(result.settlement.payer, PAYER)
  assert.equal(result.settlement.txHash, '0xdead')
  assert.equal(result.settlement.chain, 'Arc')
  assert.equal(result.settlement.amountUsdc, '0.007000')

  assert.equal(signed.length, 1)
  assert.equal(signed[0].address, PAYER)
  assert.equal(signed[0].options.chainKey, 'arc-mainnet')
  assert.deepEqual(signed[0].typedData.domain, { name: 'USDC', version: '2', chainId: 5042, verifyingContract: USDC_ARC })
  assert.equal(signed[0].typedData.types.TransferWithAuthorization.length, 6)
  assert.equal(signed[0].typedData.message.value, 7000n)

  assert.equal(requests.length, 2)
  const header = JSON.parse(Buffer.from(requests[1].headers['PAYMENT-SIGNATURE'], 'base64').toString('utf8'))
  assert.equal(header.payload.authorization.from, PAYER)
  assert.equal(header.accepted.payTo, PAY_TO)
})

test('an empty Agent Wallet fails before signing anything', async () => {
  const result = await payFromMsca({
    resource: 'https://api.exa.ai/search', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.007,
    fetchImpl: async () => paymentRequiredResponse([VANILLA]),
    balanceReader: async () => 1n,
    signer: async () => { throw new Error('must not sign') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'insufficient_msca_balance')
})

test('seller terms that changed after the quote are refused instead of overpaying', async () => {
  const result = await payFromMsca({
    resource: 'https://api.exa.ai/search', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.01,
    acceptSnapshot: VANILLA,
    fetchImpl: async () => paymentRequiredResponse([{ ...VANILLA, amount: '9000' }]),
    signer: async () => { throw new Error('must not sign') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'provider_requirements_changed')
})

test('gateway-only sellers are refused up front, and over-cap prices are named', async () => {
  const gatewayOnly = await payFromMsca({
    resource: 'https://api.aisa.one/apis/v2/agentmail/domains', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 1,
    fetchImpl: async () => paymentRequiredResponse([GATEWAY]),
    signer: async () => { throw new Error('must not sign') },
  })
  assert.equal(gatewayOnly.ok, false)
  assert.equal(gatewayOnly.reason, 'no_supported_accept')

  const overCap = await payFromMsca({
    resource: 'https://api.exa.ai/search', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.001,
    fetchImpl: async () => paymentRequiredResponse([VANILLA]),
    signer: async () => { throw new Error('must not sign') },
  })
  assert.equal(overCap.ok, false)
  assert.equal(overCap.reason, 'upstream_price_above_cap')
})

test('a free resource is not silently paid for, and a rejected payment is reported', async () => {
  const free = await payFromMsca({
    resource: 'https://api.exa.ai/search', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.01,
    fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({ free: true }) }),
  })
  assert.equal(free.ok, false)
  assert.equal(free.reason, 'provider_did_not_require_payment')

  let calls = 0
  const rejected = await payFromMsca({
    resource: 'https://api.exa.ai/search', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.01,
    fetchImpl: async (url, init) => {
      calls += 1
      if (init.headers['PAYMENT-SIGNATURE']) return { status: 402, ok: false, headers: new Headers(), json: async () => ({ error: 'invalid signature' }) }
      return paymentRequiredResponse([VANILLA])
    },
    signer: async () => '0x' + 'ef'.repeat(65),
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'payment_rejected')
  assert.match(rejected.error, /invalid signature/)
  assert.equal(calls, 2)
})

test('a malformed payer or missing 402 body is refused, not guessed at', async () => {
  const badPayer = await payFromMsca({ resource: 'https://api.exa.ai/search', payerMsca: 'not-an-address' })
  assert.equal(badPayer.reason, 'msca_payer_missing')

  const noRequirements = await payFromMsca({
    resource: 'https://api.exa.ai/search', payerMsca: PAYER, chainKey: 'arc-mainnet', maxAmountUsdc: 0.01,
    fetchImpl: async () => ({ status: 402, ok: false, headers: new Headers(), json: async () => ({}) }),
    signer: async () => { throw new Error('must not sign') },
  })
  assert.equal(noRequirements.reason, 'payment_requirements_missing')
  assert.equal(parsePaymentRequired({ headers: new Headers(), body: null }), null)
})
