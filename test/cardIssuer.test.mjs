import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'issuer-test-'))
process.env.AGENT_CARDS_DB = join(tempDir, 'cards-db.json')
writeFileSync(process.env.AGENT_CARDS_DB, '{"cards":[],"transactions":[],"ledger":{}}')
process.env.CARDS_SYNC_ONCHAIN = 'false'

const { getIssuer, cardIssuerConfig } = await import('../src/services/cardIssuer.mjs')
const sim = await import('../src/services/cardSimulator.mjs')

describe('card issuer adapter', () => {
  after(() => rmSync(tempDir, { recursive: true, force: true }))

  test('defaults to simulator without keys', () => {
    delete process.env.CARD_PROVIDER
    delete process.env.LITHIC_API_KEY
    delete process.env.STRIPE_SECRET_KEY
    const cfg = cardIssuerConfig()
    assert.equal(cfg.provider, 'simulator')
    assert.equal(cfg.configured, false)
    assert.equal(getIssuer().provider, 'simulator')
  })

  test('lithic driver issues a card against sandbox API', async () => {
    process.env.CARD_PROVIDER = 'lithic'
    process.env.LITHIC_API_KEY = 'lithic_test_xyz'
    const calls = []
    globalThis.fetch = async (url, init = {}) => {
      calls.push([url, init])
      const path = String(url).replace('https://sandbox.lithic.com/v1', '')
      if (path === '/accounts' && init.method === 'POST') {
        return { ok: true, json: async () => ({ token: 'acc_1', type: 'operating' }), text: async () => '' }
      }
      if (path.startsWith('/cards') && init.method === 'POST') {
        return { ok: true, json: async () => ({ token: 'card_9', pan: '4111111111111111', last_four: '1111', exp_month: '08', exp_year: '2030', cvc: '123' }), text: async () => '' }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' }
    }
    try {
      const issuer = getIssuer()
      assert.equal(issuer.provider, 'lithic')
      const card = await issuer.issueCard({ label: 'Agent' })
      assert.equal(card.providerCardId, 'card_9')
      assert.equal(card.last4, '1111')
      const accountCall = calls.find(c => c[0].includes('/accounts'))
      assert.match(String(accountCall[1].headers.Authorization), /^Basic /)
      assert.ok(calls.some(c => c[0].includes('/cards')))
    } finally {
      delete globalThis.fetch
      delete process.env.CARD_PROVIDER
      delete process.env.LITHIC_API_KEY
    }
  })

  test('stripe driver builds issuing create request with test key', async () => {
    process.env.CARD_PROVIDER = 'stripe'
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
    const calls = []
    globalThis.fetch = async (url, init = {}) => {
      calls.push([url, init])
      if (String(url).includes('/v1/issuing/cardholders')) {
        return { ok: true, json: async () => ({ id: 'ich_9' }), text: async () => '' }
      }
      if (String(url).includes('/v1/issuing/cards')) {
        return { ok: true, json: async () => ({ id: 'ic_77', last4: '4242', exp_month: 8, exp_year: 2030, cvc: '777', number: '4242424242424242' }), text: async () => '' }
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' }
    }
    try {
      const issuer = getIssuer()
      assert.equal(issuer.provider, 'stripe')
      const card = await issuer.issueCard({})
      assert.equal(card.providerCardId, 'ic_77')  // stub returns id; see stub below
      assert.match(calls[0][1].headers.Authorization, /^Basic /)
      assert.ok(String(calls[0][0]).includes('api.stripe.com/v1/issuing/cardholders'))
      assert.ok(String(calls[1][0]).includes('api.stripe.com/v1/issuing/cards'))
    } finally {
      delete globalThis.fetch
      delete process.env.CARD_PROVIDER
      delete process.env.STRIPE_SECRET_KEY
    }
  })

  test('stripe webhook mapping: authorization + settlement + refund', async () => {
    process.env.CARD_PROVIDER = 'stripe'
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
    const issuer = getIssuer()
    const authEvent = issuer.parseWebhookEvent({
      type: 'issuing_authorization.created',
      data: { object: { card: 'ic_1', amount: 1250, merchant_data: { name: 'Coffee Co' }, authorized_amount: 1250 } },
    })
    assert.equal(authEvent.cardId, 'ic_1')
    assert.equal(authEvent.amount, '12.50')
    assert.equal(authEvent.status, 'authorized')
    assert.equal(authEvent.merchantId, 'Coffee Co')

    const settled = issuer.parseWebhookEvent({
      type: 'issuing_transaction.settled',
      data: { object: { card: 'ic_1', amount: 1250 } },
    })
    assert.equal(settled.status, 'settled')
    const refunded = issuer.parseWebhookEvent({
      type: 'issuing_transaction.refund_created',
      data: { object: { card: 'ic_1', amount: 500 } },
    })
    assert.equal(refunded.status, 'refunded')
    delete process.env.CARD_PROVIDER
    delete process.env.STRIPE_SECRET_KEY
  })

  test('webhook-injected issuer tx appears in simulator timeline', async () => {
    process.env.CARD_PROVIDER = 'lithic'
    process.env.LITHIC_API_KEY = 'k'
    const owner = '0xwebhook'
    const card = sim.createCard(owner, {})
    sim.setProviderCard(owner, card.cardId, 'lithic', 'card_webhook_1', '4111111111111111')
    const rec = sim.recordExternalTransaction({
      id: 'evt_1',
      cardId: card.cardId,
      merchantName: 'Stripe Test Merchant',
      category: 'software',
      amount: '9.99',
      status: 'authorized',
    })
    assert.equal(rec.recorded, true)
    const txs = sim.listCardTransactions(owner, card.cardId)
    assert.ok(txs.some(t => t.merchantName === 'Stripe Test Merchant'))
    // provider matching
    const found = sim.findCardByProvider('card_webhook_1')
    assert.equal(found?.cardId, card.cardId)
    delete process.env.CARD_PROVIDER
    delete process.env.LITHIC_API_KEY
  })
})