// ARCOX Card Simulator routes — test-mode virtual Visa cards for agent spend.
// All endpoints are owner-gated (same pattern as x402 routes). The card
// network itself is simulated; balances are test USDC.

import express, { Router } from 'express'
import { verifyOwnerToken } from '../services/authToken.mjs'
import {
  cardConfig,
  listMerchants,
  fundTestBalance,
  getOwnerBalance,
  syncCardBalance,
  listCards,
  getCard,
  createCard,
  updateCardLimits,
  setCardStatus,
  authorizeCardSpend,
  settleCardTransaction,
  spendWithCard,
  refundCardTransaction,
  listCardTransactions,
  setProviderCard,
  findCardByProvider,
  recordExternalTransaction,
} from '../services/cardSimulator.mjs'
import { getIssuer, cardIssuerConfig } from '../services/cardIssuer.mjs'

const router = Router()

async function authenticatedIdentity(req) {
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
  return {
    owner,
    session,
    walletAddress: session?.walletAddress ? String(session.walletAddress).toLowerCase() : '',
  }
}

async function authenticatedOwner(req) {
  const identity = await authenticatedIdentity(req)
  return identity?.session?.active && identity.walletAddress
    ? { owner: identity.owner, walletAddress: identity.walletAddress }
    : null
}

function simulateAmount(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

router.get('/config', (_req, res) => {
  res.json({ ok: true, ...cardConfig(), issuer: cardIssuerConfig() })
})

router.get('/merchants', (_req, res) => {
  res.json({ ok: true, merchants: listMerchants() })
})

// Non-mutating preflight used by the Cards UI. A valid wallet login alone is
// not enough for card operations: balance sync and provisioning must be bound
// to an active Passkey-authorized MSCA session.
router.get('/access', async (req, res) => {
  const identity = await authenticatedIdentity(req)
  if (!identity) return res.status(401).json({ error: 'Wallet authentication required', active: false })
  res.json({
    ok: true,
    active: identity.session?.active === true,
    walletAddress: identity.walletAddress || null,
    statusReason: identity.session?.statusReason || 'setup_required',
    requiresPasskey: identity.session?.active !== true,
  })
})

router.post('/:cardId/provision', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const issuer = getIssuer()
  if (issuer.provider === 'simulator') {
    return res.status(400).json({ error: 'CARD_PROVIDER still simulator — set CARD_PROVIDER=lithic|stripe with keys to issue a real test card.' })
  }
  try {
    const result = await issuer.issueCard({ label: req.body?.label || 'ARCOX Agent Card' })
    const card = setProviderCard(auth.walletAddress, req.params.cardId, issuer.provider, result.providerCardId, result.pan, result)
    if (!card) return res.status(404).json({ error: 'Card not found' })
    // Never return PAN/CVV from provisioning. The card remains masked until
    // the owner completes a fresh biometric/passkey assertion at /reveal.
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      ok: true,
      card,
      provider: issuer.provider,
      providerCardId: result.providerCardId,
      sensitive: false,
    })
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message })
  }
})

router.get('/balance', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    res.json({ ok: true, ...(await getOwnerBalance(auth.walletAddress, { walletAddress: auth.walletAddress })) })
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message })
  }
})

router.post('/sync', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    res.json({ ok: true, ...(await syncCardBalance(auth.walletAddress, auth.walletAddress, { force: true })) })
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message })
  }
})

router.post('/balance/fund', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const amount = simulateAmount(req.body?.amount, '25')
  if (!/^\d+(\.\d+)?$/.test(amount)) return res.status(400).json({ error: 'amount must be a number in USDC' })
  try {
    res.json({ ok: true, ...fundTestBalance(auth.walletAddress, amount) })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.get('/', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  res.json({ ok: true, cards: listCards(auth.walletAddress) })
})

router.post('/', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    const card = createCard(auth.walletAddress, {
      label: req.body?.label,
      perTxLimit: simulateAmount(req.body?.perTxLimit, '25'),
      dailyLimit: simulateAmount(req.body?.dailyLimit, '100'),
      monthlyLimit: simulateAmount(req.body?.monthlyLimit, undefined),
      blockedCategories: Array.isArray(req.body?.blockedCategories) ? req.body.blockedCategories : [],
    })
    // Creation only returns a masked record. Full PAN/CVV requires the
    // separate fingerprint/passkey-gated reveal flow below.
    res.json({ ok: true, card: getCard(auth.walletAddress, card.cardId) })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // Issuer webhook (stripe/lithic test mode). Signature verification is
  // dashboard-configured; test-mode events are parsed without secret.
  try {
    const issuer = getIssuer()
    let payload = req.body
    if (Buffer.isBuffer(payload)) {
      try { payload = JSON.parse(payload.toString('utf8')) } catch { payload = {} }
    }
    const event = issuer.parseWebhookEvent ? issuer.parseWebhookEvent(payload) : null
    if (!event || !event.cardId) return res.status(200).json({ ok: true, ignored: true })
    const local = findCardByProvider(event.cardId)
    if (!local) return res.status(200).json({ ok: true, ignored: true, reason: 'unknown provider card' })
    recordExternalTransaction({
      // Lithic transaction webhooks use `token` as the stable transaction ID;
      // keep classic event IDs as a fallback for Stripe/legacy payloads.
      id: payload?.id || payload?.event?.id || payload?.token || payload?.data?.token || payload?.data?.object?.id,
      cardId: local.cardId,
      merchantName: event.merchantName,
      category: event.category,
      amount: event.amount,
      status: event.status,
      settledAt: event.status === 'settled' ? (payload?.updated_at || payload?.created_at || new Date().toISOString()) : null,
      refundedAt: event.status === 'refunded' ? (payload?.updated_at || payload?.created_at || new Date().toISOString()) : null,
      provider: issuer.provider,
    })
    res.json({ ok: true, recorded: true, event: event.eventType })
  } catch {
    res.status(200).json({ ok: true, ignored: true })
  }
})

router.get('/my-transactions', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  res.json({ ok: true, transactions: listCardTransactions(auth.walletAddress) })
})

router.get('/:cardId/reveal', async (req, res) => {
  const rawToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  // The browser performs a fresh WebAuthn assertion (fingerprint, Face ID,
  // Windows Hello, or security key) before calling this endpoint. Require the
  // resulting short-lived vault session as well as the active MSCA binding;
  // an old stored token can never reveal PAN/CVV by itself.
  const { isRecentSession } = await import('../services/vaultStore.mjs')
  if (!rawToken.startsWith('arx_vs_') || !isRecentSession(rawToken, 120000)) {
    return res.status(401).json({ error: 'Fresh fingerprint/passkey authentication required' })
  }
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const card = getCard(auth.walletAddress, req.params.cardId, { includePan: true })
  if (!card) return res.status(404).json({ error: 'Card not found' })
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  res.json({ ok: true, sensitive: true, card })
})

router.get('/:cardId', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  // Card details remain masked after provisioning. Full PAN/CVV is available
  // only through the fresh fingerprint/passkey reveal endpoint above.
  const card = listCards(auth.walletAddress).find(c => c.cardId === req.params.cardId)
  if (!card) return res.status(404).json({ error: 'Card not found' })
  res.json({ ok: true, card })
})

router.patch('/:cardId/limits', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    const card = updateCardLimits(auth.walletAddress, req.params.cardId, {
      perTxLimit: simulateAmount(req.body?.perTxLimit, undefined),
      dailyLimit: simulateAmount(req.body?.dailyLimit, undefined),
      monthlyLimit: simulateAmount(req.body?.monthlyLimit, undefined),
    })
    res.json({ ok: true, card })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.post('/:cardId/status', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    const card = setCardStatus(auth.walletAddress, req.params.cardId, String(req.body?.status || ''))
    res.json({ ok: true, card })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.post('/:cardId/spend', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const merchantId = String(req.body?.merchantId || '').trim()
  const amount = String(req.body?.amount ?? '').trim()
  if (!merchantId || !amount) return res.status(400).json({ error: 'merchantId and amount are required' })
  try {
    const result = await spendWithCard(auth.walletAddress, req.params.cardId, {
      merchantId,
      amount,
      description: req.body?.description,
      walletAddress: auth.walletAddress,
    })
    if (!result.approved) return res.status(402).json({ ok: false, ...result })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message })
  }
})

router.post('/:cardId/authorize', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const merchantId = String(req.body?.merchantId || '').trim()
  const amount = String(req.body?.amount ?? '').trim()
  if (!merchantId || !amount) return res.status(400).json({ error: 'merchantId and amount are required' })
  try {
    const result = await authorizeCardSpend(auth.walletAddress, req.params.cardId, {
      merchantId,
      amount,
      description: req.body?.description,
      walletAddress: auth.walletAddress,
    })
    if (!result.approved) return res.status(400).json({ ok: false, ...result })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message })
  }
})

router.post('/:cardId/settle', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    const result = await settleCardTransaction(auth.walletAddress, String(req.body?.txId || ''), { walletAddress: auth.walletAddress })
    res.json({ ok: result.settled, ...result })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.post('/:cardId/refund', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  try {
    const result = refundCardTransaction(auth.walletAddress, String(req.body?.txId || ''))
    if (!result.refunded) return res.status(400).json({ ok: false, ...result })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.get('/:cardId/transactions', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  res.json({ ok: true, transactions: listCardTransactions(auth.walletAddress, req.params.cardId) })
})

export default router