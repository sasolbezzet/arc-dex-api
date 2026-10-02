// x402 buyer for an agent's own MSCA.
//
// Every ARCOX agent wallet is a Circle modular smart account (MSCA). x402
// settlement is signature-based, so a contract account can only settle where
// the verifier accepts an ERC-1271 contract signature. Probed on Arc mainnet:
//   - the vanilla `exact` rail works: Arc USDC's
//     `transferWithAuthorization(..., bytes signature)` overload validates via
//     isValidSignature, and Circle's modular SDK produces exactly that
//     signature from the wallet's session key;
//   - Circle's Gateway facilitator verifies ECDSA only, so `gateway` accepts
//     are refused here instead of failing after the buyer already paid;
//   - Permit2 and Solana accepts need allowances/other signers and stay out of
//     scope.
// The payer address is the wallet that pays, not a platform key: the agent
// funds its own purchase and ARCOX only adds its fee as a separate invoice.
import { randomBytes } from 'crypto'
import { getAddress } from 'viem'
import { acceptRail, chainInfo } from './x402Marketplace.mjs'

// MSCA-supported chains per Arc network config (mainnet scope today). The
// network id is what a seller must accept before an MSCA on that chain can pay.
export const MSCA_CHAIN_NETWORKS = {
  'arc-mainnet': 'eip155:5042',
  'base-mainnet': 'eip155:8453',
  'arbitrum-mainnet': 'eip155:42161',
  'arc-testnet': 'eip155:5042',
  'base-sepolia': 'eip155:84532',
  'arbitrum-sepolia': 'eip155:421614',
}

export function mscaNetworkForChainKey(chainKey) {
  return MSCA_CHAIN_NETWORKS[String(chainKey || '')] || ''
}

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/** Rows this payer can settle; the marketplace labels quotes with it. */
export function mscaPayerRails() {
  return ['vanilla']
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
 * Pick an accept an MSCA can actually settle with an ERC-1271 signature: the
 * vanilla EIP-3009 rail, on a chain with a known chainId, at or below the price
 * cap the buyer approved.
 */
export function selectMscaAccept(accepts, { chain = '', network = '', maxAmountUsdc, payerAddress = '' } = {}) {
  const cap = Number(maxAmountUsdc)
  const capBaseUnits = Number.isFinite(cap) && cap > 0 ? BigInt(Math.round(cap * 1e6)) : null
  const wantedChain = String(chain || '').toUpperCase()
  const wantedNetwork = String(network || '').toLowerCase()
  const candidates = (Array.isArray(accepts) ? accepts : [])
    .map(accept => ({ accept, chain: chainInfo(accept?.network) }))
    .filter(({ accept, chain: info }) => accept
      && String(accept.scheme || '').toLowerCase() === 'exact'
      && Number.isInteger(info.evmChainId)
      // The Agent Wallet only exists on MSCA-supported chains; paying from a
      // wallet that is not deployed on the seller's chain can never settle.
      && info.mscaChain
      && acceptRail(accept) === 'vanilla'
      && accept.extra?.name && accept.extra?.version
      && accept.payTo && accept.asset
      && (capBaseUnits === null || BigInt(String(accept.amount)) <= capBaseUnits))
    .filter(({ accept }) => !payerAddress || getAddress(accept.payTo) !== getAddress(payerAddress))
  if (!candidates.length) return null
  const preferred = wantedNetwork
    ? candidates.find(({ accept }) => String(accept.network).toLowerCase() === wantedNetwork)
    : wantedChain
      ? candidates.find(({ chain: info }) => String(info.cliChain || '').toUpperCase() === wantedChain || info.label.toUpperCase() === wantedChain)
      : null
  // A specific network is a hard requirement (that is where the payer lives);
  // without one, the cheapest settleable accept wins.
  if (wantedNetwork) return preferred ? { accept: preferred.accept, chain: preferred.chain } : null
  const chosen = preferred || candidates.sort((a, b) => Number(a.accept.amount) - Number(b.accept.amount))[0]
  return { accept: chosen.accept, chain: chosen.chain }
}

/**
 * EIP-3009 authorization for the MSCA. The window only needs to cover
 * settlement by the seller's facilitator, so it is clamped up from the
 * seller-published timeout instead of signing a seven-day Gateway window.
 */
export function buildEip3009Authorization({ payerAddress, accept, now = Date.now(), windowSeconds } = {}) {
  const seconds = Math.floor(now / 1000)
  const timeout = Math.max(Number(accept?.maxTimeoutSeconds || 0), Number(windowSeconds || 0), 300)
  return {
    from: getAddress(payerAddress),
    to: getAddress(accept.payTo),
    value: String(accept.amount),
    validAfter: String(seconds - 600),
    validBefore: String(seconds + timeout),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
}

/**
 * EIP-712 domain for the accept's EIP-3009 signature. `extra` is the seller's
 * own domain: Arc USDC advertises name "USDC" / version "2", Ethereum USDC
 * publishes "USD Coin". The token contract is the verifying contract.
 */
export function eip3009Domain(accept) {
  const info = chainInfo(accept?.network)
  if (!Number.isInteger(info.evmChainId)) throw new Error('accept network has no EVM chainId')
  if (!accept?.extra?.name || !accept?.extra?.version) throw new Error('accept is missing the EIP-712 domain')
  return {
    name: String(accept.extra.name),
    version: String(accept.extra.version),
    chainId: info.evmChainId,
    verifyingContract: getAddress(accept.asset),
  }
}

export function encodePaymentSignatureHeader({ accept, authorization, signature, resource }) {
  const payload = {
    x402Version: 2,
    ...(resource ? { resource: { url: resource } } : {}),
    accepted: accept,
    payload: { authorization, signature },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

/** The seller's settlement receipt, when the facilitator reports one. */
export function parsePaymentResponse(response) {
  const header = typeof response?.headers?.get === 'function'
    ? (response.headers.get('payment-response') || response.headers.get('x-payment-response') || '')
    : ''
  if (!header) return null
  try {
    const decoded = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8'))
    return decoded && typeof decoded === 'object' ? decoded : null
  } catch { return null }
}

/**
 * Compare the seller's live requirements with the accept the buyer approved.
 * The locked terms (asset, payTo, amount, rail, network) must survive; a
 * changed price becomes a refund-review outcome instead of an overpay.
 */
export function acceptMatchesSnapshot(freshAccept, snapshot) {
  if (!freshAccept || !snapshot) return false
  if (String(freshAccept.network) !== String(snapshot.network)) return false
  if (getAddress(freshAccept.asset) !== getAddress(snapshot.asset)) return false
  if (getAddress(freshAccept.payTo) !== getAddress(snapshot.payTo)) return false
  if (BigInt(String(freshAccept.amount)) !== BigInt(String(snapshot.amount))) return false
  if (String(freshAccept.extra?.name || '') !== String(snapshot.extra?.name || '')) return false
  return acceptRail(freshAccept) === 'vanilla'
}

/**
 * Pay a provider from the buying agent's MSCA. Returns the provider payload on
 * success and a bounded reason on failure so the caller can mark the invoice
 * for refund review instead of losing the buyer's fee silently.
 */
export async function payFromMsca({
  resource, method = 'GET', data, headers = {}, payerMsca, chainKey = '',
  acceptSnapshot, maxAmountUsdc, timeoutMs,
  fetchImpl = globalThis.fetch, signer, balanceReader,
} = {}) {
  const payer = String(payerMsca || '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(payer)) return { ok: false, reason: 'msca_payer_missing' }
  const network = mscaNetworkForChainKey(chainKey)
  const cap = Number(maxAmountUsdc)
  const capBaseUnits = Number.isFinite(cap) && cap > 0 ? BigInt(Math.round(cap * 1e6)) : null
  const timeout = Number(timeoutMs || process.env.X402_MARKETPLACE_PAY_TIMEOUT_MS || 120_000)

  const requestInit = {
    method,
    headers: { accept: 'application/json', ...(data !== undefined && data !== null && data !== '' ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(data !== undefined && data !== null && data !== '' ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}),
  }
  const unpaid = await fetchImpl(resource, { ...requestInit, signal: AbortSignal.timeout(timeout) })
  if (unpaid.status !== 402) {
    return {
      ok: false,
      reason: unpaid.ok ? 'provider_did_not_require_payment' : `upstream_http_${unpaid.status}`,
      status: unpaid.status,
      providerPayload: await readJson(unpaid),
    }
  }

  const requirements = parsePaymentRequired({ headers: unpaid.headers, body: await readJson(unpaid) })
  if (!requirements) return { ok: false, reason: 'payment_requirements_missing' }
  const selected = selectMscaAccept(requirements.accepts, { network, maxAmountUsdc: cap, payerAddress: payer })
  if (!selected) {
    // Distinguish "this seller cannot be paid from an MSCA at all" from "this
    // seller got more expensive than the buyer approved" — the fee refund
    // review reads differently for each.
    const withoutCap = selectMscaAccept(requirements.accepts, { network, payerAddress: payer })
    return withoutCap
      ? { ok: false, reason: 'upstream_price_above_cap', error: `provider asks ${withoutCap.accept.amount} base units above the approved ${cap} USDC cap` }
      : { ok: false, reason: 'no_supported_accept', detail: 'no vanilla EIP-3009 accept on a chain this MSCA can pay from' }
  }
  const accept = selected.accept
  if (acceptSnapshot && !acceptMatchesSnapshot(accept, acceptSnapshot)) {
    return { ok: false, reason: 'provider_requirements_changed' }
  }

  if (balanceReader) {
    const balance = await balanceReader(chainKey, payer).catch(() => null)
    if (balance !== null && balance !== undefined && BigInt(balance) < BigInt(String(accept.amount))) {
      return { ok: false, reason: 'insufficient_msca_balance', balance: String(balance), required: String(accept.amount) }
    }
  }

  const authorization = buildEip3009Authorization({ payerAddress: payer, accept })
  const domain = eip3009Domain(accept)
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  }
  const signTypedData = signer || (await import('./sessionKeyService.mjs')).signTypedDataWithSession
  const signature = await signTypedData(payer, { domain, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message }, { chainKey })

  const paid = await fetchImpl(resource, {
    ...requestInit,
    headers: {
      ...requestInit.headers,
      'PAYMENT-SIGNATURE': encodePaymentSignatureHeader({ accept, authorization, signature, resource }),
    },
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

  const receipt = parsePaymentResponse(paid)
  return {
    ok: true,
    status: paid.status,
    providerPayload: payload,
    settlement: {
      network: accept.network,
      chain: selected.chain.label,
      amountUsdc: `${BigInt(String(accept.amount)) / 1_000_000n}.${String(BigInt(String(accept.amount)) % 1_000_000n).padStart(6, '0')}`,
      payTo: accept.payTo,
      payer,
      txHash: String(receipt?.transaction || receipt?.txHash || ''),
      facilitator: receipt ? String(receipt.success === false ? 'reported_failure' : 'reported_success') : 'unknown',
      paymentResponse: receipt,
    },
  }
}

async function readJson(response) {
  try { return await response.json() } catch { return null }
}
