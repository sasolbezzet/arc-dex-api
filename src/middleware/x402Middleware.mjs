import { randomUUID, createHmac, timingSafeEqual } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createPublicClient, http, parseAbiItem, formatUnits, keccak256, toHex, decodeEventLog } from 'viem'

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
let loadedPersistentInvoices = false

function loadPersistentInvoices() {
  if (loadedPersistentInvoices) return
  loadedPersistentInvoices = true
  try {
    if (!existsSync(X402_INVOICE_DB)) return
    const parsed = JSON.parse(readFileSync(X402_INVOICE_DB, 'utf8') || '[]')
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
    writeFileSync(X402_INVOICE_DB, JSON.stringify(unique, null, 2))
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
    circleTreasuryAddress: process.env.X402_RECIPIENT_ADDRESS || process.env.CIRCLE_X402_TREASURY_ADDRESS || process.env.ARCOX_TREASURY_WALLET_ADDRESS || '',
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
  const memoId = input.memoId || keccak256(toHex(paymentId))
  const memoData = input.memoData || toHex(JSON.stringify({
    app: 'arcox',
    type: 'x402',
    invoiceId,
    paymentId,
    resource: String(input.resource || '/api/intel'),
  }))
  const invoice = {
    invoiceId,
    paymentId,
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
    const rpc = process.env.ARC_RPC_URL || process.env.RPC || 'https://rpc.testnet.arc.network/'
    const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 1 }) })
    const current = await client.getBlockNumber()
    const lookback = BigInt(Number(process.env.X402_RECONCILE_LOOKBACK_BLOCKS || '25000'))
    const fromBlock = current > lookback ? current - lookback : 0n
    const memoMatch = await findMemoPayment(client, invoice, fromBlock, current)
    if (memoMatch) {
      invoice.status = 'paid'
      invoice.settlementStatus = 'paid'
      invoice.txHash = memoMatch.transactionHash
      invoice.paidAt = new Date().toISOString()
      invoice.updatedAt = invoice.paidAt
      invoice.reconciledBy = 'arc-transaction-memo'
      invoice.memoIndex = memoMatch.memoIndex
      invoice.memoSender = memoMatch.sender
      invoices.set(invoice.invoiceId, invoice)
      invoices.set(invoice.paymentId, invoice)
      persistInvoices()
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
    invoice.paidAt = new Date().toISOString()
    invoice.updatedAt = invoice.paidAt
    invoice.reconciledBy = 'arc-usdc-transfer-log'
    invoices.set(invoice.invoiceId, invoice)
    invoices.set(invoice.paymentId, invoice)
    persistInvoices()
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
    paidAt: invoice.paidAt,
    reconciledBy: invoice.reconciledBy,
    serviceStatus: invoice.serviceStatus,
    serviceUnlockedAt: invoice.serviceUnlockedAt,
    memoIndex: invoice.memoIndex,
    memoSender: invoice.memoSender,
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

export function verifyCircleWebhookSignature(req, rawBody) {
  const secret = process.env.CIRCLE_WEBHOOK_SECRET || ''
  if (!secret) return { ok: false, error: 'CIRCLE_WEBHOOK_SECRET is required' }
  const signature = String(req.headers['circle-signature'] || req.headers['x-circle-signature'] || req.headers['circle-signature-sha256'] || '')
  if (!signature) return { ok: false, error: 'Circle webhook signature required' }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const normalized = signature.replace(/^sha256=/i, '')
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(normalized, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'Invalid Circle webhook signature' }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Invalid Circle webhook signature format' }
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
    rawPayload: payload,
    processed: false,
    matched: false,
    createdAt: new Date().toISOString(),
  }
  webhookEvents.set(eventId, event)

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
    latest.rawWebhookEvent = payload
    event.processed = true
    event.matched = true
    event.relatedInvoiceId = latest.invoiceId
    event.relatedPaymentId = latest.paymentId
    event.relatedTxHash = latest.txHash
    event.processedAt = new Date().toISOString()
    invoices.set(latest.invoiceId, latest)
    invoices.set(latest.paymentId, latest)
    persistInvoices()
    return { duplicate: false, event, invoice: latest }
  }

  event.processed = true
  event.processedAt = new Date().toISOString()
  unmatchedInboundEvents.push(event)
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

export function markUnifiedBalanceSpendSubmitted(invoiceId, input = {}) {
  const invoice = getX402Invoice(invoiceId)
  if (!invoice) return null
  if (!isOpenStatus(invoice.status)) return invoice
  const now = new Date().toISOString()
  invoice.status = 'settlement_pending'
  invoice.settlementStatus = 'settlement_pending'
  invoice.paymentMethod = 'unified-balance-gateway'
  invoice.spendTxHash = input.txHash || input.spendTxHash || ''
  invoice.transferId = input.transferId || ''
  invoice.spendResult = input.spendResult || null
  invoice.updatedAt = now
  invoices.set(invoice.invoiceId, invoice)
  invoices.set(invoice.paymentId, invoice)
  persistInvoices()
  return invoice
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
    if (paymentId) {
      const invoice = await reconcileX402Invoice(paymentId)
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
        const nextInvoice = createX402Invoice({ ...config, resource, amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount) })
        return res.status(402).json({ error: 'x402 payment resource mismatch', x402: publicInvoice(nextInvoice) })
      }
      if (invoice?.status === 'expired') {
        const nextInvoice = createX402Invoice({ ...config, resource, amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount) })
        return res.status(402).json({ error: 'x402 invoice expired', x402: publicInvoice(nextInvoice) })
      }
    }

    const invoice = createX402Invoice({
      service: config.service || 'arcox_intel',
      amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount),
      resource,
    })
    if (!invoice.recipient || !/^0x[0-9a-fA-F]{40}$/.test(invoice.recipient)) {
      invoice.recipient = 'configure_CIRCLE_X402_TREASURY_ADDRESS'
    }
    return res.status(402).json({ error: 'Payment Required', x402: publicInvoice(invoice) })
  }
}
