// ARCOX Stripe Connect (Accounts v2) integration.
//
// Turns ARCOX into a Stripe Connect platform: any agent/wallet owner can
// onboard a connected account (merchant + customer configurations), create
// products, and sell them through a hosted Checkout storefront. The platform
// monetizes via a Direct Charge with an application fee.
//
// Design notes (per Stripe's Accounts v2 guidance):
//   - A single `stripeClient` is used for every request (never raw fetch).
//   - Connected accounts are created with the **V2 API** — no top-level
//     `type: 'express'|'standard'|'custom'`. Capabilities live under
//     `configuration.merchant.capabilities`.
//   - Onboarding status is always fetched live from the API, never cached.
//   - V2 accounts are used *as customers* via `customer_account` (no separate
//     Customer object) for subscriptions and the billing portal.
//   - Requirement-change notifications arrive as **thin events**; parse with
//     `parseEventNotification` (renamed from `parseThinEvent` in SDK >= 22)
//     then fetch the full event via `v2.core.events.retrieve`.
//
// A mapping owner -> connected account is persisted to a JSON file so a user
// can re-find their account. The account status itself is always read from
// the API (per the markdown: "always get the account status from the API").

import Stripe from 'stripe'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'

const CONNECT_DB_PATH = process.env.STRIPE_CONNECT_DB || './data/connect-accounts.json'

// ── Config ──────────────────────────────────────────────────────────────────
// A value that needs to be filled in (like an API key) is read from env. If
// the secret key is missing we throw a helpful error instead of silently
// failing later.
export function connectConfig() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim()
  const publicKey = String(process.env.STRIPE_PUBLIC_KEY || '').trim()
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add your Stripe secret key (sk_test_...) to .env to use Stripe Connect.'
    )
  }
  return {
    configured: true,
    testMode: secretKey.startsWith('sk_test_'),
    publicKey,
    // Application fee charged on each Direct Charge, in basis points (100 = 1%).
    appFeeBasisPoints: Number(process.env.STRIPE_CONNECT_APP_FEE_BASIS_POINTS || 200),
    // Price ID used for the platform-level subscription checkout (set this in
    // your Stripe dashboard when you have a subscription product).
    subscriptionPriceId: String(process.env.STRIPE_CONNECT_PRICE_ID || '').trim(),
    webhookSecret: String(process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim(),
    webhookPath: '/api/connect/webhook',
    currency: String(process.env.STRIPE_CONNECT_CURRENCY || 'usd').trim().toLowerCase(),
  }
}

// ── Stripe client (single instance for all requests) ───────────────────────
let _client = null
export function getStripeClient() {
  if (_client) return _client
  const { testMode } = connectConfig()
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim()
  _client = new Stripe(secretKey, {
    apiVersion: undefined, // SDK pins the latest supported API version automatically
    maxNetworkRetries: 2,
  })
  // Keep a marker so tests can tell which mode the client is in.
  _client._arcoxTestMode = testMode
  return _client
}

// Allow tests to reset the singleton between cases.
export function _resetStripeClient() {
  _client = null
}

// Test hook: inject a fully fake client (see test/stripeConnect.test.mjs).
export function _setStripeClientForTest(fake) {
  _client = fake
}

// ── Account mapping store (owner -> connected account id) ──────────────────
function loadAccounts() {
  return readJsonFile(CONNECT_DB_PATH, { accounts: {} })
}

function saveAccounts(db) {
  atomicWriteJsonFile(CONNECT_DB_PATH, db)
}

export function getAccountForOwner(owner) {
  const db = loadAccounts()
  return db.accounts[String(owner || '').toLowerCase()] || null
}

export function listOwnedAccounts(owner) {
  const db = loadAccounts()
  const key = String(owner || '').toLowerCase()
  return Object.entries(db.accounts)
    .filter(([, v]) => v.owner === key)
    .map(([, v]) => v)
}

function saveAccountMapping(owner, accountId, { displayName, contactEmail }) {
  const db = loadAccounts()
  const key = String(owner || '').toLowerCase()
  db.accounts[key] = {
    owner: key,
    accountId,
    displayName,
    contactEmail,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveAccounts(db)
  return db.accounts[key]
}

// ── Create connected accounts (V2) ─────────────────────────────────────────
// Only the properties below are sent. Never a top-level `type`.
export async function createConnectedAccount(owner, { displayName, contactEmail } = {}) {
  const client = getStripeClient()
  const account = await client.v2.core.accounts.create({
    display_name: displayName || 'ARCOX Agent',
    contact_email: contactEmail || 'agent@arcox.test',
    identity: {
      country: 'us',
    },
    dashboard: 'full',
    defaults: {
      responsibilities: {
        fees_collector: 'stripe',
        losses_collector: 'stripe',
      },
    },
    configuration: {
      merchant: {
        capabilities: {
          card_payments: {
            requested: true,
          },
        },
      },
    },
  })
  const mapping = saveAccountMapping(owner, account.id, { displayName, contactEmail })
  return { accountId: account.id, ...mapping }
}

// ── Onboarding via Account Links (V2) ──────────────────────────────────────
export async function createAccountLink(accountId, { refreshUrl, returnUrl } = {}) {
  const client = getStripeClient()
  const base = returnUrl || process.env.APP_BASE_URL || 'http://127.0.0.1:3001'
  const link = await client.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        configurations: ['merchant', 'customer'],
        refresh_url: refreshUrl || `${base}/api/connect/refresh?accountId=${accountId}`,
        return_url: `${base}/api/connect/return?accountId=${accountId}`,
      },
    },
  })
  return { url: link.url }
}

// ── Account status (always from the API, never stored) ─────────────────────
export async function getAccountStatus(accountId) {
  const client = getStripeClient()
  const account = await client.v2.core.accounts.retrieve(accountId, {
    include: ['configuration.merchant', 'requirements'],
  })
  const cardPayments =
    account?.configuration?.merchant?.capabilities?.card_payments?.status || 'inactive'
  const requirementsStatus = account?.requirements?.summary?.minimum_deadline?.status
  const onboardingComplete =
    requirementsStatus !== 'currently_due' && requirementsStatus !== 'past_due'
  return {
    accountId: account.id,
    displayName: account.display_name || '',
    dashboard: account.dashboard || '',
    cardPayments,
    readyToProcessPayments: cardPayments === 'active',
    requirementsStatus: requirementsStatus || 'none',
    onboardingComplete,
    detailsSubmitted: Boolean(account?.requirements?.currently_due?.length === 0),
  }
}

// ── Products (v1 API routed to the connected account) ──────────────────────
export async function createProduct(accountId, { name, description, priceCents, currency } = {}) {
  const client = getStripeClient()
  const cfg = connectConfig()
  const product = await client.products.create(
    {
      name: name || 'Untitled product',
      description: description || '',
      default_price_data: {
        unit_amount: Math.round(Number(priceCents) || 0),
        currency: currency || cfg.currency,
      },
    },
    { stripeAccount: accountId } // Stripe-Account header
  )
  return product
}

export async function listProducts(accountId) {
  const client = getStripeClient()
  const products = await client.products.list(
    {
      limit: 20,
      active: true,
      expand: ['data.default_price'],
    },
    { stripeAccount: accountId } // Stripe-Account header
  )
  return products.data
}

// ── Direct Charge via hosted Checkout (with application fee) ───────────────
export async function createCheckoutPayment(accountId, { productId, quantity, successUrl } = {}) {
  const client = getStripeClient()
  const cfg = connectConfig()
  // Fetch the product's default price so we can compute the application fee.
  const product = await client.products.retrieve(productId, { expand: ['default_price'] }, { stripeAccount: accountId })
  const price = product?.default_price
  const unitAmount = price?.unit_amount || 0
  const qty = Math.max(1, Number(quantity) || 1)
  const totalCents = unitAmount * qty
  const appFeeCents = Math.round((totalCents * cfg.appFeeBasisPoints) / 10000)
  const session = await client.checkout.sessions.create(
    {
      line_items: [
        {
          price: price?.id,
          quantity: qty,
        },
      ],
      payment_intent_data: {
        application_fee_amount: appFeeCents,
      },
      mode: 'payment',
      success_url: successUrl || `${process.env.APP_BASE_URL || 'http://127.0.0.1:3001'}/connect/success?session_id={CHECKOUT_SESSION_ID}`,
    },
    { stripeAccount: accountId } // Direct charge to the connected account
  )
  return { url: session.url, sessionId: session.id, appFeeCents, totalCents }
}

// ── Subscription (V2 account as customer, platform-level) ──────────────────
export async function createSubscriptionCheckout(accountId, { successUrl, cancelUrl } = {}) {
  const client = getStripeClient()
  const cfg = connectConfig()
  if (!cfg.subscriptionPriceId) {
    throw new Error(
      'STRIPE_CONNECT_PRICE_ID is not set. Create a subscription product in your Stripe dashboard and set its Price ID in .env.'
    )
  }
  const session = await client.checkout.sessions.create({
    customer_account: accountId, // V2 account used as the customer
    mode: 'subscription',
    line_items: [
      {
        price: cfg.subscriptionPriceId,
        quantity: 1,
      },
    ],
    success_url: successUrl || `${process.env.APP_BASE_URL || 'http://127.0.0.1:3001'}/connect/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl || `${process.env.APP_BASE_URL || 'http://127.0.0.1:3001'}/connect`,
  })
  return { url: session.url, sessionId: session.id }
}

// ── Billing portal (V2 account as customer) ────────────────────────────────
export async function createBillingPortalSession(accountId, { returnUrl } = {}) {
  const client = getStripeClient()
  const session = await client.billingPortal.sessions.create({
    customer_account: accountId,
    return_url: returnUrl || `${process.env.APP_BASE_URL || 'http://127.0.0.1:3001'}/connect`,
  })
  return { url: session.url }
}

// ── Webhooks ───────────────────────────────────────────────────────────────
// Two classes of events:
//   1. Thin events for V2 account requirement changes (parse the notification,
//      then retrieve the full event to see what changed).
//   2. Classic subscription/payment events (customer.subscription.* etc).
//
// Returns a summary object describing what was handled; the route layer logs
// it to the audit trail.
export async function handleConnectWebhook(payload, signature) {
  const client = getStripeClient()
  const cfg = connectConfig()
  if (!cfg.webhookSecret) {
    throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not set; cannot verify webhook signature.')
  }
  // Thin events are signed with the same secret; parseEventNotification is the
  // SDK>=22 name for what used to be parseThinEvent.
  const notification = client.parseEventNotification(payload, signature, cfg.webhookSecret)
  const eventId = notification.id
  // Fetch the full event to understand the change.
  const event = await client.v2.core.events.retrieve(eventId)
  const type = event.type
  const related = event.related_object || {}
  return {
    eventId: event.id,
    type,
    accountId: related.id || notification.context?.account || '',
    status: type.includes('requirements')
      ? 'requirements_updated'
      : type.includes('capability_status')
        ? 'capability_updated'
        : 'unknown',
  }
}

// Classic (non-thin) webhook handler for subscription lifecycle events.
// The markdown specifies these are NOT thin events.
export async function handleClassicWebhook(payload, signature) {
  const client = getStripeClient()
  const cfg = connectConfig()
  if (!cfg.webhookSecret) {
    throw new Error('STRIPE_CONNECT_WEBHOOK_SECRET is not set; cannot verify webhook signature.')
  }
  const event = await client.webhooks.constructEventAsync(payload, signature, cfg.webhookSecret)
  const type = event.type
  if (type === 'checkout.session.completed') {
    const session = event.data.object
    // For V2 accounts the customer is `customer_account` (not `customer`).
    return {
      eventId: event.id,
      type,
      customerAccount: session.customer_account || '',
      sessionId: session.id,
      paymentStatus: session.payment_status,
      mode: session.mode,
      status: session.mode === 'subscription' ? 'subscribed' : 'paid',
    }
  }
  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const sub = event.data.object
    // V2 subscription events expose the account via customer_account.
    const accountId = sub.customer_account || sub.customer || ''
    const priceId = sub.items?.data?.[0]?.price?.id || ''
    const quantity = sub.items?.data?.[0]?.quantity || 1
    let status
    if (type === 'customer.subscription.deleted') status = 'canceled'
    else if (sub.pause_collection) status = 'paused'
    else if (sub.cancel_at_period_end) status = 'will_cancel_at_period_end'
    else status = 'active'
    return {
      eventId: event.id,
      type,
      customerAccount: accountId,
      subscriptionId: sub.id,
      priceId,
      quantity,
      status,
    }
  }
  // payment_method.attached / customer.updated / tax_id.* are informational;
  // we acknowledge them so Stripe stops retrying.
  return { eventId: event.id, type, customerAccount: event.data?.object?.customer_account || '', status: 'acknowledged' }
}
