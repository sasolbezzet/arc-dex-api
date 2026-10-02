// x402 buyer for ARCOX's own wallet.
//
// The Circle CLI can pay any x402 seller, but it needs its own funded agent
// wallet. This module pays a provider directly from an ARCOX-controlled EOA
// instead, so upstream settlement comes out of the same wallet that already
// holds ARCOX funds and the platform fee stays with the x402 treasury.
//
// Scope: the vanilla `exact` scheme on EVM (EIP-3009 transferWithAuthorization,
// signed with `X402_MARKETPLACE_PAYER_PRIVATE_KEY`). Circle-Gateway sellers
// (`GatewayWalletBatched`) are not settled here — those still go through the CLI
// executor, because the batch scheme needs Circle's Gateway facilitator.
//
// Protocol shape follows x402 v2: the 402 response carries a base64
// `PAYMENT-REQUIRED` header (or a v1 JSON body), and the paid retry carries a
// base64 `PAYMENT-SIGNATURE` header holding
// `{ x402Version: 2, accepted, payload: { authorization, signature } }`.
import { randomBytes } from 'crypto'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { acceptRail, chainInfo } from './x402Marketplace.mjs'

export const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

function normalizeKey(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  return value.startsWith('0x') ? value : `0x${value}`
}

export function walletPayerConfig() {
  const privateKey = normalizeKey(process.env.X402_MARKETPLACE_PAYER_PRIVATE_KEY)
  const configured = /^0x[0-9a-fA-F]{64}$/.test(privateKey)
  return {
    privateKey,
    configured,
    address: configured ? privateKeyToAccount(privateKey).address : '',
    maxUpstreamUsdc: Number(process.env.X402_MARKETPLACE_MAX_UPSTREAM_USDC || 5),
    timeoutMs: Number(process.env.X402_MARKETPLACE_PAY_TIMEOUT_MS || 120_000),
  }
}

/** What the executor reports: mode, payer address, and why it cannot pay. */
export function walletPayerStatus() {
  const config = walletPayerConfig()
  return {
    mode: 'wallet',
    configured: config.configured,
    payerAddress: config.address,
    problems: config.configured ? [] : ['payer_private_key_missing'],
    hint: config.configured
      ? ''
      : 'Set X402_MARKETPLACE_PAYER_PRIVATE_KEY (and fund that address with USDC on the seller chain) to settle providers from the ARCOX wallet.',
  }
}

/** Read the payment requirements out of a 402 response (header first, then body). */
export function parsePaymentRequired(response) {
  const header = typeof response?.headers?.get === 'function' ? response.headers.get('payment-required') : ''
  if (header) {
    try {
      const decoded = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))
      if (decoded?.accepts?.length) return decoded
    } catch { /* fall through to the body */ }
  }
  const body = response?.body
  if (body && typeof body === 'object') {
    if (Array.isArray(body.accepts) && body.accepts.length) return body
    if (Array.isArray(body.x402?.accepts) && body.x402.accepts.length) return body.x402
  }
  return null
}

/**
 * Pick the accept ARCOX can actually settle: the vanilla EIP-3009 exact scheme,
 * on a chain with a known chainId, at or below the price cap.
 */
export function selectWalletAccept(accepts, { chain = '', maxAmountUsdc, payerAddress = '' } = {}) {
  const cap = Number(maxAmountUsdc)
  // Accept amounts are USDC base units (6 decimals); the caller's cap is a
  // USDC amount, so convert once instead of comparing the two scales.
  const capBaseUnits = Number.isFinite(cap) && cap > 0 ? BigInt(Math.round(cap * 1e6)) : null
  const wanted = String(chain || '').toUpperCase()
  const candidates = (Array.isArray(accepts) ? accepts : [])
    .map(accept => ({ accept, chain: chainInfo(accept?.network) }))
    .filter(({ accept, chain: info }) => accept
      && String(accept.scheme || '').toLowerCase() === 'exact'
      && Number.isInteger(info.evmChainId)
      // Only the vanilla EIP-3009 rail: Gateway batches are signed against
      // Circle's Gateway domain and Permit2 needs an allowance we do not hold.
      && acceptRail(accept) === 'vanilla'
      && (accept.extra?.assetTransferMethod === undefined || accept.extra?.assetTransferMethod === 'eip3009')
      && accept.extra?.name && accept.extra?.version
      && accept.payTo && accept.asset
      && (capBaseUnits === null || BigInt(String(accept.amount)) <= capBaseUnits))
    .filter(({ accept }) => !payerAddress || getAddress(accept.payTo) !== getAddress(payerAddress))
  if (!candidates.length) return null
  const preferred = wanted
    ? candidates.find(({ chain: info }) => String(info.cliChain || '').toUpperCase() === wanted || info.label.toUpperCase() === wanted)
    : null
  const chosen = preferred || candidates.sort((a, b) => Number(a.accept.amount) - Number(b.accept.amount))[0]
  return { accept: chosen.accept, chain: chosen.chain }
}

export function buildEip3009Authorization({ payerAddress, accept, now = Date.now() }) {
  const seconds = Math.floor(now / 1000)
  const timeout = Number(accept.maxTimeoutSeconds || 300)
  return {
    from: getAddress(payerAddress),
    to: getAddress(accept.payTo),
    value: String(accept.amount),
    validAfter: String(seconds - 600),
    validBefore: String(seconds + timeout),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
}

export async function signExactPayment({ signer, accept, authorization }) {
  return signer.signTypedData({
    domain: {
      name: String(accept.extra.name),
      version: String(accept.extra.version),
      chainId: Number(chainInfo(accept.network).evmChainId),
      verifyingContract: getAddress(accept.asset),
    },
    types: AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  })
}

export function encodePaymentSignatureHeader({ accept, authorization, signature, resource }) {
  const payload = {
    x402Version: 2,
    ...(resource ? { resource: { url: resource, mimeType: 'application/json' } } : {}),
    accepted: accept,
    payload: { authorization, signature },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

/**
 * Pay a provider with the ARCOX wallet. Returns the provider's response body on
 * success and a bounded reason on failure so the caller can mark the invoice for
 * refund review instead of losing the buyer's payment silently.
 */
export async function payWithWallet({
  resource, method = 'GET', data, headers = {}, chain = '', maxAmountUsdc, fetchImpl = globalThis.fetch, signer, timeoutMs,
} = {}) {
  const config = walletPayerConfig()
  if (!signer && !config.configured) return { ok: false, reason: 'payer_private_key_missing' }
  const account = signer || privateKeyToAccount(config.privateKey)
  const cap = Number.isFinite(Number(maxAmountUsdc)) && Number(maxAmountUsdc) > 0
    ? Number(maxAmountUsdc)
    : config.maxUpstreamUsdc

  const requestInit = {
    method,
    headers: { accept: 'application/json', ...(data !== undefined && data !== null && data !== '' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data !== undefined && data !== null && data !== '' ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
  }
  const timeout = Number(timeoutMs || config.timeoutMs)
  const unpaid = await fetchImpl(resource, { ...requestInit, signal: AbortSignal.timeout(timeout) })
  if (unpaid.status !== 402) {
    return { ok: unpaid.ok, reason: unpaid.ok ? '' : `upstream_http_${unpaid.status}`, status: unpaid.status, providerPayload: await readJson(unpaid) }
  }

  const requirements = parsePaymentRequired({ headers: unpaid.headers, body: await readJson(unpaid) })
  if (!requirements) return { ok: false, reason: 'payment_requirements_missing' }
  const selected = selectWalletAccept(requirements.accepts, { chain, maxAmountUsdc: cap, payerAddress: account.address })
  if (!selected) return { ok: false, reason: 'no_supported_accept' }

  const authorization = buildEip3009Authorization({ payerAddress: account.address, accept: selected.accept })
  const signature = await signExactPayment({ signer: account, accept: selected.accept, authorization })
  const paid = await fetchImpl(resource, {
    ...requestInit,
    headers: { ...requestInit.headers, 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ accept: selected.accept, authorization, signature, resource }) },
    signal: AbortSignal.timeout(timeout),
  })
  const payload = await readJson(paid)
  if (!paid.ok) {
    return {
      ok: false,
      reason: paid.status === 402 ? 'payment_rejected' : `upstream_http_${paid.status}`,
      status: paid.status,
      error: String(payload?.error || payload?.message || `provider returned HTTP ${paid.status}`).slice(0, 300),
      providerPayload: payload,
    }
  }
  return {
    ok: true,
    status: paid.status,
    providerPayload: payload,
    settlement: {
      network: selected.accept.network,
      chain: selected.chain.label,
      amountUsdc: `${BigInt(String(selected.accept.amount)) / 1_000_000n}.${String(BigInt(String(selected.accept.amount)) % 1_000_000n).padStart(6, '0')}`,
      payTo: selected.accept.payTo,
      payer: account.address,
      paymentResponse: paid.headers?.get?.('payment-response') || paid.headers?.get?.('x-payment-response') || '',
    },
  }
}

async function readJson(response) {
  try { return await response.json() } catch { return null }
}
