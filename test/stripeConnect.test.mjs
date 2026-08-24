import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = mkdtempSync(join(tmpdir(), 'connect-test-'))
process.env.STRIPE_CONNECT_DB = join(tempDir, 'connect-accounts.json')
process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
process.env.APP_BASE_URL = 'http://127.0.0.1:3001'

const {
  connectConfig,
  createConnectedAccount,
  createAccountLink,
  getAccountStatus,
  getAccountForOwner,
  createProduct,
  listProducts,
  createCheckoutPayment,
  createSubscriptionCheckout,
  createBillingPortalSession,
  handleConnectWebhook,
  handleClassicWebhook,
  _setStripeClientForTest,
  _resetStripeClient,
} = await import('../src/services/stripeConnect.mjs')

// A fake Stripe client shaped like the real SDK surface we use.
function fakeClient() {
  const calls = []
  const client = {
    calls,
    v2: {
      core: {
        accounts: {
          async create(params) {
            calls.push(['v2.accounts.create', params])
            return { id: 'acct_123', ...params }
          },
          async retrieve(id, opts) {
            calls.push(['v2.accounts.retrieve', id, opts])
            return {
              id,
              display_name: 'ARCOX Agent',
              dashboard: 'full',
              configuration: {
                merchant: { capabilities: { card_payments: { status: 'active' } } },
              },
              requirements: { summary: { minimum_deadline: { status: 'satisfied' } }, currently_due: [] },
            }
          },
        },
        accountLinks: {
          async create(params) {
            calls.push(['v2.accountLinks.create', params])
            return { url: 'https://connect.stripe.com/setup/s/abc' }
          },
        },
        events: {
          async retrieve(id) {
            calls.push(['v2.events.retrieve', id])
            return {
              id,
              type: 'v2.account[requirements].updated',
              related_object: { id: 'acct_123' },
            }
          },
        },
      },
    },
    products: {
      async create(params, opts) {
        calls.push(['products.create', params, opts])
        return { id: 'prod_1', name: params.name, ...params }
      },
      async list(params, opts) {
        calls.push(['products.list', params, opts])
        return { data: [{ id: 'prod_1', name: 'Widget', default_price: { id: 'price_1', unit_amount: 1000 } }] }
      },
      async retrieve(id, opts, reqOpts) {
        calls.push(['products.retrieve', id, opts, reqOpts])
        return { id, default_price: { id: 'price_1', unit_amount: 1000 } }
      },
    },
    checkout: {
      sessions: {
        async create(params, opts) {
          calls.push(['checkout.sessions.create', params, opts])
          return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', mode: params.mode }
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          calls.push(['billingPortal.sessions.create', params])
          return { url: 'https://billing.stripe.com/p/session/xyz' }
        },
      },
    },
    parseEventNotification(payload, sig, secret) {
      calls.push(['parseEventNotification', sig, secret])
      return { id: 'evt_thin_1', context: { account: 'acct_123' } }
    },
    webhooks: {
      async constructEventAsync(payload, sig, secret) {
        calls.push(['constructEventAsync', sig, secret])
        const body = JSON.parse(payload.toString('utf8'))
        return { id: body.id, type: body.type, data: { object: body.data?.object } }
      },
    },
  }
  return client
}

describe('stripe connect service', () => {
  after(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.STRIPE_CONNECT_DB
    delete process.env.STRIPE_SECRET_KEY
  })

  test('config requires a secret key with a helpful error', () => {
    delete process.env.STRIPE_SECRET_KEY
    assert.throws(() => connectConfig(), /STRIPE_SECRET_KEY is not set/)
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc'
  })

  test('creates a connected account via V2 (no top-level type) and stores mapping', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    const result = await createConnectedAccount('0xOwner1', { displayName: 'Alice', contactEmail: 'a@x.com' })
    assert.equal(result.accountId, 'acct_123')
    const createParams = client.calls.find(([n]) => n === 'v2.accounts.create')[1]
    // Must NOT pass top-level type per the markdown.
    assert.equal(createParams.type, undefined)
    assert.equal(createParams.configuration.merchant.capabilities.card_payments.requested, true)
    assert.equal(createParams.defaults.responsibilities.fees_collector, 'stripe')
    // Mapping persisted.
    const mapping = getAccountForOwner('0xowner1')
    assert.equal(mapping.accountId, 'acct_123')
  })

  test('creates an onboarding account link with refresh/return URLs', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    const link = await createAccountLink('acct_123')
    assert.match(link.url, /connect\.stripe\.com/)
    const params = client.calls.find(([n]) => n === 'v2.accountLinks.create')[1]
    assert.equal(params.use_case.type, 'account_onboarding')
    assert.deepEqual(params.use_case.account_onboarding.configurations, ['merchant', 'customer'])
  })

  test('reads account status live from the API', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    const status = await getAccountStatus('acct_123')
    assert.equal(status.readyToProcessPayments, true)
    assert.equal(status.onboardingComplete, true)
    assert.equal(status.cardPayments, 'active')
  })

  test('creates a product on the connected account (Stripe-Account header)', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    const product = await createProduct('acct_123', { name: 'Widget', priceCents: 1000 })
    assert.equal(product.id, 'prod_1')
    const [name, , opts] = client.calls.find(([n]) => n === 'products.create')
    assert.equal(opts.stripeAccount, 'acct_123')
  })

  test('lists products with the connected account header', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    const products = await listProducts('acct_123')
    assert.equal(products.length, 1)
    const [, params, opts] = client.calls.find(([n]) => n === 'products.list')
    assert.equal(params.expand[0], 'data.default_price')
    assert.equal(opts.stripeAccount, 'acct_123')
  })

  test('creates a Direct Charge checkout with application fee', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    process.env.STRIPE_CONNECT_APP_FEE_BASIS_POINTS = '200' // 2%
    const session = await createCheckoutPayment('acct_123', { productId: 'prod_1', quantity: 2 })
    assert.equal(session.url, 'https://checkout.stripe.com/c/pay/cs_1')
    assert.equal(session.appFeeCents, 40) // 2% of 2000
    const [, params, opts] = client.calls.find(([n]) => n === 'checkout.sessions.create')
    assert.equal(params.mode, 'payment')
    assert.equal(params.payment_intent_data.application_fee_amount, 40)
    assert.equal(opts.stripeAccount, 'acct_123')
  })

  test('creates a subscription checkout using the V2 account as customer', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    process.env.STRIPE_CONNECT_PRICE_ID = 'price_sub_1'
    const session = await createSubscriptionCheckout('acct_123')
    assert.match(session.url, /checkout\.stripe\.com/)
    const [, params] = client.calls.find(([n]) => n === 'checkout.sessions.create')
    assert.equal(params.customer_account, 'acct_123')
    assert.equal(params.mode, 'subscription')
  })

  test('subscription checkout requires a configured price id', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    delete process.env.STRIPE_CONNECT_PRICE_ID
    await assert.rejects(() => createSubscriptionCheckout('acct_123'), /STRIPE_CONNECT_PRICE_ID is not set/)
  })

  test('creates a billing portal session with customer_account', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    const session = await createBillingPortalSession('acct_123')
    assert.match(session.url, /billing\.stripe\.com/)
    const [, params] = client.calls.find(([n]) => n === 'billingPortal.sessions.create')
    assert.equal(params.customer_account, 'acct_123')
  })

  test('parses thin events (requirements updated) via parseEventNotification', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_test'
    const result = await handleConnectWebhook(Buffer.from('{}'), 'sig', )
    assert.equal(result.type, 'v2.account[requirements].updated')
    assert.equal(result.status, 'requirements_updated')
    assert.equal(result.accountId, 'acct_123')
    assert.ok(client.calls.some(([n]) => n === 'parseEventNotification'))
    assert.ok(client.calls.some(([n]) => n === 'v2.events.retrieve'))
  })

  test('handles classic subscription events (V2 customer_account)', async () => {
    const client = fakeClient()
    _setStripeClientForTest(client)
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_test'
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', customer_account: 'acct_123', items: { data: [{ price: { id: 'price_sub_1' }, quantity: 2 }] } } },
    })
    const result = await handleClassicWebhook(Buffer.from(payload), 'sig')
    assert.equal(result.customerAccount, 'acct_123')
    assert.equal(result.status, 'active')
  })

  _resetStripeClient()
})
