// ARCOX Card Simulator routes — test-mode virtual Visa cards for agent spend.
// All endpoints are owner-gated (same pattern as x402 routes). The card
// network itself is simulated; balances are test USDC.

import { Router } from 'express'
import { verifyOwnerToken } from '../services/authToken.mjs'
import {
  cardConfig,
  listMerchants,
  fundTestBalance,
  getOwnerBalance,
  syncCardBalance,
  listCards,
  createCard,
  updateCardLimits,
  setCardStatus,
  authorizeCardSpend,
  settleCardTransaction,
  spendWithCard,
  refundCardTransaction,
  listCardTransactions,
} from '../services/cardSimulator.mjs'

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

function simulateAmount(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return String(value)
}

router.get('/config', (_req, res) => {
  res.json({ ok: true, ...cardConfig() })
})

router.get('/merchants', (_req, res) => {
  res.json({ ok: true, merchants: listMerchants() })
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
    res.json({ ok: true, card })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message })
  }
})

router.get('/my-transactions', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  res.json({ ok: true, transactions: listCardTransactions(auth.walletAddress) })
})

router.get('/:cardId', async (req, res) => {
  const auth = await authenticatedOwner(req)
  if (!auth) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const card = listCards(auth.walletAddress, { includePan: true }).find(c => c.cardId === req.params.cardId)
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