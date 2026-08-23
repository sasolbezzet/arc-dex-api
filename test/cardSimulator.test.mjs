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
process.env.CARDS_SYNC_ONCHAIN = 'false'

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
  syncCardBalance,
  listCards,
} = await import('../src/services/cardSimulator.mjs')

const OWNER = '0xabc123'
const MERCHANT = 'm_arcmart'

describe('card simulator', () => {
  before(() => {
    writeFileSync(dbFile, '{"cards":[],"transactions":[],"ledger":{}}')
  })
  after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('config + merchants', () => {
    const cfg = cardConfig()
    assert.equal(cfg.mode, 'hybrid')
    assert.equal(cfg.onchain, false) // CARDS_SYNC_ONCHAIN=false in this suite
    assert.equal(cfg.brand, 'Visa Test')
    assert.ok(cfg.maxCardsPerOwner > 0)
    assert.ok(listMerchants().length >= 5)
  })

  test('balance auto-funding + explicit top-up (simulated mode)', async () => {
    const bal = await getOwnerBalance(OWNER)
    assert.equal(bal.balance, '100')
    assert.equal(bal.source, 'simulated')
    const funded = fundTestBalance(OWNER, '25')
    assert.equal(funded.balance, '125')
  })

  test('create card returns masked pan by default', () => {
    const card = createCard(OWNER, { label: 'Ops', perTxLimit: '25', dailyLimit: '50' })
    assert.match(card.cardId, /^acard_/)
    assert.equal(card.brand, 'Visa Test')
    assert.equal(card.status, 'active')
    assert.match(card.pan, /^4485\d{12}$/)
    const listed = listCards(OWNER)[0]
    assert.match(listed.pan, /••/)
    assert.notEqual(listed.pan, card.pan)
    assert.equal(listed.last4, card.pan.slice(-4))
    assert.equal(card.limits.perTx, '25')
    assert.equal(card.limits.daily, '50')
    assert.ok(listCards(OWNER)?.length >= 1)
  })

  test('spend settles and debits balance (simulated)', async () => {
    const spendOwner = `${OWNER}spend`
    const card = createCard(spendOwner, { perTxLimit: '25', dailyLimit: '50' })
    const result = await spendWithCard(spendOwner, card.cardId, { merchantId: MERCHANT, amount: '12.5', description: 'Gadget' })
    assert.equal(result.approved, true)
    assert.equal(result.status, 'settled')
    assert.equal(result.onchain, false)
    assert.equal(result.amount, '12.5')
    const bal = await getOwnerBalance(spendOwner)
    assert.equal(bal.balance, '87.5')
  })

  test('per-transaction limit declined', async () => {
    const card = createCard(OWNER, { perTxLimit: '10', dailyLimit: '50' })
    const result = await spendWithCard(OWNER, card.cardId, { merchantId: MERCHANT, amount: '25' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'per_tx_limit_exceeded')
  })

  test('daily limit declines cumulative spend', async () => {
    const dailyOwner = `${OWNER}daily`
    const card = createCard(dailyOwner, { perTxLimit: '30', dailyLimit: '25' })
    const first = await spendWithCard(dailyOwner, card.cardId, { merchantId: MERCHANT, amount: '20' })
    assert.equal(first.approved, true)
    const second = await spendWithCard(dailyOwner, card.cardId, { merchantId: MERCHANT, amount: '10' })
    assert.equal(second.approved, false)
    assert.equal(second.declineReason, 'daily_limit_exceeded')
  })

  test('insufficient funds declined (simulated)', async () => {
    const smallOwner = `${OWNER}f`
    const card = createCard(smallOwner, { perTxLimit: '100000', dailyLimit: '100000' })
    const result = await spendWithCard(smallOwner, card.cardId, { merchantId: MERCHANT, amount: '99999' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'insufficient_funds')
  })

  test('unknown merchant declined', async () => {
    const card = createCard(`${OWNER}unknown`)
    const result = await spendWithCard(`${OWNER}unknown`, card.cardId, { merchantId: 'm_unknown', amount: '5' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'bad_merchant')
  })

  test('frozen card declined', async () => {
    const frozenOwner = `${OWNER}frozen`
    const card = createCard(frozenOwner)
    setCardStatus(frozenOwner, card.cardId, 'frozen')
    const result = await spendWithCard(frozenOwner, card.cardId, { merchantId: MERCHANT, amount: '5' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'card_frozen')
    setCardStatus(frozenOwner, card.cardId, 'active')
  })

  test('category blocked declined', async () => {
    const catOwner = `${OWNER}cat`
    const card = createCard(catOwner, { blockedCategories: ['nft'] })
    const result = await spendWithCard(catOwner, card.cardId, { merchantId: 'm_mintify', amount: '5' })
    assert.equal(result.approved, false)
    assert.equal(result.declineReason, 'category_blocked')
  })

  test('authorize then settle two-phase (simulated)', async () => {
    const twoPhaseOwner = `${OWNER}two`
    const card = createCard(twoPhaseOwner, { perTxLimit: '50', dailyLimit: '50' })
    const auth = await authorizeCardSpend(twoPhaseOwner, card.cardId, { merchantId: MERCHANT, amount: '7' })
    assert.equal(auth.approved, true)
    assert.equal(auth.status, 'authorized')
    const settled = await settleCardTransaction(twoPhaseOwner, auth.txId)
    assert.equal(settled.settled, true)
    assert.equal(settled.tx.status, 'settled')
  })

  test('refund returns test USDC (simulated)', async () => {
    const refundOwner = `${OWNER}refund`
    const card = createCard(refundOwner, { perTxLimit: '50', dailyLimit: '50' })
    const before = await getOwnerBalance(refundOwner)
    const spend = await spendWithCard(refundOwner, card.cardId, { merchantId: MERCHANT, amount: '5' })
    const after = await getOwnerBalance(refundOwner)
    const refund = refundCardTransaction(refundOwner, spend.txId)
    assert.equal(refund.refunded, true)
    assert.equal((await getOwnerBalance(refundOwner)).balance, before.balance)
  })

  test('on-chain sync reads fake balance and spend executes transfer with txHash', async () => {
    process.env.CARDS_SYNC_ONCHAIN = 'true'
    process.env.CARDS_FAKE_BALANCE = '50'
    process.env.CARDS_FAKE_TRANSFER = 'true'
    try {
      const owner = `${OWNER}onchain`
      const wallet = '0x1111111111111111111111111111111111111111'
      const synced = await syncCardBalance(owner, wallet, { force: true })
      assert.equal(synced.source, 'onchain')
      assert.equal(synced.balance, '50')
      assert.equal(synced.mscaAddress, wallet)

      const card = createCard(owner, { perTxLimit: '50', dailyLimit: '50' })
      const spend = await spendWithCard(owner, card.cardId, {
        merchantId: MERCHANT, amount: '10', walletAddress: wallet,
      })
      assert.equal(spend.approved, true)
      assert.equal(spend.status, 'settled')
      assert.equal(spend.onchain, true)
      assert.match(spend.txHash, /^0x/)
      assert.ok(spend.explorerUrl)

      // declined when fake balance too low
      process.env.CARDS_FAKE_BALANCE = '5'
      const declined = await spendWithCard(owner, card.cardId, {
        merchantId: MERCHANT, amount: '10', walletAddress: wallet,
      })
      assert.equal(declined.approved, false)
      assert.equal(declined.declineReason, 'insufficient_funds')

      // on-chain refund must be manual
      const refund = refundCardTransaction(owner, spend.txId)
      assert.equal(refund.refunded, false)
      assert.equal(refund.reason, 'onchain_refund_manual')
    } finally {
      process.env.CARDS_SYNC_ONCHAIN = 'false'
      delete process.env.CARDS_FAKE_BALANCE
      delete process.env.CARDS_FAKE_TRANSFER
    }
  })

  test('fund is disabled in on-chain mode', async () => {
    process.env.CARDS_SYNC_ONCHAIN = 'true'
    try {
      assert.throws(() => fundTestBalance(`${OWNER}nofund`, '25'), /on-chain/)
    } finally {
      process.env.CARDS_SYNC_ONCHAIN = 'false'
    }
  })

  test('transactions list and filter', async () => {
    const txOwner = `${OWNER}tx`
    const card = createCard(txOwner, { perTxLimit: '50', dailyLimit: '50' })
    await spendWithCard(txOwner, card.cardId, { merchantId: MERCHANT, amount: '3' })
    await spendWithCard(txOwner, card.cardId, { merchantId: 'm_coffee', amount: '2' })
    const all = listCardTransactions(txOwner)
    assert.ok(all.length >= 2)
    const byCard = listCardTransactions(txOwner, card.cardId)
    assert.ok(byCard.length >= 2)
    assert.ok(byCard.every(t => t.status === 'settled'))
  })

  test('full pan is Luhn-valid', () => {
    const card = createCard(`${OWNER}luhn`)
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