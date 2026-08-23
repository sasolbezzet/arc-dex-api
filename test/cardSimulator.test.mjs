import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the simulator DB per test run BEFORE importing so the module-level
// AGENT_CARDS_DB capture points at a temp dir (never the production file).
const tempDir = mkdtempSync(join(tmpdir(), 'cards-test-'))
const dbFile = join(tempDir, 'cards-db.json')
writeFileSync(dbFile, '{"cards":[],"transactions":[],"ledger":{}}')
process.env.AGENT_CARDS_DB = dbFile

const {
  cardConfig,
  listMerchants,
  getOwnerBalance,
  fundTestBalance,
  createCard,
  updateCardLimits,
  setCardStatus,
  spendWithCard,
  refundCardTransaction,
  listCardTransactions,
  authorizeCardSpend,
  settleCardTransaction,
  listCards,
} = await import('../src/services/cardSimulator.mjs')

const OWNER = '0xabc123'
const MERCHANT = 'm_arcmart'

describe('card simulator', () => {
  before(() => {
    writeFileSync(dbFile, '{"cards":[],"transactions":[],"ledger":{}}')
  })
  after(() => {
    writeFileSync(dbFile, '{"cards":[],"transactions":[],"ledger":{}}')
  })

  test('config + merchants', () => {
    const cfg = cardConfig()
    assert.equal(cfg.mode, 'simulator')
    assert.equal(cfg.brand, 'Visa Test')
    assert.ok(cfg.maxCardsPerOwner > 0)
    assert.ok(listMerchants().length >= 5)
  })

  test('balance auto-funding + explicit top-up', () => {
    const bal = getOwnerBalance(OWNER)
    assert.equal(bal.balance, '100')
    const funded = fundTestBalance(OWNER, '25')
    assert.equal(funded.balance, '125')
  })

  test('create card returns masked pan by default', () => {
    const card = createCard(OWNER, { label: 'Ops', perTxLimit: '25', dailyLimit: '50' })
    assert.match(card.cardId, /^acard_/)
    assert.equal(card.brand, 'Visa Test')
    assert.equal(card.status, 'active')
    // createCard returns the full PAN; the default listing masks it
    assert.match(card.pan, /^4485\d{12}$/)
    const listed = listCards(OWNER)[0]
    assert.match(listed.pan, /••/)
    assert.notEqual(listed.pan, card.pan)
    assert.equal(listed.last4, card.pan.slice(-4))
    assert.equal(card.limits.perTx, '25')
    assert.equal(card.limits.daily, '50')
    assert.ok(listCards(OWNER)?.length >= 1)
  })

  test('spend settles and debits balance', () => {
    const spendOwner = `${OWNER}spend`
    const card = createCard(spendOwner, { perTxLimit: '25', dailyLimit: '50' })
    const result = spendWithCard(spendOwner, card.cardId, { merchantId: MERCHANT, amount: '12.5', description: 'Gadget' })
    assert.equal(result.approved, true)
    assert.equal(result.status, 'settled')
    assert.equal(result.amount, '12.5')
    const bal = getOwnerBalance(spendOwner)
    assert.equal(bal.balance, '87.5') // 100 funded - 12.5 spend
  })

  test('per-transaction limit declined', () => {
    const card = createCard(OWNER, { perTxLimit: '10', dailyLimit: '50' })
    const result = spendWithCard(OWNER, card.cardId, { merchantId: MERCHANT, amount: '25' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'per_tx_limit_exceeded')
  })

  test('daily limit declines cumulative spend', () => {
    const dailyOwner = `${OWNER}daily`
    const card = createCard(dailyOwner, { perTxLimit: '30', dailyLimit: '25' })
    const first = spendWithCard(dailyOwner, card.cardId, { merchantId: MERCHANT, amount: '20' })
    assert.equal(first.approved, true)
    const second = spendWithCard(dailyOwner, card.cardId, { merchantId: MERCHANT, amount: '10' })
    assert.equal(second.approved, false)
    assert.equal(second.declineReason, 'daily_limit_exceeded')
  })

  test('insufficient funds declined', () => {
    // fresh owner so the balance is exactly 100 USDC
    const smallOwner = `${OWNER}f`
    const card = createCard(smallOwner, { perTxLimit: '100000', dailyLimit: '100000' })
    const result = spendWithCard(smallOwner, card.cardId, { merchantId: MERCHANT, amount: '99999' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'insufficient_funds')
  })

  test('unknown merchant declined', () => {
    const card = createCard(OWNER)
    const result = spendWithCard(OWNER, card.cardId, { merchantId: 'm_unknown', amount: '5' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'bad_merchant')
  })

  test('frozen card declined', () => {
    const frozenOwner = `${OWNER}frozen`
    const card = createCard(frozenOwner)
    setCardStatus(frozenOwner, card.cardId, 'frozen')
    const result = spendWithCard(frozenOwner, card.cardId, { merchantId: MERCHANT, amount: '5' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'card_frozen')
    setCardStatus(frozenOwner, card.cardId, 'active')
  })

  test('category blocked declined', () => {
    const catOwner = `${OWNER}cat`
    const card = createCard(catOwner, { blockedCategories: ['nft'] })
    const result = spendWithCard(catOwner, card.cardId, { merchantId: 'm_mintify', amount: '5' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'category_blocked')
  })

  test('authorize then settle two-phase', () => {
    const twoPhaseOwner = `${OWNER}two`
    const card = createCard(twoPhaseOwner, { perTxLimit: '50', dailyLimit: '50' })
    const auth = authorizeCardSpend(twoPhaseOwner, card.cardId, { merchantId: MERCHANT, amount: '7' })
    assert.equal(auth.approved, true)
    assert.equal(auth.status, 'authorized')
    const settled = settleCardTransaction(twoPhaseOwner, auth.txId)
    assert.equal(settled.settled, true)
    assert.equal(settled.tx.status, 'settled')
  })

  test('refund returns test USDC', () => {
    const refundOwner = `${OWNER}refund`
    const card = createCard(refundOwner, { perTxLimit: '50', dailyLimit: '50' })
    const before = getOwnerBalance(refundOwner).balance
    const spend = spendWithCard(refundOwner, card.cardId, { merchantId: MERCHANT, amount: '5' })
    const after = getOwnerBalance(refundOwner).balance
    const refund = refundCardTransaction(refundOwner, spend.txId)
    assert.equal(refund.refunded, true)
    assert.equal(getOwnerBalance(refundOwner).balance, before)
  })

  test('transactions list and filter', () => {
    const txOwner = `${OWNER}tx`
    const card = createCard(txOwner, { perTxLimit: '50', dailyLimit: '50' })
    spendWithCard(txOwner, card.cardId, { merchantId: MERCHANT, amount: '3' })
    spendWithCard(txOwner, card.cardId, { merchantId: 'm_coffee', amount: '2' })
    const all = listCardTransactions(txOwner)
    assert.ok(all.length >= 2)
    const byCard = listCardTransactions(txOwner, card.cardId)
    assert.ok(byCard.length >= 2)
    assert.ok(byCard.every(t => t.status === 'settled'))
  })

  test('full pan is Luhn-valid', () => {
    const card = createCard(`${OWNER}luhn`)
    // verify Luhn checksum
    let sum = 0
    let double = false
    for (let i = card.pan.length - 1; i >= 0; i -= 1) {
      let digit = Number(card.pan[i])
      if (double) {
        digit *= 2
        if (digit > 9) digit -= 9
      }
      sum += digit
      double = !double
    }
    assert.equal(sum % 10, 0)
  })
})