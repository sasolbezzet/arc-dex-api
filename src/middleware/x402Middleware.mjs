import { randomUUID } from 'crypto'
import { createPublicClient, decodeEventLog, defineChain, erc20Abi, getAddress, http, parseUnits } from 'viem'

const payments = globalThis.__arcoxX402Payments || new Map()
globalThis.__arcoxX402Payments = payments

const usedTxHashes = globalThis.__arcoxX402UsedTxHashes || new Set()
globalThis.__arcoxX402UsedTxHashes = usedTxHashes

export function priceFromEnv(name, fallback) {
  return String(process.env[name] || fallback)
}

export function x402Config() {
  return {
    enabled: String(process.env.X402_ENABLED || 'true').toLowerCase() === 'true',
    verifyPayment: String(process.env.X402_VERIFY_PAYMENT || 'false').toLowerCase() === 'true',
    network: process.env.X402_NETWORK || 'arc-testnet',
    chainId: Number(process.env.X402_CHAIN_ID || process.env.ARC_CHAIN_ID || 5042002),
    asset: process.env.X402_ASSET || 'USDC',
    tokenAddress: process.env.X402_USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
    recipient: process.env.X402_RECIPIENT_ADDRESS || '',
    rpcUrl: process.env.ARC_RPC_URL || process.env.RPC || 'https://rpc.testnet.arc.network/',
    expiresInSeconds: Number(process.env.X402_PAYMENT_EXPIRY_SECONDS || 300),
  }
}

export function createX402PaymentRequest(input = {}) {
  const cfg = x402Config()
  const amount = String(input.amount || process.env.X402_DEFAULT_PRICE_USDC || '0.01')
  const resource = String(input.resource || '/api/intel')
  const paymentId = input.paymentId || `x402_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  const now = Date.now()
  const request = {
    service: input.service || 'arcox_intel',
    paymentId,
    nonce: paymentId,
    amount,
    asset: cfg.asset,
    network: cfg.network,
    chainId: cfg.chainId,
    tokenAddress: cfg.tokenAddress,
    recipient: cfg.recipient,
    resource,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + cfg.expiresInSeconds * 1000).toISOString(),
    expiresInSeconds: cfg.expiresInSeconds,
    verifyPayment: cfg.verifyPayment,
    mockMode: !cfg.verifyPayment,
  }
  payments.set(paymentId, request)
  return request
}

export function getX402PaymentRequest(paymentId) {
  const item = payments.get(String(paymentId || ''))
  if (!item) return null
  if (item.status === 'pending' && Date.now() > Date.parse(item.expiresAt)) {
    item.status = 'expired'
    item.updatedAt = new Date().toISOString()
    payments.set(item.paymentId, item)
  }
  return item
}

export async function verifyX402Payment({ paymentId, txHash, payerAddress }) {
  const request = getX402PaymentRequest(paymentId)
  if (!request) return { ok: false, error: 'Unknown x402 paymentId' }
  if (request.status === 'expired') return { ok: false, error: 'x402 payment expired', payment: request }
  if (request.status === 'used') return { ok: false, error: 'x402 payment already used', payment: request }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) return { ok: false, error: 'Invalid x402 txHash', payment: request }
  const hash = String(txHash).toLowerCase()
  if (usedTxHashes.has(hash)) return { ok: false, error: 'x402 txHash already used', payment: request }

  const cfg = x402Config()
  if (Number(request.chainId) !== Number(cfg.chainId)) return { ok: false, error: 'Invalid x402 chain', payment: request }
  if (getAddress(request.tokenAddress) !== getAddress(cfg.tokenAddress)) return { ok: false, error: 'Invalid x402 asset', payment: request }
  if (getAddress(request.recipient) !== getAddress(cfg.recipient)) return { ok: false, error: 'Invalid x402 recipient', payment: request }

  const chain = defineChain({
    id: cfg.chainId,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  })
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl, { retryCount: 2, timeout: 12000 }) })
  const chainId = await client.getChainId()
  if (Number(chainId) !== Number(cfg.chainId)) return { ok: false, error: 'Invalid RPC chain', payment: request }

  const receipt = await client.getTransactionReceipt({ hash: txHash })
  if (!receipt) return { ok: false, error: 'Transaction not found', payment: request }
  if (receipt.status !== 'success') return { ok: false, error: 'x402 transaction reverted', payment: request }

  const required = parseUnits(request.amount, 6)
  let matched = null
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(request.tokenAddress).toLowerCase()) continue
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics })
      if (decoded.eventName !== 'Transfer') continue
      const from = getAddress(decoded.args.from)
      const to = getAddress(decoded.args.to)
      const value = BigInt(decoded.args.value)
      if (to !== getAddress(request.recipient)) continue
      if (payerAddress && from !== getAddress(payerAddress)) continue
      if (value < required) return { ok: false, error: 'Insufficient x402 payment amount', payment: request }
      matched = { from, to, value: value.toString() }
      break
    } catch {}
  }
  if (!matched) return { ok: false, error: 'No matching USDC Transfer event found', payment: request }

  const paid = {
    ...request,
    status: 'paid',
    txHash,
    payerAddress: matched.from,
    paidAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  payments.set(request.paymentId, paid)
  usedTxHashes.add(hash)
  return { ok: true, payment: paid }
}

export function withArcoxX402(handler, config = {}) {
  return async (req, res, next) => {
    if (String(process.env.ARCOX_INTEL_ENABLED || 'true').toLowerCase() === 'false') {
      return res.status(503).json({ error: 'ARCOX Intel is disabled' })
    }
    const cfg = x402Config()
    if (!cfg.enabled) return handler(req, res, next)

    const resource = String(config.resource || req.originalUrl || req.path)
    const paymentId = String(req.headers['x-payment-id'] || req.headers['x-arcox-payment-request-id'] || req.query?.paymentId || '')
    const txHash = String(req.headers['x-payment-tx'] || req.headers['x-arcox-payment-tx'] || req.query?.paymentTx || '')
    const mockPaid = String(req.headers['x-payment'] || '').toLowerCase() === 'mock-paid'

    if (mockPaid && !cfg.verifyPayment) {
      req.arcoxX402 = { mode: 'mock-paid' }
      return handler(req, res, next)
    }

    if (paymentId && txHash) {
      const payment = getX402PaymentRequest(paymentId)
      if (payment?.status === 'paid' && String(payment.txHash).toLowerCase() === txHash.toLowerCase() && payment.resource === resource) {
        payments.set(paymentId, { ...payment, status: 'used', usedAt: new Date().toISOString() })
        req.arcoxX402 = { mode: 'real-testnet', payment }
        return handler(req, res, next)
      }
      if (payment && payment.resource !== resource) {
        return res.status(402).json({ error: 'x402 payment resource mismatch', x402: createX402PaymentRequest({ ...config, resource }) })
      }
    }

    const request = createX402PaymentRequest({
      service: config.service || 'arcox_intel',
      amount: priceFromEnv(config.priceEnv || '', config.amount || process.env.X402_DEFAULT_PRICE_USDC || '0.01'),
      resource,
    })
    if (!request.recipient || !/^0x[0-9a-fA-F]{40}$/.test(request.recipient)) {
      request.recipient = 'configure_X402_RECIPIENT_ADDRESS'
    }
    return res.status(402).json({ error: 'Payment Required', x402: request })
  }
}
