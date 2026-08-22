import { createPublicKey, randomUUID, verify as verifySignature } from 'crypto'
import { createPublicClient, http, fallback, parseAbiItem, keccak256, toHex, decodeEventLog } from 'viem'
import { atomicWriteJsonFile, readJsonFile } from '../services/jsonFileStore.mjs'
import { verifyAgentOwnership } from '../services/agentIdentityService.mjs'
import { verifyOwnerToken } from '../services/authToken.mjs'
import { buildAgentMemo, submitAgentMemoProof } from '../services/arcMemoService.mjs'
import { treasuryAddress } from '../config/treasury.mjs'
import { ARC_RPC_LOG_CHUNK_SIZE, arcRpcUrls, resolveArcRpc } from '../config/arcRpc.mjs'
import { readX402Invoice, scheduleWebhookEventUpsert, scheduleX402InvoiceUpsert, shadowReadWebhookEvent } from '../services/supabasePersistence.mjs'
import { claimWebhookEvent, completeWebhookEvent } from '../services/supabaseOperationalState.mjs'

const invoices = globalThis.__arcoxX402Invoices || new Map()
globalThis.__arcoxX402Invoices = invoices

const webhookEvents = globalThis.__arcoxX402WebhookEvents || new Map()
globalThis.__arcoxX402WebhookEvents = webhookEvents

function scheduleAndShadowX402WebhookEvent(event) {
  scheduleWebhookEventUpsert(event)
  // Offline fallback only. When the operational Supabase claim succeeds,
  // completion is written through the atomic RPC instead.
  void shadowReadWebhookEvent(event.provider, event.notificationId, event)
}

async function completeX402WebhookEvent(event, claimToken) {
  if (claimToken) {
    const completed = await completeWebhookEvent(event, claimToken)
    if (completed.completed) return
  }
  scheduleAndShadowX402WebhookEvent(event)
}

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
    for (const invoice of retained) scheduleX402InvoiceUpsert(invoice)
  } catch (error) {
    console.error('[x402] failed to persist invoice db', error?.message || error)
  }
}

/** Iterate all known invoices (deduplicated by invoiceId). */
export function getAllX402Invoices() {
  loadPersistentInvoices()
  const seen = new Set()
  const result = []
  for (const invoice of invoices.values()) {
    if (!invoice?.invoiceId || seen.has(invoice.invoiceId)) continue
    seen.add(invoice.invoiceId)
    result.push(invoice)
  }
  return result
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
  const raw = String(value ?? '').trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error('Invalid x402 amount')
  const [whole, fraction = ''] = raw.split('.')
  const baseUnits = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (baseUnits <= 0n) throw new Error('Invalid x402 amount')
  return `${baseUnits / 1_000_000n}.${String(baseUnits % 1_000_000n).padStart(6, '0')}`
}

function safeNormalizeAmount(value) {
  try { return normalizeAmount(value) } catch { return null }
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
  const paymentMethod = input.paymentMethod || 'arc-usdc-direct'
  const agentMemo = paymentMethod === 'unified-balance-gateway' || paymentMethod === 'arc-usdc-memo'
    ? buildAgentMemo({ agentId, paymentId, requestId: input.requestId || paymentId, service: input.service || 'x402', amount: uniqueAmount, treasury: cfg.circleTreasuryAddress })
    : null
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
    ...(paymentMethod === 'unified-balance-gateway' || paymentMethod === 'arc-usdc-memo' ? { memoContract: ARC_MEMO_CONTRACT, memoId, memoData } : {}),
    // MSCA payments use a direct ERC-20 transfer. Arc Memo remains available
    // only for legacy EOA invoices and must never be called by an MSCA.
    paymentMethod,
    paymentMethods: paymentMethod === 'unified-balance-gateway' ? ['unified-balance-gateway'] : paymentMethod === 'arc-usdc-memo' ? ['arc-usdc-memo'] : ['arc-usdc-direct'],
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
  const local = getX402Invoice(id)
  const read = await readX402Invoice(id, local)
  const invoice = read.invoice
  if (invoice?.invoiceId && invoice?.paymentId) {
    invoices.set(invoice.invoiceId, invoice)
    invoices.set(invoice.paymentId, invoice)
  }
  if (!invoice || !invoice.recipient || !/^0x[0-9a-fA-F]{40}$/.test(invoice.recipient)) return invoice
  if (invoice.status === 'paid' || invoice.status === 'refunded' || invoice.status === 'cancelled') return invoice
  try {
    const gatewayMatch = invoice.paymentMethod === 'unified-balance-gateway'
      ? await findFinalizedGatewayTransfer(invoice)
      : null
    if (invoice.paymentMethod === 'arc-usdc-direct' && !/^0x[0-9a-fA-F]{40}$/.test(String(invoice.ownerWallet || ''))) return invoice
    if (invoice.paymentMethod === 'arc-usdc-direct' && normalizeAddress(invoice.usdcAddress) !== normalizeAddress(ARC_USDC)) return invoice
    if (invoice.paymentMethod === 'arc-usdc-direct' && Number(invoice.chainId) !== 5042002) return invoice
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
    const rpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
    const drpcKey = process.env.DRPC_KEY || ''
    const fallbackRpcs = arcRpcUrls({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' }).filter(u => u !== rpc)
    const transports = [
      http(rpc, { timeout: 8_000, retryCount: 1, ...(drpcKey ? { fetchOptions: { headers: { Authorization: `Bearer ${drpcKey}` } } } : {}) }),
      ...fallbackRpcs.map(u => http(u, { timeout: 8_000, retryCount: 1 })),
    ]
    const client = createPublicClient({ transport: fallback(transports, { retryCount: 2, rank: false }) })
    const current = await client.getBlockNumber()
    const lookback = BigInt(Number(process.env.X402_RECONCILE_LOOKBACK_BLOCKS || '25000'))
    const fromBlock = current > lookback ? current - lookback : 0n
    const memoMatch = invoice.paymentMethod === 'arc-usdc-direct'
      ? null
      : await findMemoPayment(client, invoice, fromBlock, current)
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
    const invoiceCreatedAt = Date.parse(invoice.createdAt || '')
    const chunkSize = ARC_RPC_LOG_CHUNK_SIZE
    let match = null
    for (let chunkStart = fromBlock; chunkStart <= current && !match; chunkStart += chunkSize) {
      const chunkEnd = chunkStart + chunkSize - 1n > current ? current : chunkStart + chunkSize - 1n
      const chainId = await client.getChainId().catch(() => null)
      if (chainId !== null && Number(chainId) !== Number(invoice.chainId)) return invoice
      const logs = await client.getLogs({
        address: invoice.usdcAddress || ARC_USDC,
        event: TRANSFER_EVENT,
        args: {
          from: invoice.ownerWallet && /^0x[0-9a-fA-F]{40}$/.test(invoice.ownerWallet) ? invoice.ownerWallet : undefined,
          to: invoice.recipient,
        },
        fromBlock: chunkStart,
        toBlock: chunkEnd,        }).catch(() => [])
      const expectedAmount = safeNormalizeAmount(invoice.uniqueAmount)

      const expectedBaseUnits = invoice.amountBaseUnits || (expectedAmount ? amountToBaseUnits(expectedAmount) : null)
      const expectedPayer = normalizeAddress(invoice.ownerWallet)
      if (normalizeAddress(invoice.usdcAddress) !== normalizeAddress(ARC_USDC)) return invoice
      if (Number(invoice.chainId) !== 5042002) return invoice
      const expectedRecipient = normalizeAddress(invoice.recipient)
      const amountMatches = expectedBaseUnits
        ? logs
          // Keep the payer/recipient check explicit even though they are also
          // used as indexed-log filters. This prevents a mocked or non-standard
          // RPC response from turning a loosely matching transfer into payment.
          .filter(log => normalizeAddress(log.args?.from) === expectedPayer)
          .filter(log => normalizeAddress(log.args?.to) === expectedRecipient)
          .filter(log => String(log.args?.value || 0n) === String(expectedBaseUnits))
          .sort((a, b) => Number((b.blockNumber || 0n) - (a.blockNumber || 0n)))
        : []
      for (const log of amountMatches) {
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash }).catch(() => null)
        if (!receipt || receipt.status !== 'success') continue
        if (Number.isFinite(invoiceCreatedAt) && log.blockNumber) {
          const block = await client.getBlock({ blockNumber: log.blockNumber }).catch(() => null)
          const blockTimeMs = block?.timestamp ? Number(block.timestamp) * 1000 : 0
          if (blockTimeMs && blockTimeMs + 30_000 < invoiceCreatedAt) continue
        }
        match = log
        break
      }
    }
    if (!match) return invoice
    invoice.status = 'paid'
    invoice.settlementStatus = 'paid'
    invoice.txHash = match.transactionHash
    invoice.blockNumber = String(match.blockNumber || '')
    invoice.paidAt = new Date().toISOString()
    invoice.updatedAt = invoice.paidAt
    invoice.reconciledBy = 'arc-usdc-transfer-log-payer-bound'
    invoice.payer = normalizeAddress(match.args?.from)
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

// Record the result of the paid service separately from payment settlement.
// A paid invoice must never be presented as a successful service response when
// the provider returns "not found" or another terminal provider error. Refunds
// are deliberately represented as an explicit reviewable outcome here; this
// service must not invent a treasury private key or send an unapproved refund.
export function markX402ServiceOutcome(invoiceOrId, { status = 'provider_error', reason = '', refundEligible = true } = {}) {
  loadPersistentInvoices()
  const invoice = typeof invoiceOrId === 'string'
    ? invoices.get(invoiceOrId)
    : invoiceOrId
  if (!invoice) return null
  invoice.serviceStatus = status
  invoice.serviceOutcomeAt = new Date().toISOString()
  invoice.serviceError = reason || ''
  invoice.refundEligible = Boolean(refundEligible)
  invoice.refundStatus = refundEligible ? 'pending_review' : 'not_eligible'
  invoices.set(invoice.invoiceId, invoice)
  if (invoice.paymentId) invoices.set(invoice.paymentId, invoice)
  persistInvoices()
  return invoice
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
    ...(invoice.memoContract ? { memoContract: invoice.memoContract, memoId: invoice.memoId, memoData: invoice.memoData } : {}),
    paymentMethod: invoice.paymentMethod || 'arc-usdc-direct',
    paymentMethods: invoice.paymentMethods || ['arc-usdc-direct', 'unified-balance-gateway'],
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
    serviceOutcomeAt: invoice.serviceOutcomeAt,
    serviceError: invoice.serviceError || '',
    refundEligible: Boolean(invoice.refundEligible),
    refundStatus: invoice.refundStatus || '',
    refundApprovedAt: invoice.refundApprovedAt || '',
    refundedAt: invoice.refundedAt || '',
    refundTxHash: invoice.refundTxHash || '',
    serviceUnlockedAt: invoice.serviceUnlockedAt,
    memoIndex: invoice.memoIndex,
    memoSender: invoice.memoSender,
    memoProofTxHash: invoice.memoProofTxHash || '',
    memoProofStatus: invoice.memoProofStatus || '',
  }
}

async function findMemoPayment(client, invoice, fromBlock, toBlock) {
  if (!invoice.memoId || !/^0x[0-9a-fA-F]{64}$/.test(invoice.memoId)) return null
  const expectedAmount = safeNormalizeAmount(invoice.uniqueAmount)
  const expectedTo = normalizeAddress(invoice.recipient)
  if (!expectedAmount || !expectedTo) return null
  const chunkSize = ARC_RPC_LOG_CHUNK_SIZE
  let allMemoLogs = []
  for (let chunkStart = fromBlock; chunkStart <= toBlock; chunkStart += chunkSize) {
    const chunkEnd = chunkStart + chunkSize - 1n > toBlock ? toBlock : chunkStart + chunkSize - 1n
    const memoLogs = await client.getLogs({
      address: invoice.memoContract || ARC_MEMO_CONTRACT,
      event: MEMO_EVENT,
      args: { memoId: invoice.memoId },
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    }).catch(() => [])
    allMemoLogs = allMemoLogs.concat(memoLogs)
    if (allMemoLogs.length > 0) break
  }
  for (const memoLog of allMemoLogs.sort((a, b) => Number((b.blockNumber || 0n) - (a.blockNumber || 0n)))) {
    if (normalizeAddress(memoLog.args?.target) !== normalizeAddress(ARC_USDC)) continue
    const receipt = await client.getTransactionReceipt({ hash: memoLog.transactionHash }).catch(() => null)
    if (!receipt || receipt.status !== 'success') continue
    const transfer = receipt.logs.find(log => {
      if (normalizeAddress(log.address) !== normalizeAddress(ARC_USDC)) return false
      try {
        const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics })
        return normalizeAddress(decoded.args?.to) === expectedTo && String(decoded.args?.value || 0n) === String(invoice.amountBaseUnits || amountToBaseUnits(expectedAmount))
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
  // Circle v2 Gateway webhook public keys are served from the production
  // notifications API even for TEST subscriptions. Keep the legacy
  // CIRCLE_BASE_URL for other sandbox product calls, but allow an explicit
  // override for operators who use a private/proxied Circle endpoint.
  const baseUrl = String(process.env.CIRCLE_WEBHOOK_API_BASE_URL || 'https://api.circle.com').replace(/\/+$/, '')
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

export async function processCircleX402Webhook(payload = {}) {
  loadPersistentInvoices()
  const eventId = eventIdFromCircle(payload) || `circle_${Date.now()}_${randomUUID().slice(0, 8)}`
  const eventType = eventTypeFromCircle(payload)
  const data = dataFromCircle(payload)
  const event = {
    id: eventId,
    notificationId: eventId,
    provider: 'circle',
    eventType,
    processed: false,
    matched: false,
    createdAt: new Date().toISOString(),
    rawPayload: payload,
  }
  const claim = await claimWebhookEvent(event)
  if (claim.enabled && claim.duplicate) return { duplicate: true, event: claim.event || event }
  if (!claim.enabled && webhookEvents.has(eventId)) return { duplicate: true, event: webhookEvents.get(eventId) }
  const claimToken = claim.enabled ? claim.claimToken : ''
  webhookEvents.set(eventId, event)
  if (!claim.enabled) scheduleAndShadowX402WebhookEvent(event)
  while (webhookEvents.size > 1000) webhookEvents.delete(webhookEvents.keys().next().value)

  if (eventType !== 'transactions.inbound') {
    event.processed = true
    event.processedAt = new Date().toISOString()
    await completeX402WebhookEvent(event, claimToken)
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
    await completeX402WebhookEvent(event, claimToken)
    return { duplicate: false, event, ignored: true, reason: 'non_final_status' }
  }

  const targetNetwork = normalizeNetwork(cfg.network)
  for (const invoice of invoices.values()) {
    if (!invoice || invoice.invoiceId !== invoices.get(invoice.invoiceId)?.invoiceId) continue
    const latest = getX402Invoice(invoice.invoiceId)
    if (!latest || !isOpenStatus(latest.status)) continue
    if (normalizeAddress(latest.recipient) !== extracted.destinationAddress) continue
    // Gateway webhook records are accepted only when the invoice explicitly
    // opted into Gateway settlement. Direct MSCA invoices must reconcile from
    // an Arc Transfer log, where payer binding is available.
    if (latest.paymentMethod !== 'unified-balance-gateway') continue
    if (normalizeAsset(latest.asset) !== extracted.asset) continue
    if (normalizeAmount(latest.uniqueAmount) !== extracted.amount) continue
    if (normalizeNetwork(latest.network || targetNetwork) !== extracted.network && targetNetwork !== extracted.network) continue
    latest.status = 'paid'
    latest.settlementStatus = 'paid'
    latest.txHash = extracted.txHash || ''
    latest.payer = normalizeAddress(data.sourceAddress || data.fromAddress || data.source?.address || '')
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
    await completeX402WebhookEvent(event, claimToken)
    scheduleAgentMemoProof(latest)
    return { duplicate: false, event, invoice: latest }
  }

  event.processed = true
  event.processedAt = new Date().toISOString()
  unmatchedInboundEvents.push(event)
  if (unmatchedInboundEvents.length > 1000) unmatchedInboundEvents.splice(0, unmatchedInboundEvents.length - 1000)
  await completeX402WebhookEvent(event, claimToken)
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
  // A Gateway transfer is never trusted from browser input alone. Reconciliation
  // validates the finalized Gateway record against this exact invoice.
  invoice.trustedGatewaySpend = Boolean(invoice.spendTxHash && invoice.transferId)
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
  if (normalizeAddress(transfer.destinationAddress) !== normalizeAddress(invoice.recipient)) return null
  if (normalizeAsset(transfer.token || transfer.asset) !== normalizeAsset(invoice.asset)) return null
  const expectedAmount = safeNormalizeAmount(invoice.uniqueAmount)
  if (!expectedAmount) return null
  if (normalizeAmount(transfer.amount) !== expectedAmount) return null
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
    if (ownerWallet) {
      const authHeader = String(req.headers.authorization || '')
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      let authenticatedOwner = verifyOwnerToken(bearer)
      if (!authenticatedOwner && bearer.startsWith('arx_vs_')) {
        try {
          const { validateSession } = await import('../services/vaultStore.mjs')
          authenticatedOwner = validateSession(bearer)
        } catch { authenticatedOwner = null }
      }
      if (!authenticatedOwner) return res.status(401).json({ error: 'Authenticated wallet required for MSCA x402 payment' })
      const { getSessionKeyInfo } = await import('../services/vaultStore.mjs')
      const session = await getSessionKeyInfo(authenticatedOwner)
      if (!session?.active || String(session.walletAddress || '').toLowerCase() !== ownerWallet) {
        return res.status(403).json({ error: 'x402 payer must be the authenticated active MSCA' })
      }
    }
    if (agentId && !await verifyAgentOwnership(agentId, ownerWallet)) {
      return res.status(403).json({ error: 'Agent identity mismatch' })
    }
    const paymentId = String(req.headers['x-payment-id'] || req.headers['x-arcox-payment-request-id'] || req.query?.paymentId || '')
    if (paymentId && !ownerWallet) {
      return res.status(401).json({ error: 'Authenticated MSCA owner header is required to retry a paid x402 resource' })
    }
    if (paymentId) {
      const invoice = await reconcileX402Invoice(paymentId)
      if (invoice && ((agentId && agentId !== String(invoice.agentId || '')) || (ownerWallet && invoice.ownerWallet && ownerWallet !== invoice.ownerWallet))) {
        return res.status(403).json({ error: 'Agent identity mismatch' })
      }
      // Resource binding compares the path without query parameters: the
      // query is only a filter (limit, chains, timeLast) and must not turn a
      // legitimate retry into a new invoice. Path parameters (address, hash,
      // entity, id) remain strictly bound.
      const normalizeResource = value => String(value || '').split('?')[0].replace(/\/$/, '')
      if (invoice?.status === 'paid' && normalizeResource(invoice.resource) === normalizeResource(resource)) {
        invoice.serviceStatus = 'service_unlocked'
        invoice.serviceUnlockedAt = new Date().toISOString()
        invoices.set(invoice.invoiceId, invoice)
        invoices.set(invoice.paymentId, invoice)
        persistInvoices()
        req.arcoxX402 = { mode: 'arc_real_testnet', invoice }
        return handler(req, res, next)
      }
      if (invoice && normalizeResource(invoice.resource) !== normalizeResource(resource)) {
        const nextInvoice = createX402Invoice({ ...config, resource, ownerWallet, agentId, amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount) })
        return res.status(402).json({ error: 'x402 payment resource mismatch', x402: publicInvoice(nextInvoice) })
      }
      if (invoice?.status === 'expired') {
        const nextInvoice = createX402Invoice({ ...config, resource, ownerWallet, agentId, amount: priceFromEnv(config.priceEnv || '', config.amount || cfg.baseAmount) })
        return res.status(402).json({ error: 'x402 invoice expired', x402: publicInvoice(nextInvoice) })
      }
    }

    if (!ownerWallet && !paymentId) {
      // A direct MSCA invoice must be payer-bound. Legacy memo invoices are not
      // created implicitly for remote MCP requests anymore.
      return res.status(400).json({ error: 'Authenticated MSCA owner is required for x402 resource access' })
    }
    const invoice = createX402Invoice({
      service: config.service || 'arcox_intel',
      ownerWallet,
      agentId,
      paymentMethod: 'arc-usdc-direct',
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
