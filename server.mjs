import 'dotenv/config'
import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'
import { AppKit, SwapChain } from '@circle-fin/app-kit'
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits, defineChain, getAddress, isAddress, verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { quoteEcoRoutePayment } from './services/ecoAdapter.mjs'
import { withX402PaymentRequired } from './middleware/x402.mjs'

process.on('uncaughtException', (err) => console.error('[UncaughtException]', err.message))
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason?.message || reason))
BigInt.prototype.toJSON = function() { return this.toString() }

const app = express()
app.disable('x-powered-by')
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'https://43.163.98.128.nip.io',
  'https://43.163.98.128.nip.io/arc-dex',
  'https://arc-dex-bice.vercel.app',
]
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
app.use((req, res, next) => {
  const origin = req.headers.origin
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Arcox-Payment-Proof, X-Arcox-Payment-Request-Id')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})
app.use(express.json({ limit: '64kb' }))

function rateLimit({ windowMs, max, keyPrefix }) {
  const hits = new Map()
  return (req, res, next) => {
    const now = Date.now()
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
    const key = `${keyPrefix}:${ip}`
    const current = hits.get(key)
    if (!current || now > current.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }
    current.count += 1
    if (current.count > max) return res.status(429).json({ error: 'Too many requests. Please try again later.' })
    next()
  }
}

const authLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, keyPrefix: 'auth' })
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, keyPrefix: 'api' })
const attestationLimiter = rateLimit({ windowMs: 60 * 1000, max: 45, keyPrefix: 'attestation' })

const KIT_KEY = process.env.KIT_KEY
const PORT = process.env.PORT || 3001
const WALLET_DB = './wallets-db.json'
const TX_HISTORY_DB = './tx-history-db.json'
const INVOICE_DB = './invoices-db.json'
const WEBHOOK_DB = './webhook-events-db.json'
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.CIRCLE_ENTITY_SECRET || process.env.CIRCLE_API_KEY || ''
const ARCOX_PAY_BASE_URL = (process.env.ARCOX_PAY_BASE_URL || process.env.ARCOX_WEB_URL || 'https://arc-dex-bice.vercel.app').replace(/\/$/, '')
const ENABLE_DEV_TOOLS = String(process.env.ENABLE_DEV_TOOLS || 'false').toLowerCase() === 'true'
const AUTH_TTL_MS = Number(process.env.AUTH_TTL_MS || 24 * 60 * 60 * 1000)
const LOGIN_WINDOW_MS = 5 * 60 * 1000
if (!process.env.AUTH_SECRET) console.warn('[security] AUTH_SECRET not set. Set a dedicated random AUTH_SECRET before production.')

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network/'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
})

const TOKENS = {
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
}

const SEND_TOKEN_MAP = {
  USDC: 'USDC',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
}

const TOKEN_DECIMALS = {
  USDC: 6,
  EURC: 6,
  USYC: 6,
  cirBTC: 8,
}

function swapTokenParam(token) {
  if (token === 'USYC' || token === 'cirBTC') return TOKENS[token]
  return token
}

const PLATFORM_FEE_BPS = Number(process.env.ARCOX_ROUTER_FEE_BPS || 30)
const PLATFORM_TREASURY = process.env.ARCOX_FEE_TREASURY || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

const CCTP = {
  Arc_Testnet: {
    domain: 26,
    usdc: '0x3600000000000000000000000000000000000000',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    explorer: 'https://testnet.arcscan.app/tx/',
    chain: arcTestnet,
  },
  Ethereum_Sepolia: {
    domain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    explorer: 'https://sepolia.etherscan.io/tx/',
    chain: defineChain({ id: 11155111, name: 'Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } } }),
  },
  Base_Sepolia: {
    domain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    explorer: 'https://sepolia.basescan.org/tx/',
    chain: defineChain({ id: 84532, name: 'Base Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://sepolia.base.org'] } } }),
  },
  Arbitrum_Sepolia: {
    domain: 3,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    explorer: 'https://sepolia.arbiscan.io/tx/',
    chain: defineChain({ id: 421614, name: 'Arbitrum Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://arbitrum-sepolia.publicnode.com'] } } }),
  },
  HyperEVM_Testnet: {
    domain: 19,
    usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    explorer: 'https://app.hyperliquid-testnet.xyz/explorer/tx/',
    chain: defineChain({ id: 998, name: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.hyperliquid-testnet.xyz/evm'] } } }),
  },
}

const SOLANA_CCTP = {
  domain: 5,
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  tokenMessengerProgram: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
  messageTransmitterProgram: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  rpc: process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com/tx/',
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ name: 'success', type: 'bool' }],
  stateMutability: 'nonpayable'
}]

// ── Chain-aware attestation polling retry config ──
// Arc/Solana: ~detik finality → 30s polling  |  Arbitrum: ~1-5mnt → ~9mnt buffer
// Sepolia/Base: ~12-19mnt finality → ~22mnt buffer
const RETRY_CFG = {
  Arc_Testnet: { maxRetries: 60, fastMode: true },
  Solana_Devnet: { maxRetries: 60, fastMode: true },
  Arbitrum_Sepolia: { maxRetries: 300, fastMode: false },
  Ethereum_Sepolia: { maxRetries: 700, fastMode: false },
  Base_Sepolia: { maxRetries: 700, fastMode: false },
  HyperEVM_Testnet: { maxRetries: 300, fastMode: false },
}

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const circleAdapter = createCircleWalletsAdapter({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const kit = new AppKit()

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signPayload(payload) {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
}

function authMessage(address, issuedAt) {
  return [
    'ARCOX DEX login',
    'Only sign this message on the official ARCOX DEX website.',
    `Address: ${getAddress(address)}`,
    `Issued At: ${issuedAt}`,
    'Network: Arc Testnet',
  ].join('\n')
}

function createAuthToken(address) {
  if (!AUTH_SECRET) throw new Error('AUTH_SECRET belum dikonfigurasi')
  const payload = b64url(JSON.stringify({ address: getAddress(address).toLowerCase(), exp: Date.now() + AUTH_TTL_MS }))
  return `${payload}.${signPayload(payload)}`
}

function verifyAuthToken(token) {
  try {
    if (!AUTH_SECRET || !token || !token.includes('.')) return null
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payload, sig] = parts
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null
    const expected = signPayload(payload)
    const sigBuf = Buffer.from(sig)
    const expBuf = Buffer.from(expected)
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data?.address || !data?.exp || Date.now() > data.exp) return null
    return data.address
  } catch {
    return null
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const authAddress = verifyAuthToken(token)
  if (!authAddress) return res.status(401).json({ error: 'Wallet authentication required' })
  const bodyAddress = req.body?.metamaskAddress || req.body?.address
  if (bodyAddress && (!isAddress(bodyAddress) || getAddress(bodyAddress).toLowerCase() !== authAddress)) {
    return res.status(403).json({ error: 'Authenticated wallet does not match request address' })
  }
  req.authAddress = authAddress
  next()
}

function normalizeAddress(value, field = 'address') {
  if (!value || !isAddress(value)) throw new Error(`Invalid ${field}`)
  return getAddress(value)
}

function normalizeAmount(value) {
  const raw = String(value ?? '')
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error('Invalid amount')
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) throw new Error('Invalid amount')
  if (num > 1_000_000) throw new Error('Amount exceeds safety limit')
  return raw
}

function normalizeArcToken(value) {
  const raw = String(value || 'USDC')
  if (raw.toUpperCase() === 'CIRBTC') return 'cirBTC'
  return raw.toUpperCase()
}

function decimalToUnits(value, decimals) {
  const raw = normalizeAmount(value)
  const [whole, frac = ''] = raw.split('.')
  const padded = frac.padEnd(decimals, '0').slice(0, decimals)
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(padded || '0')
}

function unitsToDecimal(units, decimals) {
  const sign = units < 0n ? '-' : ''
  const abs = units < 0n ? -units : units
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${sign}${whole.toString()}${frac ? `.${frac}` : ''}`
}

function splitPlatformFee(amount, token) {
  token = normalizeArcToken(token)
  const decimals = TOKEN_DECIMALS[token]
  if (decimals === undefined) throw new Error('Unsupported token decimals: ' + token)
  const amountUnits = decimalToUnits(amount, decimals)
  const feeBps = Number.isFinite(PLATFORM_FEE_BPS) && PLATFORM_FEE_BPS > 0 ? Math.floor(PLATFORM_FEE_BPS) : 0
  const feeUnits = (amountUnits * BigInt(feeBps)) / 10_000n
  const netUnits = amountUnits - feeUnits
  if (netUnits <= 0n) throw new Error('Amount too small after platform fee')
  return {
    feeBps,
    amountUnits,
    feeUnits,
    netUnits,
    feeAmount: unitsToDecimal(feeUnits, decimals),
    netAmount: unitsToDecimal(netUnits, decimals),
  }
}

function normalizeTxHash(value, field = 'txHash') {
  const raw = String(value || '')
  if (!/^0x[0-9a-f]{64}$/i.test(raw) && !/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(raw)) {
    throw new Error(`Invalid ${field}`)
  }
  return raw
}

function requireServerSignedMintAuth(req, res, next) {
  if (process.env.ENABLE_SERVER_SIGNED_MINT !== 'true') {
    return res.status(403).json({ error: 'Server-signed mint disabled. Use wallet-signed mint.' })
  }
  requireAuth(req, res, next)
}

function isNoSwapRouteError(err) {
  const msg = err?.message || String(err || '')
  return msg.includes('No route available') ||
    msg.includes('Route or resource not found') ||
    msg.includes('route is not supported') ||
    msg.includes('Swap route not found')
}

function noSwapRouteResponse(res, err) {
  console.warn('[swap] no route:', err?.message || err)
  return res.json({
    success: false,
    available: false,
    code: 'NO_SWAP_ROUTE',
    error: 'Route swap belum tersedia dari Circle Stablecoin Service untuk pasangan/jumlah ini. Coba jumlah lebih besar, atau ulangi beberapa menit lagi.',
    details: err?.message || String(err || ''),
  })
}

function loadWallets() {
  try { return existsSync(WALLET_DB) ? JSON.parse(readFileSync(WALLET_DB, 'utf-8')) : {} }
  catch { return {} }
}
function saveWallets(db) { writeFileSync(WALLET_DB, JSON.stringify(db, null, 2)) }
function loadTxHistory() {
  try {
    if (!existsSync(TX_HISTORY_DB)) return {}
    const db = JSON.parse(readFileSync(TX_HISTORY_DB, 'utf8'))
    return db && typeof db === 'object' ? db : {}
  } catch { return {} }
}
function saveTxHistory(db) { writeFileSync(TX_HISTORY_DB, JSON.stringify(db, null, 2)) }
function sanitizeHistoryRecord(input, owner) {
  const action = String(input?.action || input?.kind || '').toLowerCase()
  if (!['bridge', 'swap', 'send'].includes(action)) throw new Error('Invalid history action')
  const status = ['pending', 'success', 'error'].includes(String(input?.status)) ? String(input.status) : 'success'
  const rec = {
    id: String(input?.id || `${action}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`).slice(0, 96),
    ts: Number(input?.ts || Date.now()),
    owner,
    action,
    source: String(input?.source || 'web-ui').slice(0, 32),
    walletSource: String(input?.walletSource || input?.fundingSource || '').slice(0, 32),
    from: String(input?.from || '').slice(0, 64),
    to: String(input?.to || '').slice(0, 128),
    amount: String(input?.amount || '').slice(0, 64),
    token: String(input?.token || 'USDC').slice(0, 32),
    status,
    tx: String(input?.tx || input?.txHash || '').slice(0, 96),
    explorer: String(input?.explorer || input?.explorerUrl || '').slice(0, 220),
    approveTx: String(input?.approveTx || '').slice(0, 96),
    burnTx: String(input?.burnTx || '').slice(0, 96),
    burnExplorerUrl: String(input?.burnExplorerUrl || input?.burnExplorer || '').slice(0, 220),
    mintTx: String(input?.mintTx || '').slice(0, 128),
    mintExplorerUrl: String(input?.mintExplorerUrl || input?.mintExplorer || '').slice(0, 240),
    srcDomain: Number.isFinite(Number(input?.srcDomain)) ? Number(input.srcDomain) : undefined,
    dstDomain: Number.isFinite(Number(input?.dstDomain)) ? Number(input.dstDomain) : undefined,
    note: String(input?.note || '').slice(0, 500),
    error: String(input?.error || '').slice(0, 500),
  }
  return rec
}
function appendTxHistory(owner, input) {
  const normalized = normalizeAddress(owner, 'owner')
  const db = loadTxHistory()
  const key = normalized.toLowerCase()
  const rec = sanitizeHistoryRecord(input, normalized)
  const items = Array.isArray(db[key]) ? db[key] : []
  const withoutExisting = items.filter(item => item?.id !== rec.id)
  db[key] = [rec, ...withoutExisting].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 100)
  saveTxHistory(db)
  return rec
}

function readObjectDb(path) {
  try {
    if (!existsSync(path)) return {}
    const db = JSON.parse(readFileSync(path, 'utf8'))
    return db && typeof db === 'object' && !Array.isArray(db) ? db : {}
  } catch {
    return {}
  }
}

function writeObjectDb(path, db) {
  writeFileSync(path, JSON.stringify(db, null, 2))
}

function loadInvoices() { return readObjectDb(INVOICE_DB) }
function saveInvoices(db) { writeObjectDb(INVOICE_DB, db) }
function loadWebhookEvents() { return readObjectDb(WEBHOOK_DB) }
function saveWebhookEvents(db) { writeObjectDb(WEBHOOK_DB, db) }

function nowIso() { return new Date().toISOString() }

function timelineEvent(type, message, txHash = '') {
  return {
    type,
    message,
    ...(txHash ? { txHash } : {}),
    createdAt: nowIso(),
  }
}

function paymentUrlFor(invoiceId) {
  return `${ARCOX_PAY_BASE_URL}/pay?invoice=${encodeURIComponent(invoiceId)}`
}

function normalizeInvoiceToken(value) {
  const token = String(value || 'USDC').toUpperCase()
  if (token !== 'USDC') throw new Error('Unsupported token')
  return 'USDC'
}

function normalizeInvoiceNetwork(value) {
  const network = String(value || 'arc-testnet').toLowerCase()
  if (network !== 'arc-testnet') throw new Error('Unsupported network')
  return 'arc-testnet'
}

function invoiceIsExpired(invoice) {
  return Date.now() > new Date(invoice.expiresAt).getTime()
}

function refreshInvoiceStatus(invoice) {
  if (!invoice) return invoice
  if (['paid', 'failed', 'cancelled', 'expired'].includes(invoice.status)) return invoice
  if (invoiceIsExpired(invoice)) {
    invoice.status = 'expired'
    invoice.timeline = [...(invoice.timeline || []), timelineEvent('expired', 'Invoice expired before payment was completed.')]
  }
  return invoice
}

function getInvoiceOrThrow(invoiceId) {
  const db = loadInvoices()
  const invoice = db[String(invoiceId || '')]
  if (!invoice) throw new Error('Invoice not found')
  const refreshed = refreshInvoiceStatus(invoice)
  db[refreshed.invoiceId] = refreshed
  saveInvoices(db)
  return refreshed
}

function createInvoice(input = {}) {
  const amount = normalizeAmount(input.amount)
  const token = normalizeInvoiceToken(input.token)
  const network = normalizeInvoiceNetwork(input.network)
  const merchantAddress = normalizeAddress(input.merchantAddress, 'merchantAddress')
  const minutesRaw = Number(input.expiresInMinutes || 15)
  const expiresInMinutes = Number.isFinite(minutesRaw) && minutesRaw > 0 ? Math.min(minutesRaw, 60 * 24 * 30) : 15
  const invoiceId = `inv_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  const createdAt = nowIso()
  const invoice = {
    invoiceId,
    ...(input.orderId ? { orderId: String(input.orderId).slice(0, 96) } : {}),
    merchantAddress,
    amount,
    token,
    network,
    ...(input.memo ? { memo: String(input.memo).slice(0, 500) } : {}),
    status: 'unpaid',
    paymentUrl: paymentUrlFor(invoiceId),
    createdAt,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
    timeline: [timelineEvent('created', 'Invoice created.')],
  }
  const db = loadInvoices()
  db[invoiceId] = invoice
  saveInvoices(db)
  return invoice
}

function patchInvoice(invoiceId, patch = {}) {
  const db = loadInvoices()
  const invoice = refreshInvoiceStatus(db[String(invoiceId || '')])
  if (!invoice) throw new Error('Invoice not found')
  if (patch.amount !== undefined && String(patch.amount) !== String(invoice.amount)) throw new Error('Invoice amount cannot be changed')
  if (patch.token !== undefined && normalizeInvoiceToken(patch.token) !== invoice.token) throw new Error('Invoice token cannot be changed')
  if (patch.network !== undefined && normalizeInvoiceNetwork(patch.network) !== invoice.network) throw new Error('Invoice network cannot be changed')
  if (patch.merchantAddress !== undefined && normalizeAddress(patch.merchantAddress, 'merchantAddress') !== invoice.merchantAddress) throw new Error('Invoice merchantAddress cannot be changed')
  if (patch.orderId !== undefined) invoice.orderId = String(patch.orderId).slice(0, 96)
  if (patch.memo !== undefined) invoice.memo = String(patch.memo).slice(0, 500)
  if (patch.txHash !== undefined && patch.txHash) invoice.txHash = normalizeTxHash(patch.txHash)
  if (patch.payerAddress !== undefined && patch.payerAddress) invoice.payerAddress = normalizeAddress(patch.payerAddress, 'payerAddress')
  if (patch.status !== undefined) {
    const nextStatus = String(patch.status)
    if (!['unpaid', 'pending', 'paid', 'expired', 'failed', 'cancelled'].includes(nextStatus)) throw new Error('Invalid invoice status')
    if (invoice.status === 'paid' && nextStatus !== 'paid') throw new Error('Paid invoice cannot be changed')
    if (invoice.status === 'expired' && nextStatus !== 'expired') throw new Error('Expired invoice cannot be changed')
    if (invoiceIsExpired(invoice) && !['expired', 'failed', 'cancelled'].includes(nextStatus)) throw new Error('Invoice expired')
    invoice.status = nextStatus
    if (nextStatus === 'paid') invoice.paidAt = invoice.paidAt || nowIso()
    invoice.timeline = [...(invoice.timeline || []), timelineEvent(`status_${nextStatus}`, `Invoice status updated to ${nextStatus}.`, invoice.txHash)]
  }
  db[invoice.invoiceId] = invoice
  saveInvoices(db)
  return invoice
}

function markInvoicePaid(invoiceId, input = {}) {
  const db = loadInvoices()
  const invoice = refreshInvoiceStatus(db[String(invoiceId || '')])
  if (!invoice) throw new Error('Invoice not found')
  if (invoice.status === 'paid') throw new Error('Invoice already paid')
  if (invoice.status === 'expired' || invoiceIsExpired(invoice)) throw new Error('Invoice expired')
  if (input.txHash) invoice.txHash = normalizeTxHash(input.txHash)
  if (input.payerAddress) invoice.payerAddress = normalizeAddress(input.payerAddress, 'payerAddress')
  invoice.status = 'paid'
  invoice.paidAt = nowIso()
  invoice.timeline = [...(invoice.timeline || []), timelineEvent('manual_mark_paid', 'Invoice marked paid by payment confirmation or sandbox tool.', invoice.txHash)]
  db[invoice.invoiceId] = invoice
  saveInvoices(db)
  return invoice
}

async function verifyInvoicePaymentTx(invoice, input = {}) {
  const txHash = normalizeTxHash(input.txHash, 'txHash')
  const payerAddress = input.payerAddress ? normalizeAddress(input.payerAddress, 'payerAddress') : ''
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null)
  if (!receipt) throw new Error('Payment transaction receipt not found')
  if (receipt.status !== 'success') throw new Error('Payment transaction failed on-chain')
  const expectedAmount = decimalToUnits(invoice.amount, 6)
  const merchant = getAddress(invoice.merchantAddress).toLowerCase()
  const payer = payerAddress ? payerAddress.toLowerCase() : ''
  const matched = receipt.logs.some((log) => {
    if (String(log.address).toLowerCase() !== TOKENS.USDC.toLowerCase()) return false
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics })
      if (decoded.eventName !== 'Transfer') return false
      const from = String(decoded.args?.from || '').toLowerCase()
      const to = String(decoded.args?.to || '').toLowerCase()
      const value = BigInt(decoded.args?.value || 0n)
      return to === merchant && value === expectedAmount && (!payer || from === payer)
    } catch {
      return false
    }
  })
  if (!matched) throw new Error('Payment transaction does not match invoice amount/token/recipient')
  return true
}

function pickWebhookValue(payload, keys) {
  for (const key of keys) {
    const parts = key.split('.')
    let current = payload
    for (const part of parts) current = current?.[part]
    if (current !== undefined && current !== null && String(current).trim()) return current
  }
  return ''
}

function extractWebhookFields(payload = {}) {
  const eventType = String(pickWebhookValue(payload, ['eventType', 'type', 'event.type']) || '')
  const notificationId = String(pickWebhookValue(payload, ['notificationId', 'id', 'eventId', 'event.id']) || `local_${randomUUID()}`)
  const txHash = String(pickWebhookValue(payload, [
    'txHash', 'transactionHash', 'data.txHash', 'data.transactionHash', 'event.data.txHash', 'event.data.transactionHash',
  ]) || '')
  const invoiceId = String(pickWebhookValue(payload, [
    'invoiceId', 'reference', 'memo', 'metadata.invoiceId', 'data.invoiceId', 'data.reference', 'data.memo',
    'data.metadata.invoiceId', 'event.data.invoiceId', 'event.data.metadata.invoiceId',
  ]) || '')
  return { eventType, notificationId, txHash, invoiceId }
}

function findInvoiceForWebhook(payload) {
  const fields = extractWebhookFields(payload)
  const db = loadInvoices()
  if (fields.invoiceId && db[fields.invoiceId]) return { invoice: db[fields.invoiceId], fields }
  for (const invoice of Object.values(db)) {
    if (fields.txHash && String(invoice.txHash || '').toLowerCase() === fields.txHash.toLowerCase()) return { invoice, fields }
    if (fields.invoiceId && String(invoice.memo || '').includes(fields.invoiceId)) return { invoice, fields }
  }
  return { invoice: null, fields }
}

async function processCircleGatewayWebhook(payload = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid webhook payload')
  const fields = extractWebhookFields(payload)
  if (!fields.eventType) throw new Error('Missing webhook event type')
  const eventDb = loadWebhookEvents()
  if (eventDb[fields.notificationId]) {
    return { duplicate: true, event: eventDb[fields.notificationId] }
  }
  const event = {
    id: `wh_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    provider: 'circle-gateway',
    notificationId: fields.notificationId,
    eventType: fields.eventType,
    rawPayload: payload,
    processed: false,
    matched: false,
    ...(fields.txHash ? { relatedTxHash: fields.txHash } : {}),
    createdAt: nowIso(),
  }
  eventDb[fields.notificationId] = event
  saveWebhookEvents(eventDb)

  const { invoice } = findInvoiceForWebhook(payload)
  if (!invoice) {
    event.processed = true
    event.matched = false
    event.processedAt = nowIso()
    eventDb[fields.notificationId] = event
    saveWebhookEvents(eventDb)
    return { duplicate: false, matched: false, event }
  }

  const invoiceDb = loadInvoices()
  const target = refreshInvoiceStatus(invoiceDb[invoice.invoiceId])
  const statusMap = {
    'gateway.deposit.finalized': { status: 'pending', type: 'deposit_finalized', message: 'Circle Gateway deposit finalized.' },
    'gateway.mint.forwarded': { status: 'pending', type: 'mint_forwarded', message: 'Circle Gateway mint forwarded.' },
    'gateway.mint.finalized': { status: 'paid', type: 'mint_finalized', message: 'Circle Gateway mint finalized.' },
  }
  const mapped = statusMap[fields.eventType]
  if (mapped && target.status !== 'paid') {
    target.status = mapped.status
    if (fields.txHash) target.txHash = fields.txHash
    if (mapped.status === 'paid') target.paidAt = target.paidAt || nowIso()
    target.timeline = [...(target.timeline || []), timelineEvent(mapped.type, mapped.message, fields.txHash)]
    invoiceDb[target.invoiceId] = target
    saveInvoices(invoiceDb)
  }
  event.processed = true
  event.matched = true
  event.relatedInvoiceId = target.invoiceId
  event.relatedTxHash = fields.txHash || target.txHash
  event.processedAt = nowIso()
  eventDb[fields.notificationId] = event
  saveWebhookEvents(eventDb)
  return { duplicate: false, matched: true, event, invoice: target }
}

async function getOrCreateWallet(metamaskAddr) {
  const addr = metamaskAddr.toLowerCase()
  const db = loadWallets()
  if (db[addr]) {
    const record = typeof db[addr] === 'string' ? { id: db[addr] } : db[addr]
    const res = await circleClient.getWallet({ id: record.id })
    const wallet = res.data?.wallet
    if (wallet?.id && wallet?.address && (typeof db[addr] === 'string' || db[addr].address !== wallet.address)) {
      db[addr] = { id: wallet.id, address: wallet.address }
      saveWallets(db)
    }
    return wallet
  }
  const ws = await circleClient.createWalletSet({ name: `user-${addr.slice(0,8)}` })
  const wr = await circleClient.createWallets({
    blockchains: ['ARC-TESTNET'], count: 1,
    walletSetId: ws.data?.walletSet?.id ?? '', accountType: 'SCA',
  })
  const wallet = wr.data?.wallets?.[0]
  db[addr] = { id: wallet.id, address: wallet.address }
  saveWallets(db)
  console.log(`[wallet] new: ${addr} → ${wallet.address}`)
  return wallet
}

async function pollAttestation(domain, txHash, maxRetries = 60, fastMode = false) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${txHash}`
  console.log(`[iris] polling: domain=${domain} tx=${txHash.slice(0,12)}... (fast=${fastMode})`)
  let lastStatus = ''
  for (let i = 0; i < maxRetries; i++) {
    // Adaptive delay: fast chains (instant finality) poll quicker
    let delay
    if (fastMode) {
      delay = 500
    } else if (i < 20) {
      delay = 500  // First 10s: aggressive
    } else if (i < 60) {
      delay = 1000 // Next 40s: moderate
    } else {
      delay = 2000 // After 60s: slow/patient
    }
    await new Promise(r => setTimeout(r, delay))
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!r.ok) { if (i % 10 === 0) console.log(`[iris] HTTP ${r.status} (retry ${i+1}/${maxRetries})`); continue }
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('json')) { if (i % 10 === 0) console.log('[iris] non-JSON response'); continue }
      const data = await r.json()
      const msg = data?.messages?.[0]
      const curStatus = msg?.status || 'no message'
      if (curStatus !== lastStatus || i % 10 === 0) {
        console.log(`[iris] attempt ${i+1}/${maxRetries}: ${curStatus}`)
        lastStatus = curStatus
      }
      if (msg?.status === 'complete' && msg.attestation && msg.message) {
        const elapsed = fastMode ? ((i+1)*0.5) : (i < 20 ? (i+1)*0.5 : i < 60 ? 10 + (i-20)*1 : 10 + 40 + (i-60)*2)
        console.log(`[iris] ✓ attestation ready after ~${elapsed.toFixed(1)}s`)
        return { attestation: msg.attestation, message: msg.message }
      }
    } catch(e) { if (i % 10 === 0) console.log(`[iris] error: ${e.message}`) }
  }
  return null
}

async function checkAttestationOnce(domain, txHash) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${txHash}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) return { complete: false, status: `http_${r.status}` }
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('json')) return { complete: false, status: 'non_json' }
  const data = await r.json()
  const msg = data?.messages?.[0]
  if (msg?.status === 'complete' && msg.attestation && msg.message) {
    return { complete: true, attestation: msg.attestation, message: msg.message, status: msg.status }
  }
  return { complete: false, status: msg?.status || 'no_message' }
}

// ── Health ──
app.get('/health', (_, res) => res.json({ ok: true, time: new Date(), version: '2.0.0' }))

app.get('/api/config', (_, res) => {
  res.json({ kitKey: KIT_KEY || '' })
})

function hashAgentText(text) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 ^= ch
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= ch + i
    h2 = Math.imul(h2, 0x811c9dc5)
  }
  return `0x${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`.padEnd(66, '0')
}

function agentPlanResponse({ prompt, agentId, owner, requester }) {
  const cleanPrompt = String(prompt || '').trim().slice(0, 1000)
  const budgetMatch = cleanPrompt.match(/(\d+(?:\.\d+)?)\s*(?:USDC|usd)/i)
  const suggestedBudget = budgetMatch?.[1] || '1'
  const provider = isAddress(owner || '') ? getAddress(owner) : requester
  const evaluator = isAddress(requester || '') ? getAddress(requester) : provider
  const deliverable = [
    'ARCOX hosted AI agent response',
    `Prompt: ${cleanPrompt || 'No prompt provided'}`,
    'Decision: accepted',
    `Budget: ${suggestedBudget} USDC`,
    `Provider: ${provider}`,
    `Evaluator: ${evaluator}`,
  ].join('\n')
  return {
    requestId: `hosted-agent-${Date.now()}`,
    agentId: String(agentId || 'arcox-hosted-agent'),
    status: 'accepted',
    summary: cleanPrompt ? `ARCOX hosted agent accepted: ${cleanPrompt}` : 'ARCOX hosted agent is ready.',
    suggestedProvider: provider,
    suggestedEvaluator: evaluator,
    suggestedBudget,
    deliverable,
    deliverableHash: hashAgentText(deliverable),
    nextSteps: [
      'Create the job in ARCOX DEX.',
      'Set budget and fund escrow with user wallet approval.',
      'Submit deliverable from provider wallet or terminal agent.',
      'Complete job from evaluator wallet after validation.',
    ],
  }
}

app.post('/api/agent/ask', apiLimiter, requireAuth, async (req, res) => {
  try {
    const requester = normalizeAddress(req.body?.address || req.body?.requester || req.authAddress, 'requester')
    const prompt = String(req.body?.prompt || '')
    if (!prompt.trim()) return res.status(400).json({ error: 'Prompt is required' })
    res.json(agentPlanResponse({
      prompt,
      agentId: req.body?.agentId,
      owner: req.body?.owner,
      requester,
    }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/auth/session', authLimiter, async (req, res) => {
  try {
    const { address, issuedAt, signature } = req.body || {}
    const normalized = normalizeAddress(address, 'address')
    const issuedTime = Date.parse(issuedAt)
    if (!issuedAt || !Number.isFinite(issuedTime) || Math.abs(Date.now() - issuedTime) > LOGIN_WINDOW_MS) {
      return res.status(400).json({ error: 'Login signature expired. Please reconnect wallet.' })
    }
    if (!signature || !/^0x[0-9a-f]+$/i.test(signature)) return res.status(400).json({ error: 'Invalid signature' })
    const ok = await verifyMessage({
      address: normalized,
      message: authMessage(normalized, issuedAt),
      signature,
    })
    if (!ok) return res.status(401).json({ error: 'Invalid wallet signature' })
    res.json({ success: true, token: createAuthToken(normalized), address: normalized })
  } catch(e) {
    console.error('[auth]', e.message)
    res.status(400).json({ error: e.message })
  }
})

// ── Wallet ──
app.post('/api/wallet', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { metamaskAddress } = req.body
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const w = await getOrCreateWallet(owner)
    res.json({ success: true, wallet: { id: w.id, address: w.address } })
  } catch(e) { console.error('[wallet]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Balance ──
app.get('/api/balance/:address', async (req, res) => {
  try {
    const target = normalizeAddress(req.params.address, 'address')
    const client = createPublicClient({ chain: arcTestnet, transport: http() })
    const result = {}
    for (const [sym, addr] of Object.entries(TOKENS)) {
      try {
        const bal = await client.readContract({ address: addr, abi: erc20Abi, functionName: 'balanceOf', args: [target] })
        result[sym] = formatUnits(bal, TOKEN_DECIMALS[sym] || 6)
      } catch { result[sym] = '0' }
    }
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Quote ──
app.post('/api/quote', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, amountIn } = req.body
    const tokenIn = normalizeArcToken(req.body.tokenIn)
    const tokenOut = normalizeArcToken(req.body.tokenOut)
    if (!metamaskAddress || !req.body.tokenIn || !req.body.tokenOut || !amountIn) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const safeAmount = normalizeAmount(amountIn)
    if (!KIT_KEY) return res.status(500).json({ error: 'KIT_KEY belum dikonfigurasi' })
    if (!TOKENS[tokenIn] || !TOKENS[tokenOut]) return res.status(400).json({ error: 'Unsupported token: ' + (!TOKENS[tokenIn] ? tokenIn : tokenOut) })
    if (tokenIn === tokenOut) return res.status(400).json({ error: 'Token swap harus berbeda' })
    const platformFee = splitPlatformFee(safeAmount, tokenIn)
    try {
      const wallet = await getOrCreateWallet(owner)
      const estimate = await kit.estimateSwap({
        from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
        tokenIn: swapTokenParam(tokenIn),
        tokenOut: swapTokenParam(tokenOut),
        amountIn: platformFee.netAmount,
        config: { kitKey: KIT_KEY, allowanceStrategy: 'approve' },
      })
      const fee = (estimate.fees || []).reduce((sum, f) => sum + Number(f.amount || 0), 0)
      return res.json({
        available: true,
        amountOut: estimate.estimatedOutput?.amount || '0',
        fee: fee.toFixed(6),
        platformFee: {
          bps: platformFee.feeBps,
          amount: platformFee.feeAmount,
          token: tokenIn,
          treasury: PLATFORM_TREASURY,
          swapAmountIn: platformFee.netAmount,
        },
        rate: Number(estimate.estimatedOutput?.amount || 0) / Number(safeAmount || 1),
      })
    } catch(e) {
      if (isNoSwapRouteError(e)) return noSwapRouteResponse(res, e)
      console.error('[quote]', e.message)
      return res.status(500).json({ error: e.message })
    }
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Swap ──
app.post('/api/swap', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, amountIn } = req.body
    const tokenIn = normalizeArcToken(req.body.tokenIn)
    const tokenOut = normalizeArcToken(req.body.tokenOut)
    if (!metamaskAddress || !req.body.tokenIn || !req.body.tokenOut || !amountIn) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const safeAmount = normalizeAmount(amountIn)
    if (!KIT_KEY) return res.status(500).json({ error: 'KIT_KEY belum dikonfigurasi' })
    if (!TOKENS[tokenIn] || !TOKENS[tokenOut]) return res.status(400).json({ error: 'Unsupported token: ' + (!TOKENS[tokenIn] ? tokenIn : tokenOut) })
    if (tokenIn === tokenOut) return res.status(400).json({ error: 'Token swap harus berbeda' })
    const platformFee = splitPlatformFee(safeAmount, tokenIn)
    const wallet = await getOrCreateWallet(owner)
    const params = {
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      tokenIn: swapTokenParam(tokenIn),
      tokenOut: swapTokenParam(tokenOut),
      amountIn: platformFee.netAmount,
      config: { kitKey: KIT_KEY, allowanceStrategy: 'approve' },
    }
    try {
      await kit.estimateSwap(params)
    } catch(e) {
      if (isNoSwapRouteError(e)) return noSwapRouteResponse(res, e)
      console.warn('[swap] estimate precheck failed, continuing:', e.message)
    }
    let feeResult = null
    const treasury = normalizeAddress(PLATFORM_TREASURY, 'ARCOX_FEE_TREASURY')
    if (platformFee.feeUnits > 0n) {
      feeResult = await kit.send({
        from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
        to: treasury,
        amount: platformFee.feeAmount,
        token: SEND_TOKEN_MAP[tokenIn] || TOKENS[tokenIn] || tokenIn,
      })
    }
    const result = await kit.swap(params)
    res.json({
      success: true,
      result: {
        ...result,
        grossAmountIn: safeAmount,
        amountIn: platformFee.netAmount,
        platformFee: {
          bps: platformFee.feeBps,
          amount: platformFee.feeAmount,
          token: tokenIn,
          treasury,
          txHash: feeResult?.txHash,
          explorerUrl: feeResult?.explorerUrl,
        },
      },
    })
  } catch(e) {
    if (isNoSwapRouteError(e)) return noSwapRouteResponse(res, e)
    console.error('[swap]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Prepare Bridge (Circle → EOA) ──
app.post('/api/prepare-bridge', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, amount, token } = req.body
    if (!metamaskAddress || !amount) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const safeAmount = normalizeAmount(amount)
    const bridgeToken = normalizeArcToken(token || 'USDC')
    if (!TOKENS[bridgeToken]) return res.status(400).json({ error: 'Unsupported token: ' + bridgeToken })
    const wallet = await getOrCreateWallet(owner)
    const result = await kit.send({
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      to: owner, amount: safeAmount, token: bridgeToken,
    })
    res.json({ success: true, txHash: result.txHash, explorerUrl: result.explorerUrl })
  } catch(e) { console.error('[prepare-bridge]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Get Attestation - fast via App Kit ──
app.post('/api/get-attestation', attestationLimiter, async (req, res) => {
  try {
    const { txHash, fromChain, toChain, once } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const safeTxHash = normalizeTxHash(txHash, 'txHash')
    const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3, HyperEVM_Testnet: 19, Solana_Devnet: 5 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain: ' + fromChain })
    if (toChain && domains[toChain] === undefined) return res.status(400).json({ error: 'Unknown destination chain: ' + toChain })
    const retryCfg = RETRY_CFG[fromChain] || { maxRetries: 120, fastMode: false }
    console.log(`[get-attestation] domain=${domain} tx=${safeTxHash.slice(0,12)}... retries=${retryCfg.maxRetries} fast=${retryCfg.fastMode}`)
    const att = once
      ? await checkAttestationOnce(domain, safeTxHash).then(r => r.complete ? { attestation: r.attestation, message: r.message, status: r.status } : r)
      : await pollAttestation(domain, safeTxHash, retryCfg.maxRetries, retryCfg.fastMode)
    if (once && !att?.attestation) return res.json({ success: false, pending: true, status: att?.status || 'pending' })
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Chain: ' + fromChain + ' may need more time.' })
    // Include messageTransmitter address + chainId untuk client sign via MetaMask
    let msgTx = null, dstChainId = null
    if (toChain && CCTP[toChain]) {
      msgTx = CCTP[toChain].messageTransmitter
      dstChainId = CCTP[toChain].chain.id
    }
    res.json({ success: true, attestation: att.attestation, message: att.message, domain, messageTransmitter: msgTx, chainId: dstChainId })
  } catch(e) {
    console.error('[get-attestation]', e.message)
    const status = /^Invalid |^Unknown /.test(e.message || '') ? 400 : 500
    res.status(status).json({ error: e.message })
  }
})

// ── Mint via App Kit (EVM chains) - lebih reliable dari manual receiveMessage ──
app.post('/api/mint-via-appkit', apiLimiter, requireServerSignedMintAuth, async (req, res) => {
  try {
    const { burnTxHash, fromChain, toChain, toAddress, amount: reqAmount } = req.body
    if (!burnTxHash || !fromChain || !toChain) return res.status(400).json({ error: 'Missing params' })
    const safeBurnTxHash = normalizeTxHash(burnTxHash, 'burnTxHash')
    if (toAddress) {
      const safeToAddress = normalizeAddress(toAddress, 'toAddress')
      if (safeToAddress.toLowerCase() !== req.authAddress) return res.status(403).json({ error: 'Authenticated wallet does not match mint recipient' })
    }
    if (!CCTP[fromChain] || !CCTP[toChain]) return res.status(400).json({ error: 'Unsupported bridge chain' })

      // Build RPC mapping by chain ID from CCTP config
      const RPC_BY_CHAIN_ID = {}
      for (const [, cfg] of Object.entries(CCTP)) {
        if (cfg.chain) {
          RPC_BY_CHAIN_ID[cfg.chain.id] = cfg.chain.rpcUrls.default.http[0]
        }
      }
      const viemAdapter = createViemAdapterFromPrivateKey({
        privateKey: process.env.OWNER_PRIVATE_KEY,
        getPublicClient: ({ chain }) => {
          const rpcUrl = RPC_BY_CHAIN_ID[chain.id]
          if (!rpcUrl) {
            console.warn('[mint-via-appkit] No RPC for chain ID ' + chain.id + ', using default')
            return createPublicClient({ chain, transport: http() })
          }
          return createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 3, timeout: 10000 }) })
        },
      })
    const { privateKeyToAccount } = await import('viem/accounts')
    const ownerAddress = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address
    
    // Reconstruct bridge result untuk retry
    const partialResult = {
      state: 'error',
        amount: reqAmount || '0',
      token: 'USDC',
      source: { address: ownerAddress, chain: fromChain },
      destination: { address: toAddress, chain: toChain },
      steps: [
        { name: 'approve', state: 'success' },
        { name: 'burn', state: 'success', txHash: safeBurnTxHash },
        { name: 'fetchAttestation', state: 'error', error: 'Resuming from frontend burn' },
      ],
    }

      console.log(`[mint-via-appkit] retrying chain=${fromChain} -> ${toChain} tx=${safeBurnTxHash.slice(0,12)}...`)
    const retryResult = await kit.retry(partialResult, {
      from: viemAdapter,
      to: viemAdapter,
    })
    
    if (retryResult.state === 'success') {
      const mintStep = retryResult.steps?.find(s => s.name === 'mint')
      res.json({ success: true, txHash: mintStep?.txHash, explorerUrl: CCTP[toChain]?.explorer + mintStep?.txHash })
    } else {
      res.status(400).json({ error: 'Mint failed: ' + JSON.stringify(retryResult.steps?.find(s => s.state === 'error')?.error) })
    }
  } catch(e) { console.error('[mint-via-appkit]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP Solana (Arc/EVM → Solana) - return attestation untuk Solflare sign ──
app.post('/api/mint-cctp-solana', attestationLimiter, async (req, res) => {
  try {
    const { burnTxHash, toAddress, fromChain } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })
    const safeBurnTxHash = normalizeTxHash(burnTxHash, 'burnTxHash')
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(String(toAddress))) return res.status(400).json({ error: 'Invalid Solana address' })
    if (fromChain && !CCTP[fromChain]) return res.status(400).json({ error: 'Unknown fromChain: ' + fromChain })
    const solDomain = CCTP[fromChain]?.domain ?? 26
    console.log('[mint-cctp-solana] fromChain=' + (fromChain || 'Arc_Testnet') + ' domain=' + solDomain)
    const solRetry = RETRY_CFG[fromChain || 'Arc_Testnet'] || { maxRetries: 60, fastMode: false }
    const att = await pollAttestation(solDomain, safeBurnTxHash, solRetry.maxRetries, solRetry.fastMode)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Please retry.' })

    res.json({
      success: true,
      requiresSolanaSign: true,
      attestation: att.attestation,
      message: att.message,
      toAddress,
      solanaConfig: {
        messageTransmitter: SOLANA_CCTP.messageTransmitterProgram,
        usdcMint: SOLANA_CCTP.usdcMint,
      },
    })
  } catch(e) { console.error('[mint-cctp-solana]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP dari Solana → Arc (backend sign di Arc) ──
app.post('/api/mint-cctp-from-solana', apiLimiter, requireServerSignedMintAuth, async (req, res) => {
  try {
    const { burnTxHash, toAddress } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })
    const safeBurnTxHash = normalizeTxHash(burnTxHash, 'burnTxHash')
    const safeToAddress = normalizeAddress(toAddress, 'toAddress')
    if (safeToAddress.toLowerCase() !== req.authAddress) return res.status(403).json({ error: 'Authenticated wallet does not match mint recipient' })
    const att = await pollAttestation(SOLANA_CCTP.domain, safeBurnTxHash, 120, false)
    if (!att) return res.status(400).json({ error: 'Attestation timeout from Solana. Please retry.' })
    const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY)
    const wc = createWalletClient({ account, chain: arcTestnet, transport: http() })
    const pc = createPublicClient({ chain: arcTestnet, transport: http() })
    // Retry mint up to 3 times
    let txHash
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`[mint-from-solana] attempt ${attempt+1}/3`)
        txHash = await wc.writeContract({
          address: CCTP.Arc_Testnet.messageTransmitter,
          abi: RECEIVE_MESSAGE_ABI,
          functionName: 'receiveMessage',
          args: [att.message, att.attestation],
        })
        await pc.waitForTransactionReceipt({ hash: txHash })
        break
      } catch(e) {
        console.error(`[mint-from-solana] attempt ${attempt+1} failed:`, e.message)
        if (attempt === 2) throw e
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    res.json({ success: true, txHash, explorerUrl: CCTP.Arc_Testnet.explorer + txHash })
  } catch(e) { console.error('[mint-from-solana]', e.message); res.status(500).json({ error: e.message }) }
})


// ── Mint Direct (fallback manual receiveMessage) - EVM → EVM tanpa AppKit ──
app.post('/api/mint-direct', apiLimiter, requireServerSignedMintAuth, async (req, res) => {
  try {
    const { burnTxHash, fromChain, toChain, toAddress, amount: reqAmount } = req.body
    if (!burnTxHash || !fromChain || !toChain) return res.status(400).json({ error: 'Missing params' })
    const safeBurnTxHash = normalizeTxHash(burnTxHash, 'burnTxHash')
    if (toAddress) {
      const safeToAddress = normalizeAddress(toAddress, 'toAddress')
      if (safeToAddress.toLowerCase() !== req.authAddress) return res.status(403).json({ error: 'Authenticated wallet does not match mint recipient' })
    }

    const fromInfo = CCTP[fromChain]
    if (!fromInfo) return res.status(400).json({ error: 'Unknown fromChain: ' + fromChain })
    const toInfo = CCTP[toChain]
    if (!toInfo) return res.status(400).json({ error: 'Unknown toChain: ' + toChain })

    // 1. Poll attestation
    const dirRetry = RETRY_CFG[fromChain] || { maxRetries: 120, fastMode: false }
    console.log('[mint-direct] polling attestation domain=' + fromInfo.domain + ' from=' + fromChain + ' to=' + toChain + ' retries=' + dirRetry.maxRetries)
    const att = await pollAttestation(fromInfo.domain, safeBurnTxHash, dirRetry.maxRetries, dirRetry.fastMode)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Please retry.' })

    // 2. receiveMessage via backend viem wallet
    const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY)
    const RPC_BY_CHAIN_ID = {}
    for (const [, cfg] of Object.entries(CCTP)) {
      if (cfg.chain) RPC_BY_CHAIN_ID[cfg.chain.id] = cfg.chain.rpcUrls.default.http[0]
    }
    const rpcUrl = RPC_BY_CHAIN_ID[toInfo.chain.id]
    if (!rpcUrl) return res.status(500).json({ error: 'No RPC for destination chain ID: ' + toInfo.chain.id })
    const wc = createWalletClient({ account, chain: toInfo.chain, transport: http(rpcUrl) })
    const pc = createPublicClient({ chain: toInfo.chain, transport: http(rpcUrl) })

    // 3. Send receiveMessage with retry
    let txHash
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log('[mint-direct] attempt ' + (attempt+1) + '/3')
        txHash = await wc.writeContract({
          address: toInfo.messageTransmitter,
          abi: RECEIVE_MESSAGE_ABI,
          functionName: 'receiveMessage',
          args: [att.message, att.attestation],
        })
        await pc.waitForTransactionReceipt({ hash: txHash })
        break
      } catch(e) {
        console.error('[mint-direct] attempt ' + (attempt+1) + ' failed:', e.message)
        if (attempt === 2) throw e
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    res.json({ success: true, txHash, explorerUrl: toInfo.explorer + txHash })
  } catch(e) { console.error('[mint-direct]', e.message); res.status(500).json({ error: e.message }) }
})
// ── Send ──
app.post('/api/send-estimate', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, toAddress, amount, source } = req.body
    const token = normalizeArcToken(req.body.token)
    if (!metamaskAddress || !toAddress || !amount || !token) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const destination = normalizeAddress(toAddress, 'toAddress')
    const safeAmount = normalizeAmount(amount)
    if (source === 'eoa') return res.status(400).json({ error: 'EOA estimate dihitung langsung dari wallet browser.' })
    if (!SEND_TOKEN_MAP[token]) return res.status(400).json({ error: 'Unsupported token: ' + token })
    const resolvedToken = SEND_TOKEN_MAP[token] || token
    const wallet = await getOrCreateWallet(owner)
    const platformFee = splitPlatformFee(safeAmount, token)
    const params = {
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      to: destination,
      amount: platformFee.netAmount,
      token: resolvedToken,
    }
    const estimate = await kit.estimateSend(params)
    const fee = estimate?.fee || estimate?.estimatedFee || estimate?.gasFee || estimate?.totalFee || ''
    res.json({
      success: true,
      fee: typeof fee === 'object' ? fee.amount : String(fee || '-'),
      token: typeof fee === 'object' ? (fee.token || 'USDC') : 'USDC',
      detail: estimate?.gas ? `${estimate.gas} gas` : 'App Kit estimate',
      platformFee: {
        bps: platformFee.feeBps,
        amount: platformFee.feeAmount,
        token,
        treasury: normalizeAddress(PLATFORM_TREASURY, 'ARCOX_FEE_TREASURY'),
      },
      grossAmount: safeAmount,
      recipientReceives: platformFee.netAmount,
      estimate,
    })
  } catch(e) { console.error('[send-estimate]', e.message); res.status(500).json({ error: e.message }) }
})

app.post('/api/send', apiLimiter, requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, toAddress, amount, source } = req.body
    const token = normalizeArcToken(req.body.token)
    if (!metamaskAddress || !toAddress || !amount || !token) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const destination = normalizeAddress(toAddress, 'toAddress')
    const safeAmount = normalizeAmount(amount)
    if (!SEND_TOKEN_MAP[token]) return res.status(400).json({ error: 'Unsupported token: ' + token })
    const resolvedToken = SEND_TOKEN_MAP[token] || token
    if (source === 'eoa') {
      return res.status(400).json({ error: 'EOA send harus ditandatangani langsung dari wallet browser.' })
    }
    const wallet = await getOrCreateWallet(owner)
    const fromCtx = { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address }
    const platformFee = splitPlatformFee(safeAmount, token)
    const treasury = normalizeAddress(PLATFORM_TREASURY, 'ARCOX_FEE_TREASURY')
    let feeResult = null
    if (platformFee.feeUnits > 0n) {
      feeResult = await kit.send({ from: fromCtx, to: treasury, amount: platformFee.feeAmount, token: resolvedToken })
    }
    const result = await kit.send({ from: fromCtx, to: destination, amount: platformFee.netAmount, token: resolvedToken })
    res.json({
      success: true,
      result: {
        ...result,
        grossAmount: safeAmount,
        amount: platformFee.netAmount,
        platformFee: {
          bps: platformFee.feeBps,
          amount: platformFee.feeAmount,
          token,
          treasury,
          txHash: feeResult?.txHash,
          explorerUrl: feeResult?.explorerUrl,
        },
      },
    })
  } catch(e) { console.error('[send]', e.message); res.status(500).json({ error: e.message }) }
})

app.get('/api/tx-history', apiLimiter, requireAuth, async (req, res) => {
  try {
    const db = loadTxHistory()
    const items = Array.isArray(db[req.authAddress]) ? db[req.authAddress] : []
    res.json({ success: true, history: items.slice(0, 100) })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/tx-history', apiLimiter, requireAuth, async (req, res) => {
  try {
    const owner = req.body?.metamaskAddress || req.body?.owner || req.authAddress
    const rec = appendTxHistory(owner, req.body?.record || req.body)
    res.json({ success: true, record: rec })
  } catch(e) { console.error('[tx-history]', e.message); res.status(400).json({ error: e.message }) }
})

// ── ARCOX Pay invoices ──
app.post('/api/invoices', apiLimiter, async (req, res) => {
  try {
    res.json(createInvoice(req.body || {}))
  } catch(e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/invoices/:invoiceId', apiLimiter, async (req, res) => {
  try {
    res.json(getInvoiceOrThrow(req.params.invoiceId))
  } catch(e) {
    res.status(404).json({ error: e.message })
  }
})

app.patch('/api/invoices/:invoiceId', apiLimiter, async (req, res) => {
  try {
    res.json(patchInvoice(req.params.invoiceId, req.body || {}))
  } catch(e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/invoices/:invoiceId/status', apiLimiter, async (req, res) => {
  try {
    const invoice = getInvoiceOrThrow(req.params.invoiceId)
    res.json({
      invoiceId: invoice.invoiceId,
      orderId: invoice.orderId,
      amount: invoice.amount,
      token: invoice.token,
      network: invoice.network,
      status: invoice.status,
      merchantAddress: invoice.merchantAddress,
      txHash: invoice.txHash,
      payerAddress: invoice.payerAddress,
      paidAt: invoice.paidAt,
      expiresAt: invoice.expiresAt,
      timeline: invoice.timeline || [],
    })
  } catch(e) {
    res.status(404).json({ error: e.message })
  }
})

app.post('/api/invoices/:invoiceId/mark-paid', apiLimiter, async (req, res) => {
  try {
    if (!ENABLE_DEV_TOOLS) {
      const invoice = getInvoiceOrThrow(req.params.invoiceId)
      await verifyInvoicePaymentTx(invoice, req.body || {})
    }
    res.json(markInvoicePaid(req.params.invoiceId, req.body || {}))
  } catch(e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/webhooks/circle-gateway', apiLimiter, async (req, res) => {
  try {
    // TODO: verify Circle Gateway webhook signature once Circle webhook secret/header format is configured.
    const result = await processCircleGatewayWebhook(req.body || {})
    res.json({ ok: true, ...result })
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

app.post('/api/dev/simulate-webhook', apiLimiter, async (req, res) => {
  try {
    if (!ENABLE_DEV_TOOLS) return res.status(404).json({ error: 'Dev tools disabled' })
    const invoiceId = String(req.body?.invoiceId || '')
    const eventType = String(req.body?.eventType || 'gateway.mint.finalized')
    const txHash = String(req.body?.txHash || '')
    const payload = {
      notificationId: `sim_${invoiceId}_${eventType}_${txHash || Date.now()}`,
      eventType,
      invoiceId,
      data: { invoiceId, txHash, metadata: { invoiceId } },
    }
    const result = await processCircleGatewayWebhook(payload)
    const invoice = invoiceId ? getInvoiceOrThrow(invoiceId) : undefined
    res.json({ ok: true, ...result, invoice })
  } catch(e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/eco/route-preview', apiLimiter, withX402PaymentRequired(async (req, res) => {
  try {
    res.json(await quoteEcoRoutePayment(req.body || {}))
  } catch(e) {
    res.status(400).json({ error: e.message })
  }
}, {
  enabled: String(process.env.X402_ENABLED || 'false').toLowerCase() === 'true',
  price: '0.01',
  token: process.env.X402_DEFAULT_TOKEN || 'USDC',
  network: process.env.X402_DEFAULT_NETWORK || 'arc-testnet',
  recipient: process.env.X402_FEE_WALLET || '',
  resource: '/api/eco/route-preview',
}))

// ── History ──
app.get('/api/history/:address', async (req, res) => {
  try {
    const target = normalizeAddress(req.params.address, 'address')
    const r = await fetch(`https://testnet.arcscan.app/api/v2/addresses/${target}/transactions?filter=to%7Cfrom&limit=10`)
    const data = await r.json()
    const txs = (data.items || []).slice(0, 10).map(tx => ({ hash: tx.hash, method: tx.method || 'transfer', from: tx.from?.hash, to: tx.to?.hash, timestamp: tx.timestamp, status: tx.status }))
    res.json({ txs })
  } catch { res.json({ txs: [] }) }
})

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════╗`)
  console.log(`║  Arc DEX API v2.0 :${PORT}        ║`)
  console.log(`║  EVM Bridge + Solana CCTP      ║`)
  console.log(`╚════════════════════════════════╝\n`)
  console.log('Routes: health, wallet, balance, quote, swap, prepare-bridge,')
  console.log('        get-attestation, mint-cctp-solana, mint-cctp-from-solana, send, history')
  console.log('        invoices, circle-gateway webhook, eco route-preview')
})
