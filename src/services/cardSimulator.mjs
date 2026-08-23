// ARCOX Card Simulator (test mode).
//
// Issues virtual Visa test cards (PAN 4485-...) and simulates the full card
// lifecycle without any external card network: create card → agent spend at a
// simulated merchant → authorization checks against per-card limits (per-tx /
// daily / monthly) and a simulated USDC balance → settle (debit) → refund
// (credit). Everything is persisted to a local JSON file so restarts survive.
//
// This is explicitly a TEST/demo provider: no real money moves. A future live
// adapter (e.g. Stripe Issuing) should implement the same surface.

import { randomUUID } from 'crypto'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'

export const CARD_CONFIG = Object.freeze({
  mode: 'simulator',
  brand: 'Visa Test',
  network: 'visa',
  scheme: 'simulated',
  asset: 'USDC',
  chain: 'arc-testnet',
  bint: '4485', // test BIN for Visa
  maxCardsPerOwner: Number(process.env.CARDS_MAX_PER_OWNER || 10),
  defaultBalance: String(process.env.CARDS_DEFAULT_BALANCE_USDC || '100'),
  note: 'Simulated card network. No real money moves; balances are test USDC credited per owner.',
})

export const MERCHANTS = [
  { merchantId: 'm_arcmart', name: 'ArcMart', category: 'electronics', emoji: '🛒', description: 'Gadgets & crypto hardware' },
  { merchantId: 'm_coffee', name: 'Coffee Chain', category: 'food', emoji: '☕', description: 'Coffee & snacks' },
  { merchantId: 'm_cloudhost', name: 'CloudHost AI', category: 'saas', emoji: '☁️', description: 'AI cloud compute' },
  { merchantId: 'm_codeforge', name: 'CodeForge Tools', category: 'software', emoji: '🧰', description: 'Dev tools & licenses' },
  { merchantId: 'm_mintify', name: 'Mintify', category: 'nft', emoji: '🎨', description: 'NFT market' },
  { merchantId: 'm_neonstream', name: 'NeonStream', category: 'entertainment', emoji: '🎬', description: 'Streaming' },
  { merchantId: 'm_megatrade', name: 'MegaTrade', category: 'marketplace', emoji: '🏬', description: 'Marketplace' },
  { merchantId: 'm_auroraair', name: 'Aurora Airlines', category: 'travel', emoji: '✈️', description: 'Flights' },
]

export const MERCHANT_BY_ID = Object.fromEntries(MERCHANTS.map(m => [m.merchantId, m]))

const USDC_DECIMALS = 1_000_000n

function toUnits(value) {
  const normalized = String(value ?? '0').trim()
  if (!/^\d+(\.\d+)?$/.test(normalized)) return 0n
  const [whole = '0', fraction = ''] = normalized.split('.')
  return BigInt(whole) * USDC_DECIMALS + BigInt((fraction || '').padEnd(6, '0').slice(0, 6) || '0')
}

function toUsdc(units) {
  const base = units / USDC_DECIMALS
  const frac = (units % USDC_DECIMALS).toString().padStart(6, '0').replace(/0+$/, '')
  return `${base.toString()}${frac ? `.${frac}` : ''}`
}

function toUnitsOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const units = toUnits(value)
  if (units < 0n) throw new Error('amount/limit must not be negative')
  return units
}

function dbPath() {
  return process.env.AGENT_CARDS_DB || 'agent-cards-db.json'
}

function loadDb() {
  const db = readJsonFile(dbPath(), { cards: [], transactions: [], ledger: {} })
  if (!Array.isArray(db.cards)) db.cards = []
  if (!Array.isArray(db.transactions)) db.transactions = []
  if (!db.ledger || typeof db.ledger !== 'object') db.ledger = {}
  return db
}

function save(db) {
  atomicWriteJsonFile(dbPath(), db)
}

function ownerKey(owner) {
  return String(owner || '').toLowerCase()
}

function ledgerEntry(db, owner) {
  const key = ownerKey(owner)
  if (!db.ledger[key]) db.ledger[key] = { balance: '0', fundedAt: null }
  return db.ledger[key]
}

function ensureFunding(db, owner) {
  const entry = ledgerEntry(db, owner)
  if (toUnits(entry.balance) === 0n) {
    entry.balance = CARD_CONFIG.defaultBalance
    entry.fundedAt = new Date().toISOString()
  }
  return entry
}

function luhnCheckDigit(partial) {
  // The partial body has odd length (15), so its rightmost digit sits at
  // position-2 of the full PAN and must be doubled first. The verifier walks
  // the full PAN from the check digit (never doubled) — the two parities only
  // agree when the generator starts with double = true.
  let sum = 0
  let double = true
  for (let i = partial.length - 1; i >= 0; i -= 1) {
    let digit = Number(partial[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return (10 - (sum % 10)) % 10
}

function generatePan() {
  // 4482-xxxx-xxxx-xxxx: 15 digits + Luhn check digit = 16
  const body = `${CARD_CONFIG.bint}${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`
  return `${body}${luhnCheckDigit(body)}`
}

function maskPan(pan) {
  return `${pan.slice(0, 6)}••••••${pan.slice(-4)}`
}

function usageWindow(now = new Date()) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const month = new Date(now.getFullYear(), now.getMonth(), 1)
  return { todayStart: day.toISOString(), monthStart: month.toISOString() }
}

function usedToday(db, card, now) {
  const { todayStart } = usageWindow(now)
  return db.transactions
    .filter(t => t.cardId === card.cardId && t.status === 'settled' && t.createdAt >= todayStart)
    .reduce((sum, t) => sum + toUnits(t.amount), 0n)
}

function usedThisMonth(db, card, now) {
  const { monthStart } = usageWindow(now)
  return db.transactions
    .filter(t => t.cardId === card.cardId && t.status === 'settled' && t.createdAt >= monthStart)
    .reduce((sum, t) => sum + toUnits(t.amount), 0n)
}

function publicCard(card, includePan = false) {
  return {
    cardId: card.cardId,
    owner: card.owner,
    label: card.label,
    brand: card.brand,
    network: card.network,
    last4: card.pan.slice(-4),
    pan: includePan ? card.pan : maskPan(card.pan),
    cvv: includePan ? card.cvv : undefined,
    expMonth: card.expMonth,
    expYear: card.expYear,
    status: card.status,
    blockedCategories: card.blockedCategories || [],
    limits: { ...card.limits },
    usage: card.usage || { today: '0', month: '0' },
    createdAt: card.createdAt,
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function cardConfig() {
  return { ...CARD_CONFIG, merchantCount: MERCHANTS.length }
}

export function listMerchants() {
  return MERCHANTS.map(m => ({ ...m }))
}

export function fundTestBalance(owner, amountUsdc) {
  const db = loadDb()
  const entry = ledgerEntry(db, owner)
  const next = toUnits(entry.balance) + toUnits(amountUsdc)
  entry.balance = toUsdc(next)
  save(db)
  return { owner: ownerKey(owner), balance: entry.balance }
}

export function getOwnerBalance(owner) {
  const db = loadDb()
  const entry = ensureFunding(db, owner)
  save(db)
  return { owner: ownerKey(owner), balance: entry.balance, asset: 'USDC', simulated: true }
}

export function listCards(owner, { includePan = false } = {}) {
  const db = loadDb()
  return db.cards
    .filter(c => ownerKey(c.owner) === ownerKey(owner))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(c => publicCard(c, includePan))
}

export function getCard(owner, cardId, { includePan = false } = {}) {
  const db = loadDb()
  const card = db.cards.find(c => c.cardId === cardId && ownerKey(c.owner) === ownerKey(owner))
  if (!card) return null
  return publicCard(card, includePan)
}

export function createCard(owner, { label = 'Agent Card', perTxLimit, dailyLimit, monthlyLimit, blockedCategories = [] } = {}) {
  const db = loadDb()
  const key = ownerKey(owner)
  ensureFunding(db, key)
  const ownerCards = db.cards.filter(c => ownerKey(c.owner) === key)
  if (ownerCards.length >= CARD_CONFIG.maxCardsPerOwner) {
    const error = new Error(`Max ${CARD_CONFIG.maxCardsPerOwner} test cards per owner`)
    error.statusCode = 429
    throw error
  }
  const now = new Date()
  const pan = generatePan()
  const perTx = toUnitsOrNull(perTxLimit ?? '25')
  const daily = toUnitsOrNull(dailyLimit ?? '100')
  const monthly = toUnitsOrNull(monthlyLimit ?? '')
  const card = {
    cardId: `acard_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    owner: key,
    label: String(label || 'Agent Card').slice(0, 60),
    brand: CARD_CONFIG.brand,
    network: CARD_CONFIG.network,
    pan,
    cvv: String(Math.floor(100 + Math.random() * 900)),
    expMonth: String(1 + Math.floor(Math.random() * 12)).padStart(2, '0'),
    expYear: String(new Date().getFullYear() + 3),
    status: 'active',
    limits: {
      perTx: perTx === null ? '' : toUsdc(perTx),
      daily: daily === null ? '' : toUsdc(daily),
      monthly: monthly === null ? '' : toUsdc(monthly),
    },
    blockedCategories: (blockedCategories || []).slice(0, 10).map(String),
    usage: { today: '0', month: '0' },
    createdAt: now.toISOString(),
  }
  db.cards.push(card)
  save(db)
  return publicCard(card, true)
}

export function updateCardLimits(owner, cardId, { perTxLimit, dailyLimit, monthlyLimit } = {}) {
  const db = loadDb()
  const card = db.cards.find(c => c.cardId === cardId && ownerKey(c.owner) === ownerKey(owner))
  if (!card) {
    const error = new Error('Card not found')
    error.statusCode = 404
    throw error
  }
  if (perTxLimit !== undefined) {
    const units = toUnitsOrNull(perTxLimit)
    if (units !== null) card.limits.perTx = toUsdc(units)
  }
  if (dailyLimit !== undefined) {
    const units = toUnitsOrNull(dailyLimit)
    if (units !== null) card.limits.daily = toUsdc(units)
  }
  if (monthlyLimit !== undefined) {
    const units = toUnitsOrNull(monthlyLimit)
    if (units !== null) card.limits.monthly = toUsdc(units)
  }
  save(db)
  return publicCard(card)
}

export function setCardStatus(owner, cardId, status) {
  if (!['active', 'frozen', 'closed'].includes(status)) {
    const error = new Error('status must be active|frozen|closed')
    error.statusCode = 400
    throw error
  }
  const db = loadDb()
  const card = db.cards.find(c => c.cardId === cardId && ownerKey(c.owner) === ownerKey(owner))
  if (!card) {
    const error = new Error('Card not found')
    error.statusCode = 404
    throw error
  }
  card.status = status
  save(db)
  return publicCard(card)
}

function authorizeGuardCheck(card, merchant, amountUnits, now, db) {
  if (card.status === 'closed') return { code: 'card_closed', message: 'Card is closed' }
  if (card.status === 'frozen') return { code: 'card_frozen', message: 'Card is frozen' }
  const perTx = toUnitsOrNull(card.limits.perTx)
  if (perTx !== null && amountUnits > perTx) {
    return { code: 'per_tx_limit_exceeded', message: `Amount exceeds per-transaction limit (${toUsdc(perTx)} USDC)` }
  }
  const daily = toUnitsOrNull(card.limits.daily)
  if (daily !== null) {
    const spentToday = usedToday(db, card, now)
    if (spentToday + amountUnits > daily) {
      return { code: 'daily_limit_exceeded', message: `Daily limit reached (${toUsdc(daily)} USDC / day)` }
    }
  }
  const monthly = toUnitsOrNull(card.limits.monthly)
  if (monthly !== null) {
    const spentMonth = usedThisMonth(db, card, now)
    if (spentMonth + amountUnits > monthly) {
      return { code: 'monthly_limit_exceeded', message: `Monthly limit reached (${toUsdc(monthly)} USDC / month)` }
    }
  }
  const entry = ledgerEntry(db, card.owner)
  if (toUnits(entry.balance) < amountUnits) {
    return { code: 'insufficient_funds', message: `Insufficient test balance (${entry.balance} USDC available)` }
  }
  const blocked = card.blockedCategories || []
  if (blocked.includes(merchant.category)) {
    return { code: 'category_blocked', message: `Category "${merchant.category}" is blocked for this card` }
  }
  return { ok: true }
}

function declined(code, message, merchantId, amount, description) {
  const merchant = MERCHANT_BY_ID[merchantId]
  return {
    approved: false,
    declineReason: code,
    message,
    merchantId,
    merchantName: merchant?.name || '',
    category: merchant?.category || '',
    amount: toUsdc(toUnits(amount)),
    description: String(description || '').slice(0, 200),
  }
}

export function authorizeCardSpend(owner, cardId, { merchantId, amount, description = '' }) {
  const db = loadDb()
  const key = ownerKey(owner)
  const card = db.cards.find(c => c.cardId === cardId && ownerKey(c.owner) === key)
  if (!card) return declined('card_not_found', 'Card not found', merchantId, amount, description)
  const merchant = MERCHANT_BY_ID[merchantId]
  if (!merchant) return declined('bad_merchant', `Unknown merchant ${merchantId}`, merchantId, amount, description)
  let amountUnits = 0n
  try {
    amountUnits = toUnits(amount)
  } catch {
    return declined('bad_amount', 'Amount must be a valid number', merchantId, amount, description)
  }
  if (amountUnits <= 0n) return declined('bad_amount', 'Amount must be positive', merchantId, amount, description)

  const guard = authorizeGuardCheck(card, merchant, amountUnits, new Date(), db)
  if (!guard.ok) return declined(guard.code, guard.message, merchantId, amount, description)

  const tx = {
    id: `ctx_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    cardId: card.cardId,
    owner: key,
    merchantId,
    merchantName: merchant.name,
    category: merchant.category,
    description: String(description || 'Card purchase').slice(0, 200),
    amount: toUsdc(amountUnits),
    status: 'authorized',
    authCode: `AUTH${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
    createdAt: new Date().toISOString(),
    settledAt: null,
    refundedAt: null,
    declineReason: '',
  }
  db.transactions.push(tx)
  save(db)
  return {
    approved: true,
    txId: tx.id,
    authCode: tx.authCode,
    cardId: card.cardId,
    merchant: { ...merchant },
    amount: tx.amount,
    status: 'authorized',
    hold: tx.amount,
  }
}

export function settleCardTransaction(owner, txId) {
  const db = loadDb()
  const key = ownerKey(owner)
  const tx = db.transactions.find(t => t.id === txId && t.owner === key)
  if (!tx) {
    const error = new Error('Transaction not found')
    error.statusCode = 404
    throw error
  }
  if (tx.status === 'settled') return { settled: true, tx }
  if (tx.status !== 'authorized') return { settled: false, tx }
  const entry = ledgerEntry(db, key)
  const amountUnits = toUnits(tx.amount)
  if (toUnits(entry.balance) < amountUnits) {
    tx.status = 'declined'
    tx.declineReason = 'insufficient_funds'
    tx.settledAt = new Date().toISOString()
    save(db)
    return { settled: false, tx }
  }
  entry.balance = toUsdc(toUnits(entry.balance) - amountUnits)
  tx.status = 'settled'
  tx.settledAt = new Date().toISOString()
  const card = db.cards.find(c => c.cardId === tx.cardId)
  if (card) {
    card.usage.today = toUsdc(usedToday(db, card, new Date()))
    card.usage.month = toUsdc(usedThisMonth(db, card, new Date()))
  }
  save(db)
  return { settled: true, tx }
}

export function spendWithCard(owner, cardId, { merchantId, amount, description = '' }) {
  const auth = authorizeCardSpend(owner, cardId, { merchantId, amount, description })
  if (!auth.approved) return auth
  const { settled, tx } = settleCardTransaction(owner, auth.txId)
  if (!settled) {
    return { approved: false, declineReason: 'settlement_failed', message: 'Authorization cleared but settlement failed (insufficient funds)', tx }
  }
  return {
    approved: true,
    txId: tx.id,
    authCode: tx.authCode,
    cardId: tx.cardId,
    merchant: { merchantId: tx.merchantId, name: tx.merchantName, category: tx.category },
    amount: tx.amount,
    status: 'settled',
    settledAt: tx.settledAt,
  }
}

export function refundCardTransaction(owner, txId) {
  const db = loadDb()
  const key = ownerKey(owner)
  const tx = db.transactions.find(t => t.id === txId && t.owner === key)
  if (!tx) {
    const error = new Error('Transaction not found')
    error.statusCode = 404
    throw error
  }
  if (tx.status !== 'settled') {
    return { refunded: false, reason: `only settled transactions can be refunded (current: ${tx.status})`, tx }
  }
  const entry = ledgerEntry(db, key)
  entry.balance = toUsdc(toUnits(entry.balance) + toUnits(tx.amount))
  tx.status = 'refunded'
  tx.refundedAt = new Date().toISOString()
  const card = db.cards.find(c => c.cardId === tx.cardId)
  if (card) {
    card.usage.today = toUsdc(usedToday(db, card, new Date()))
    card.usage.month = toUsdc(usedThisMonth(db, card, new Date()))
  }
  save(db)
  return { refunded: true, txId: tx.id, amount: tx.amount, balance: entry.balance }
}

export function listCardTransactions(owner, cardId = null) {
  const db = loadDb()
  return db.transactions
    .filter(t => t.owner === ownerKey(owner) && (!cardId || t.cardId === cardId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(t => ({ ...t }))
}

export function clearAllCards(owner) {
  const db = loadDb()
  db.cards = db.cards.filter(c => ownerKey(c.owner) !== ownerKey(owner))
  db.transactions = db.transactions.filter(t => t.owner !== ownerKey(owner))
  save(db)
  return { cleared: true }
}