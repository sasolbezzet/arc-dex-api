import { createPublicKey, randomUUID, verify as verifySignature } from 'crypto'
import { createPublicClient, http, parseAbiItem, formatUnits, keccak256, toHex, decodeEventLog } from 'viem'
import { atomicWriteJsonFile, readJsonFile } from '../services/jsonFileStore.mjs'
import { verifyAgentOwnership } from '../services/agentIdentityService.mjs'
import { buildAgentMemo, submitAgentMemoProof } from '../services/arcMemoService.mjs'
import { treasuryAddress } from '../config/treasury.mjs'

const invoices = globalThis.__arcoxX402Invoices || new Map()
globalThis.__arcoxX402Invoices = invoices

const webhookEvents = globalThis.__arcoxX402WebhookEvents || new Map()
globalThis.__arcoxX402WebhookEvents = webhookEvents

const unmatchedInboundEvents = globalThis.__arcoxX402UnmatchedInboundEvents || []
globalThis.__arcoxX402UnmatchedInboundEvents = unmatchedInboundEvents

let uniqueCounter = globalThis.__arcoxX402UniqueCounter || 0
const X402_INVOICE_DB = process.env.X402_INVOICE_DB || './x402-invoices-db.json'
const ARC_USDC = process.env.X402_USDC_ADDRESS || '0x3600000000000000000000000000000000000000'
const ARC_MEMO_CONTRACT = process.env.ARC_MEMO_CONTRACT || '0x5294E9927c3306DcBaDb03fe70b92e01cCede505'
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const MEMO_EVENT = parseAbiItem('event Memo(address indexed sender,address indexed target,bytes32 callDataHash,bytes32 indexed memoId,bytes memo,uint256 memoIndex)')
const OPEN_STATUSES = new Set(['created', 'payment_required', 'estimate_ready', 'awaiting_signature', 'spend_submitted', 'settlement_pending', 'recovery_required', 'pending'])
const CIRCLE_WEBHOOK_KEY_TTL_MS = 60 * 60 * 1000
const circleWebhookPublicKeys = globalThis.__arcoxCircleWebhookPublicKeys || new Map()
globalThis.__arcoxCircleWebhookPublicKeys = circleWebhookPublicKeys
let loadedPersistentInvoices = false

function loadPersistentInvoices() {
  if (loadedPersistentInvoices) return
  loadedPersistentInvoices = true
  try {
    const parsed = readJsonFile(X402_INVOICE_DB, [])
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {})
    for (const invoice of list) {
      if (!invoice?.invoiceId || !invoice?.paymentId) continue
      invoices.set(invoice.invoiceId, invoice)
      invoices.set(invoice.paymentId, invoice)
    }
  } catch (error) {
    console.error('[x402] failed to load invoice db', error?.message || error)
  }
}

function persistInvoices() {
  try {
    const unique = []
    const seen = new Set()
    for (const invoice of invoices.values()) {
      if (!invoice?.invoiceId || seen.has(invoice.invoiceId)) continue
      seen.add(invoice.invoiceId)
      unique.push(invoice)
    }
    unique.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    const retained = unique.slice(0, 1000)
    if (unique.length > retained.length) {
      invoices.clear()
      for (const invoice of retained) {
        invoices.set(invoice.invoiceId, invoice)
        invoices.set(invoice.paymentId, invoice)
      }
    }
    atomicWriteJsonFile(X402_INVOICE_DB, retained)
  } catch (error) {
    console.error('[x402] failed to persist invoice db', error?.message || error)
  }
}

export function priceFromEnv(name, fallback) {
  return String(process.env[name] || fallback)
}

export function x402Config() {
  return {
    enabled: String(process.env.X402_ENABLED || 'true').toLowerCase() === 'true',
    mode: process.env.X402_MODE || 'arc_real_testnet',
    baseAmount: String(process.env.X402_BASE_AMOUNT || process.env.X402_DEFAULT_PRICE_USDC || '0.005'),
    ttlSeconds: Number(process.env.X402_PAYMENT_TTL_SECONDS || process.env.X402_PAYMENT_EXPIRY_SECONDS || 300),
    asset: process.env.X402_ASSET || 'USDC',
    network: process.env.CIRCLE_X402_NETWORK || process.env.X402_NETWORK || 'arc-testnet',
    chainId: Number(process.env.X402_CHAIN_ID || process.env.ARC_CHAIN_ID || 5042002),
    usdcAddress: ARC_USDC,
    circleEnvironment: process.env.CIRCLE_ENV || 'testnet',
    circleBaseUrl: process.env.CIRCLE_BASE_URL || 'https://api-sandbox.circle.com',
    circleTreasuryWalletId: process.env.CIRCLE_X402_TREASURY_WALLET_ID || '',
    circleTreasuryAddress: treasuryAddress(),
    memoContract: ARC_MEMO_CONTRACT,
  }
}

function normalizeAmount(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid x402 amount')
  return n.toFixed(6)
}

function nextUniqueAmount(baseAmount) {
  uniqueCounter = (uniqueCounter % 999) + 1
  globalThis.__arcoxX402UniqueCounter = uniqueCounter
  const base = Number(normalizeAmount(baseAmount))
  return (base + uniqueCounter / 1_000_000).toFixed(6)
}

function amountToBaseUnits(value) {
  const normalized = normalizeAmount(value)
  const [whole, fraction = ''] = normalized.split('.')
  return `${BigInt(whole || '0') * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))}`
}

function isOpenStatus(status) {
  return OPEN_STATUSES.has(String(status || ''))
}

export function createX402Invoice(input = {}) {
  loadPersistentInvoices()
  const cfg = x402Config()
  const now = Date.now()
  const invoiceId = input.invoiceId || `arcox_x402_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const paymentId = input.paymentId || `x402_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const baseAmount = normalizeAmount(input.amount || cfg.baseAmount)
  const uniqueAmount = normalizeAmount(input.uniqueAmount || nextUniqueAmount(baseAmount))
  const agentId = /^\d+$/.test(String(input.agentId || '')) ? String(input.agentId) : ''
  const agentMemo = buildAgentMemo({ agentId, paymentId, requestId: input.requestId || paymentId, service: input.service || 'x402', amount: uniqueAmount, treasury: cfg.circleTreasuryAddress })
  const memoId = input.memoId || agentMemo?.memoId || keccak256(toHex(paymentId))
  const memoData = input.memoData || agentMemo?.memoData || toHex(JSON.stringify({ app: 'arcox', service: 'x402', paymentIdHash: keccak256(toHex(paymentId)) }))
  const invoice = {
    invoiceId,
    paymentId,
    agentId,
    ownerWallet: String(input.ownerWallet || '').toLowerCase(),
    service: input.service || 'arcox_intel',
    resource: String(input.resource || '/api/intel'),
    status: 'payment_required',
    asset: cfg.asset,
    network: cfg.network,
    chainId: cfg.chainId,
    usdcAddress: cfg.usdcAddress,
    circleEnvironment: cfg.circleEnvironment,
    circleTreasuryWalletId: cfg.circleTreasuryWalletId,
    recipient: cfg.circleTreasuryAddress,
    baseAmount,
    uniqueAmount,
    amount: uniqueAmount,
    amountBaseUnits: amountToBaseUnits(uniqueAmount),
    decimals: 6,
    memoContract: ARC_MEMO_CONTRACT,
    memoId,
    memoData,
    paymentMethod: 'arc-usdc-memo',
    paymentMethods: ['arc-usdc-memo', 'unified-balance-gateway'],
    settlementStatus: 'payment_required',
    route: {
      destination: 'Arc_Testnet',
      asset: 'USDC',
      directArc: true,
      unifiedBalance: true,
    },
    fee: {
      asset: 'USDC',
      amount: '0',
      note: 'No ARCOX x402 platform fee added to the invoice amount.',
    },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + cfg.ttlSeconds * 1000).toISOString(),
    expiresInSeconds: cfg.ttlSeconds,
  }
  invoices.set(invoiceId, invoice)
  invoices.set(paymentId, invoice)
  persistInvoices()
  return invoice
}

export function getX402Invoice(id) {
  loadPersistentInvoices()
  const invoice = invoices.get(String(id || ''))
  if (!invoice) return null
  if (isOpenStatus(invoice.status) && Date.now() > Date.parse(invoice.expiresAt)) {
    invoice.status = 'expired'
    invoice.settlementStatus = invoice.settlementStatus === 'settlement_pending' ? 'recovery_required' : 'expired'
    invoice.updatedAt = new Date().toISOString()
    invoices.set(invoice.invoiceId, invoice)
    invoices.set(invoice.paymentId, invoice)
    persistInvoices()
  }
  return invoice
}

export async function reconcileX402Invoice(id) {
  const invoice = getX402Invoice(id)
  if (!invoice || !isOpenStatus(invoice.status)) return invoice
  if (!invoice.recipient || !/^0x[0-9a-fA-F]{40}$/.test(invoice.recipient)) return invoice
  try {
    const gatewayMatch = await findFinalizedGatewayTransfer(invoice)
    if (gatewayMatch) {
      invoice.status = 'paid'
      invoice.settlementStatus = 'paid'
      invoice.txHash = gatewayMatch.transactionHash
      invoice.paidAt = new Date().toISOString()
      invoice.updatedAt = invoice.paidAt
      invoice.reconciledBy = 'circle-gateway-finalized-transfer'
      invoices.set(invoice.invoiceId, invoice)
      invoices.set(invoice.paymentId, invoice)
      persistInvoices()
      scheduleAgentMemoProof(invoice)
      return invoice
    }
    const rpc = process.env.ARC_RPC_URL || process.env.RPC || 'https://arc-testnet.drpc.org'
    const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 1 }) })
    const current = await client.getBlockNumber()
    const lookback = BigInt(Number(process.env.X402_RECONCILE_LOOKBACK_BLOCKS || '25000'))
    const fromBlock = current > lookback ? current - lookback : 0n
    const memoMatch = await findMemoPayment(client, invoice, fromBlock, current)
    if (memoMatch) {
      invoice.status = 'paid'
      invoice.settlementStatus = 'paid'
      invoice.txHash = memoMatch.transactionHash
      invoice.blockNumber = memoMatch.blockNumber
      invoice.paidAt = new Date().toISOString()
      invoice.updatedAt = invoice.paidAt
      invoice.reconciledBy = 'arc-transaction-memo'
      invoice.memoIndex = memoMatch.memoIndex
      invoice.memoSender = memoMatch.sender
      invoices.set(invoice.invoiceId, invoice)
      invoices.set(invoice.paymentId, invoice)
      persistInvoices()
      scheduleAgentMemoProof(invoice)
      return invoice
    }
    const logs = await client.getLogs({
      address: ARC_USDC,
      event: TRANSFER_EVENT,
      args: { to: invoice.recipient },
      fromBlock,
      toBlock: current,
    })
    const invoiceCreatedAt = Date.parse(invoice.createdAt || '')
    const amountMatches = logs
      .filter(log => formatUnits(log.args.value || 0n, 6) === normalizeAmount(invoice.uniqueAmount))
      .sort((a, b) => Number((b.blockNumber || 0n) - (a.blockNumber || 0n)))
    let match = null
    for (const log of amountMatches) {
      if (Number.isFinite(invoiceCreatedAt) && log.blockNumber) {
        const block = await client.getBlock({ blockNumber: log.blockNumber }).catch(() => null)
        const blockTimeMs = block?.timestamp ? Number(block.timestamp) * 1000 : 0
        if (blockTimeMs && blockTimeMs + 30_000 < invoiceCreatedAt) continue
      }
      match = log
      break
    }
    if (!match) return invoice
    invoice.status = 'paid'
    invoice.settlementStatus = 'paid'
    invoice.txHash = match.transactionHash
    invoice.blockNumber = String(match.blockNumber || '')
    invoice.paidAt = new Date().toISOString()
    invoice.updatedAt = invoice.paidAt
    invoice.reconciledBy = 'arc-usdc-transfer-log'
    invoices.set(invoice.invoiceId, invoice)
    invoices.set(invoice.paymentId, invoice)
    persistInvoices()
    scheduleAgentMemoProof(invoice)
    return invoice
  } catch (error) {
    console.error('[x402] reconcile failed', error?.message || error)
    return invoice
  }
}

export function publicInvoice(invoice) {
  if (!invoice) return null
  return {
    invoiceId: invoice.invoiceId,
    paymentId: invoice.paymentId,
    agentId: invoice.agentId || '',
    ownerWallet: invoice.ownerWallet || '',
    service: invoice.service,
    resource: invoice.resource,
    status: invoice.status,
    asset: invoice.asset,
    network: invoice.network,
    chainId: invoice.chainId || x402Config().chainId,
    usdcAddress: invoice.usdcAddress || ARC_USDC,
    circleEnvironment: invoice.circleEnvironment,
    circleTreasuryWalletId: invoice.circleTreasuryWalletId,
    recipient: invoice.recipient,
    baseAmount: invoice.baseAmount,
    uniqueAmount: invoice.uniqueAmount,
    amount: invoice.uniqueAmount,
    amountBaseUnits: invoice.amountBaseUnits || amountToBaseUnits(invoice.uniqueAmount),
    decimals: 6,
    memoContract: invoice.memoContract || ARC_MEMO_CONTRACT,
    memoId: invoice.memoId,
    memoData: invoice.memoData,
    paymentMethod: invoice.paymentMethod || 'arc-usdc-memo',
    paymentMethods: invoice.paymentMethods || ['arc-usdc-memo', 'unified-balance-gateway'],
    settlementStatus: invoice.settlementStatus || invoice.status,
    route: invoice.route,
    fee: invoice.fee,
    unifiedBalanceEstimate: invoice.unifiedBalanceEstimate,
    spendTxHash: invoice.spendTxHash,
    transferId: invoice.transferId,
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt,
    expiresInSeconds: invoice.expiresInSeconds,
    txHash: invoice.txHash,
    blockNumber: invoice.blockNumber,
    paidAt: invoice.paidAt,
    reconciledBy: invoice.reconciledBy,
    serviceStatus: invoice.serviceStatus,
    serviceUnlockedAt: invoice.serviceUnlockedAt,
    memoIndex: invoice.memoIndex,
    memoSender: invoice.memoSender,
    memoProofTxHash: invoice.memoProofTxHash || '',
    memoProofStatus: invoice.memoProofStatus || '',
  }
}

async function findMemoPayment(client, invoice, fromBlock, toBlock) {
  if (!invoice.memoId || !/^0x[0-9a-fA-F]{64}$/.test(invoice.memoId)) return null
  const memoLogs = await client.getLogs({
    address: invoice.memoContract || ARC_MEMO_CONTRACT,
    event: MEMO_EVENT,
    args: { memoId: invoice.memoId },
    fromBlock,
    toBlock,
  }).catch(() => [])
  const expectedAmount = normalizeAmount(invoice.uniqueAmount)
  const expectedTo = normalizeAddress(invoice.recipient)
  for (const memoLog of memoLogs.sort((a, b) => Number((b.blockNumber || 0n) - (a.blockNumber || 0n)))) {
    if (normalizeAddress(memoLog.args?.target) !== normalizeAddress(ARC_USDC)) continue
    const receipt = await client.getTransactionReceipt({ hash: memoLog.transactionHash }).catch(() => null)
    if (!receipt || receipt.status !== 'success') continue
    const transfer = receipt.logs.find(log => {
      if (normalizeAddress(log.address) !== normalizeAddress(ARC_USDC)) return false
      try {
        const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics })
        return normalizeAddress(decoded.args?.to) === expectedTo && formatUnits(decoded.args?.value || 0n, 6) === expectedAmount
      } catch {
        return false
      }
    })
    if (transfer) {
      return {
        transactionHash: memoLog.transactionHash,
        blockNumber: String(memoLog.blockNumber || ''),
        memoIndex: String(memoLog.args?.memoIndex ?? ''),
        sender: memoLog.args?.sender || '',
      }
    }
  }
  return null
}

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase()
}

function normalizeNetwork(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '-')
}

function eventIdFromCircle(payload) {
  return String(payload?.notificationId || payload?.id || payload?.eventId || payload?.data?.id || payload?.data?.transactionId || payload?.data?.transferId || '')
}

function eventTypeFromCircle(payload) {
  return String(payload?.type || payload?.notificationType || payload?.eventType || payload?.event || '')
}

function dataFromCircle(payload) {
  return payload?.data && typeof payload.data === 'object' ? payload.data : payload || {}
}

function amountFromCircle(data) {
  const amount = data.amount?.amount ?? data.amount ?? data.amounts?.[0]?.amount
  return normalizeAmount(amount)
}

function assetFromCircle(data) {
  return normalizeAsset(data.currency || data.asset || data.token || data.amount?.currency || data.amounts?.[0]?.currency)
}

function networkFromCircle(data, fallback) {
  return normalizeNetwork(data.network || data.chain || data.blockchain || data.blockchainName || data.destinationChain || fallback)
}

function destinationFromCircle(data) {
  return data.destinationAddress || data.toAddress || data.walletAddress || data.address || data.destination?.address || data.to
}

function txHashFromCircle(data) {
  return data.txHash || data.transactionHash || data.transaction?.txHash || data.hash
}

function statusFromCircle(data) {
  return String(data.status || data.state || data.transactionStatus || '').toLowerCase()
}

function isFinalCircleStatus(status) {
  return ['final', 'finalized', 'confirmed', 'complete', 'completed', 'success', 'succeeded'].includes(status)
}

async function circleWebhookPublicKey(keyId) {
  const cached = circleWebhookPublicKeys.get(keyId)
  if (cached && cached.expiresAt > Date.now()) return cached.key

  const apiKey = String(process.env.CIRCLE_API_KEY || '').trim()
  if (!apiKey) throw new Error('CIRCLE_API_KEY is required for Circle webhook verification')
  const baseUrl = String(process.env.CIRCLE_BASE_URL || 'https://api-sandbox.circle.com').replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/v2/notifications/publicKey/${encodeURIComponent(keyId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`Circle public-key lookup failed (${response.status})`)
  const payload = await response.json()
  const data = payload?.data || payload
  if (data?.algorithm && data.algorithm !== 'ECDSA_SHA_256') throw new Error('Unsupported Circle webhook signature algorithm')
  const encodedKey = String(data?.publicKey || '').trim()
  if (!encodedKey) throw new Error('Circle public-key response is incomplete')

  const key = encodedKey.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(encodedKey)
    : createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
  if (circleWebhookPublicKeys.size >= 100) circleWebhookPublicKeys.delete(circleWebhookPublicKeys.keys().next().value)
  circleWebhookPublicKeys.set(keyId, { key, expiresAt: Date.now() + CIRCLE_WEBHOOK_KEY_TTL_MS })
  return key
}

export async function verifyCircleWebhookSignature(req, rawBody) {
  const signature = String(req.headers['x-circle-signature'] || '').trim()
  const keyId = String(req.headers['x-circle-key-id'] || '').trim()
  if (!signature) return { ok: false, error: 'X-Circle-Signature header is required' }
  if (!keyId) return { ok: false, error: 'X-Circle-Key-Id header is required' }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) return { ok: false, error: 'Invalid Circle webhook key ID' }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(signature)) return { ok: false, error: 'Invalid Circle webhook signature format' }
  try {
    const key = await circleWebhookPublicKey(keyId)
    const signatureBytes = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const ok = verifySignature('sha256', Buffer.from(rawBody), key, signatureBytes)
    if (!ok) return { ok: false, error: 'Invalid Circle webhook signature' }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || 'Circle webhook verification failed' }
  }
}

export function processCircleX402Webhook(payload = {}) {
  loadPersistentInvoices()
  const eventId = eventIdFromCircle(payload) || `circle_${Date.now()}_${randomUUID().slice(0, 8)}`
  const eventType = eventTypeFromCircle(payload)
  if (webhookEvents.has(eventId)) return { duplicate: true, event: webhookEvents.get(eventId) }

  const data = dataFromCircle(payload)
  const event = {
    id: eventId,
    provider: 'circle',
    eventType,
    processed: false,
    matched: false,
    createdAt: new Date().toISOString(),
  }
  webhookEvents.set(eventId, event)
  while (webhookEvents.size > 1000) webhookEvents.delete(webhookEvents.keys().next().value)

  if (eventType !== 'transactions.inbound') {
    event.processed = true
    event.processedAt = new Date().toISOString()
    return { duplicate: false, event, ignored: true, reason: 'unsupported_event_type' }
  }

  const cfg = x402Config()
  const extracted = {
    walletId: String(data.walletId || data.wallet?.id || ''),
    destinationAddress: normalizeAddress(destinationFromCircle(data)),
    asset: assetFromCircle(data),
    amount: amountFromCircle(data),
    network: networkFromCircle(data, cfg.network),
    txHash: txHashFromCircle(data),
    status: statusFromCircle(data),
  }
  event.extracted = extracted

  if (!isFinalCircleStatus(extracted.status)) {
    event.processed = true
    event.processedAt = new Date().toISOString()
    return { duplicate: false, event, ignored: true, reason: 'non_final_status' }
  }

  const targetNetwork = normalizeNetwork(cfg.network)
  for (const invoice of invoices.values()) {
    if (!invoice || invoice.invoiceId !== invoices.get(invoice.invoiceId)?.invoiceId) continue
    const latest = getX402Invoice(invoice.invoiceId)
    if (!latest || !isOpenStatus(latest.status)) continue
    if (normalizeAddress(latest.recipient) !== extracted.destinationAddress) continue
    if (normalizeAsset(latest.asset) !== extracted.asset) continue
    if (normalizeAmount(latest.uniqueAmount) !== extracted.amount) continue
    if (normalizeNetwork(latest.network || targetNetwork) !== extracted.network && targetNetwork !== extracted.network) continue
    latest.status = 'paid'
    latest.settlementStatus = 'paid'
    latest.txHash = extracted.txHash || ''
    latest.paidAt = new Date().toISOString()
    latest.updatedAt = latest.paidAt
    latest.webhookEventId = eventId
    event.processed = true
    event.matched = true
    event.relatedInvoiceId = latest.invoiceId
    event.relatedPaymentId = latest.paymentId
    event.relatedTxHash = latest.txHash
    event.agentId = latest.agentId || ''
    event.processedAt = new Date().toISOString()
    invoices.set(latest.invoiceId, latest)
    invoices.set(latest.paymentId, latest)
    persistInvoices()
    scheduleAgentMemoProof(latest)
    return { duplicate: false, event, invoice: latest }
  }

  event.processed = true
  event.processedAt = new Date().toISOString()
  unmatchedInboundEvents.push(event)
  if (unmatchedInboundEvents.length > 1000) unmatchedInboundEvents.splice(0, unmatchedInboundEvents.length - 1000)
  return { duplicate: false, event, unmatched: true }
}

export function estimateUnifiedBalanceX402(invoiceId, input = {}) {
  const invoice = getX402Invoice(invoiceId)
  if (!invoice) return null
  if (!isOpenStatus(invoice.status)) return invoice
  if (!invoice.recipient || !/^0x[0-9a-fA-F]{40}$/.test(invoice.recipient)) {
    throw new Error('x402 recipient is not configured')
  }
  const now = new Date().toISOString()
  const estimate = {
    method: 'unified-balance-gateway',
    asset: 'USDC',
    amount: invoice.uniqueAmount,
    amountBaseUnits: invoice.amountBaseUnits || amountToBaseUnits(invoice.uniqueAmount),
    destinationChain: 'Arc_Testnet',
    recipient: invoice.recipient,
    route: input.route || 'Circle Gateway Unified Balance -> Arc Testnet USDC',
    fees: input.fees || [],
    delegateStatus: input.delegateStatus || 'must_be_ready_before_spend',
    settlement: 'not_paid_until_onchain_transfer_or_gateway_webhook',
    estimatedAt: now,
  }
  invoice.status = 'estimate_ready'
  invoice.settlementStatus = 'estimate_ready'
  invoice.unifiedBalanceEstimate = estimate
  invoice.updatedAt = now
  invoices.set(invoice.invoiceId, invoice)
  invoices.set(invoice.paymentId, invoice)
  persistInvoices()
  return invoice
}

export function markUnifiedBalanceSpendSubmitted(invoiceId, input = {}, options = {}) {
  const invoice = getX402Invoice(invoiceId)
  if (!invoice) return null
  if (!isOpenStatus(invoice.status)) return invoice
  const now = new Date().toISOString()
  invoice.status = 'settlement_pending'
  invoice.settlementStatus = 'settlement_pending'
  invoice.paymentMethod = 'unified-balance-gateway'
  invoice.spendTxHash = input.txHash || input.spendTxHash || ''
  invoice.transferId = input.transferId || ''
  invoice.trustedGatewaySpend = options.trustedGateway === true
  invoice.spendSummary = { txHash: invoice.spendTxHash, transferId: invoice.transferId }
  invoice.updatedAt = now
  invoices.set(invoice.invoiceId, invoice)
  invoices.set(invoice.paymentId, invoice)
  persistInvoices()
  return invoice
}

async function findFinalizedGatewayTransfer(invoice) {
  if (!invoice.trustedGatewaySpend || !/^[0-9a-f-]{36}$/i.test(String(invoice.transferId || '')) || !/^0x[0-9a-f]{64}$/i.test(String(invoice.spendTxHash || ''))) return null
  const response = await fetch(`${process.env.CIRCLE_GATEWAY_BASE_URL || 'https://gateway-api-testnet.circle.com'}/v1/transfer/${encodeURIComponent(invoice.transferId)}`, {
    headers: { 'User-Agent': 'arcox-x402-reconciler/1.0' },
    signal: AbortSignal.timeout(Number(process.env.X402_GATEWAY_RECONCILE_TIMEOUT_MS || 8_000)),
  })
  if (!response.ok) return null
  const transfer = await response.json().catch(() => null)
  if (!transfer || !['finalized', 'complete', 'completed'].includes(String(transfer.status || '').toLowerCase())) return null
  if (Number(transfer.destinationDomain) !== 26) return null
  if (normalizeAddress(transfer.transactionHash) !== normalizeAddress(invoice.spendTxHash)) return null
  return transfer
}

export function withArcoxX402(handler, config = {}) {
  return async (req, res, next) => {
    if (String(process.env.ARCOX_INTEL_ENABLED || 'true').toLowerCase() === 'false') {
      return res.status(503).json({ error: 'ARCOX Intel is disabled' })
    }
    const cfg = x402Config()
    if (!cfg.enabled) return handler(req, res, next)

    const resource = String(config.resource || req.originalUrl || req.path)
    const ownerWallet = String(req.headers['x-arcox-owner'] || req.query?.ownerWallet || '').toLowerCase()
    const agentId = String(req.headers['x-arcox-agent-id'] || req.query?.agentId || '')
    if (agentId && !await verifyAgentOwnership(agentId, ownerWallet)) {
      return res.status(403).json({ error: 'Agent identity mismatch' })
    }
    const paymentId = String(req.headers['x-payment-id'] || req.headers['x-arcox-payment-request-id'] || req.query?.paymentId || '')
    if (paymentId) {
      const invoice = await reconcileX402Invoice(paymentId)
      if (invoice && ((agentId && agentId !== String(invoice.agentId || '')) || (ownerWallet && invoice.ownerWallet && ownerWallet !== invoice.ownerWallet))) {
        return res.status(403).json({ error: 'Agent identity mismatch' })
      }
      if (invoice?.status === 'paid' && invoice.resource === resource) {
        invoice.serviceStatus = 'service_unlocked'
        invoice.serviceUnlockedAt = new Date().toISOString()
        invoices.set(invoice.invoiceId, invoice)
        invoices.set(invoice.paymentId, invoice)
        persistInvoices()
        req.arcoxX402 = { mode: 'arc_real_testnet', invoice }
        return handler(req, res, next)
      }
      if (invoice && invoice.resource !== resource) {
        const nextInvoice = createX402Invoice({ ...config, resource, ownerWallet, agentId, amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount) })
        return res.status(402).json({ error: 'x402 payment resource mismatch', x402: publicInvoice(nextInvoice) })
      }
      if (invoice?.status === 'expired') {
        const nextInvoice = createX402Invoice({ ...config, resource, ownerWallet, agentId, amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount) })
        return res.status(402).json({ error: 'x402 invoice expired', x402: publicInvoice(nextInvoice) })
      }
    }

    const invoice = createX402Invoice({
      service: config.service || 'arcox_intel',
      ownerWallet,
      agentId,
      amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount),
      resource,
    })
    if (!invoice.recipient || !/^0x[0-9a-fA-F]{40}$/.test(invoice.recipient)) {
      invoice.recipient = 'configure_CIRCLE_X402_TREASURY_ADDRESS'
    }
    return res.status(402).json({ error: 'Payment Required', x402: publicInvoice(invoice) })
  }
}

function scheduleAgentMemoProof(invoice) {
  if (!invoice?.agentId || invoice.paymentMethod !== 'unified-balance-gateway' || !invoice.txHash || invoice.memoProofStatus === 'pending' || invoice.memoProofTxHash) return
  invoice.memoProofStatus = 'pending'
  persistInvoices()
  void submitAgentMemoProof({
    agentId: invoice.agentId,
    paymentId: invoice.paymentId,
    requestId: invoice.paymentId,
    service: 'x402',
    amount: invoice.uniqueAmount,
    treasury: invoice.recipient,
    settlementTxHash: invoice.txHash,
  }).then(result => {
    invoice.memoProofStatus = result.status
    invoice.memoProofTxHash = result.txHash || ''
    invoice.memoId = result.memoId || invoice.memoId
    invoice.updatedAt = new Date().toISOString()
    invoices.set(invoice.invoiceId, invoice)
    invoices.set(invoice.paymentId, invoice)
    persistInvoices()
  }).catch(error => {
    invoice.memoProofStatus = 'failed'
    invoice.memoProofError = String(error?.message || error).slice(0, 200)
    invoice.updatedAt = new Date().toISOString()
    persistInvoices()
  })
}
