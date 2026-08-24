// ARCOX Stripe Connect routes — marketplace/platform for agent wallets.
// All stateful endpoints are owner-gated (same pattern as x402/card routes).
// The account status is always fetched live from Stripe; only the
// owner -> accountId mapping is persisted locally.

import express, { Router } from 'express'
import { verifyOwnerToken } from '../services/authToken.mjs'
import {
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
} from '../services/stripeConnect.mjs'
import { logActivity } from '../services/vaultStore.mjs'

const router = Router()

async function authenticatedOwner(req) {
  const auth = String(req.headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  let owner = verifyOwnerToken(token)
  if (!owner && token.startsWith('arx_vs_')) {
    const { validateSession } = await import('../services/vaultStore.mjs')
    owner = validateSession(token)
  }
  if (!owner) return null
  const { getSessionKeyInfo } = await import('../services/vaultStore.mjs')
  const session = await getSessionKeyInfo(owner)
  return session?.active ? { owner, walletAddress: String(session.walletAddress).toLowerCase() } : null
}

function handleError(res, e, fallback = 'connect error') {
  const status = e?.status || e?.statusCode || 500
  const message = e?.message || fallback
  return res.status(status >= 400 && status < 600 ? status : 500).json({ error: message })
}

// GET /api/connect/config — public-ish config for the frontend
router.get('/config', (_req, res) => {
  try {
    const cfg = connectConfig()
    res.json({ ok: true, ...cfg })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// GET /api/connect/account — current owner's connected account + live status
router.get('/account', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const mapping = getAccountForOwner(auth.owner)
  if (!mapping) return res.json({ ok: true, account: null })
  try {
    const status = await getAccountStatus(mapping.accountId)
    res.json({ ok: true, account: { ...mapping, ...status } })
  } catch (e) {
    handleError(res, e)
  }
})

// POST /api/connect/onboard — create connected account (if needed) + account link
router.post('/onboard', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const { displayName, contactEmail } = req.body || {}
  try {
    let mapping = getAccountForOwner(auth.owner)
    if (!mapping) {
      mapping = await createConnectedAccount(auth.owner, { displayName, contactEmail })
      logActivity(auth.owner, 'connect_account_created', { accountId: mapping.accountId })
    }
    const link = await createAccountLink(mapping.accountId)
    logActivity(auth.owner, 'connect_onboarding_link', { accountId: mapping.accountId })
    res.json({ ok: true, accountId: mapping.accountId, url: link.url })
  } catch (e) {
    handleError(res, e)
  }
})

// GET /api/connect/status — live onboarding status for the owner's account
router.get('/status', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const mapping = getAccountForOwner(auth.owner)
  if (!mapping) return res.json({ ok: true, account: null })
  try {
    const status = await getAccountStatus(mapping.accountId)
    res.json({ ok: true, ...status })
  } catch (e) {
    handleError(res, e)
  }
})

// POST /api/connect/products — create a product on the owner's connected account
router.post('/products', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const mapping = getAccountForOwner(auth.owner)
  if (!mapping) return res.status(400).json({ error: 'No connected account yet; onboard first' })
  const { name, description, priceCents, currency } = req.body || {}
  if (!name || !priceCents) return res.status(400).json({ error: 'name and priceCents required' })
  try {
    const product = await createProduct(mapping.accountId, { name, description, priceCents, currency })
    logActivity(auth.owner, 'connect_product_created', { productId: product.id, name })
    res.json({ ok: true, product })
  } catch (e) {
    handleError(res, e)
  }
})

// GET /api/connect/products — list products on the owner's connected account
router.get('/products', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const mapping = getAccountForOwner(auth.owner)
  if (!mapping) return res.json({ ok: true, products: [] })
  try {
    const products = await listProducts(mapping.accountId)
    res.json({ ok: true, products })
  } catch (e) {
    handleError(res, e)
  }
})

// GET /api/connect/store/:accountId/products — public storefront for one account
// NOTE: uses the connected account's ID in the URL for demo simplicity; in
// production you'd want a friendly slug/identifier instead.
router.get('/store/:accountId/products', async (req, res) => {
  try {
    const products = await listProducts(req.params.accountId)
    res.json({ ok: true, accountId: req.params.accountId, products })
  } catch (e) {
    handleError(res, e)
  }
})

// POST /api/connect/store/:accountId/checkout — buy a product (direct charge + app fee)
router.post('/store/:accountId/checkout', async (req, res) => {
  const { productId, quantity } = req.body || {}
  if (!productId) return res.status(400).json({ error: 'productId required' })
  try {
    const session = await createCheckoutPayment(req.params.accountId, { productId, quantity })
    res.json({ ok: true, ...session })
  } catch (e) {
    handleError(res, e)
  }
})

// POST /api/connect/subscribe — subscription checkout for the owner's account
router.post('/subscribe', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const mapping = getAccountForOwner(auth.owner)
  if (!mapping) return res.status(400).json({ error: 'No connected account yet; onboard first' })
  try {
    const session = await createSubscriptionCheckout(mapping.accountId)
    logActivity(auth.owner, 'connect_subscription_checkout', { accountId: mapping.accountId })
    res.json({ ok: true, ...session })
  } catch (e) {
    handleError(res, e)
  }
})

// POST /api/connect/portal — billing portal for the owner's account
router.post('/portal', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const mapping = getAccountForOwner(auth.owner)
  if (!mapping) return res.status(400).json({ error: 'No connected account yet; onboard first' })
  try {
    const session = await createBillingPortalSession(mapping.accountId)
    res.json({ ok: true, ...session })
  } catch (e) {
    handleError(res, e)
  }
})

// GET /api/connect/refresh + /return — landing pages after account-link flow
router.get('/refresh', (req, res) => {
  res.redirect(302, '/api/connect?onboarding=refresh')
})
router.get('/return', (req, res) => {
  res.redirect(302, '/api/connect?onboarding=return')
})

// POST /api/connect/webhook — Stripe webhook endpoint (thin + classic events)
router.post(
  '/webhook',
  express.raw({ type: '*/*', limit: '256kb' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'] || ''
    if (!signature) return res.status(400).json({ error: 'Missing stripe-signature header' })
    const payload = req.body
    try {
      // Thin events (V2 account requirement changes) are signed with the same
      // secret; try that parser first, fall back to classic events.
      let result
      try {
        result = await handleConnectWebhook(payload, signature)
      } catch (err) {
        // Not a thin event — try the classic parser.
        result = await handleClassicWebhook(payload, signature)
      }
      res.json({ received: true, ...result })
    } catch (e) {
      res.status(400).json({ error: e.message })
    }
  }
)

export default router
