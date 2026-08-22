import { Router } from 'express'
import {
  createX402Invoice,
  estimateUnifiedBalanceX402,
  getX402Invoice,
  markUnifiedBalanceSpendSubmitted,
  publicInvoice,
  reconcileX402Invoice,
  x402Config,
} from '../middleware/x402Middleware.mjs'
import { verifyAgentOwnership } from '../services/agentIdentityService.mjs'
import { verifyOwnerToken } from '../services/authToken.mjs'
import {
  listApprovedRefunds,
  markRefundCompleted,
  scanRefundEligibleInvoices,
  getRefundLog,
} from '../services/x402RefundWorker.mjs'

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

router.post('/invoices/create', async (req, res) => {
  const body = req.body || {}
  const resource = String(body.resource || '').trim()
  if (!resource.startsWith('/api/')) return res.status(400).json({ error: 'resource must be an /api/... path' })
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  if (body.ownerWallet && String(body.ownerWallet).toLowerCase() !== authOwner.walletAddress) return res.status(403).json({ error: 'ownerWallet must match authenticated MSCA' })
  if (body.agentId && !await verifyAgentOwnership(body.agentId, authOwner.walletAddress)) return res.status(403).json({ error: 'Agent identity mismatch' })
  const invoice = createX402Invoice({
    service: body.service || 'arcox_intel',
    amount: body.amount,
    resource,
    agentId: body.agentId,
    ownerWallet: authOwner.walletAddress,
  })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice), config: publicConfig() })
})

router.get('/invoices/:invoiceId/status', async (req, res) => {
  const invoice = await reconcileX402Invoice(req.params.invoiceId)
  if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.post('/payment-request', async (req, res) => {
  const body = req.body || {}
  const resource = String(body.resource || '').trim()
  if (!resource.startsWith('/api/')) return res.status(400).json({ error: 'resource must be an /api/... path' })
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  if (body.ownerWallet && String(body.ownerWallet).toLowerCase() !== authOwner.walletAddress) return res.status(403).json({ error: 'ownerWallet must match authenticated MSCA' })
  if (body.agentId && !await verifyAgentOwnership(body.agentId, authOwner.walletAddress)) return res.status(403).json({ error: 'Agent identity mismatch' })
  const invoice = createX402Invoice({
    service: body.service || 'arcox_intel',
    amount: body.amount,
    resource,
    agentId: body.agentId,
    ownerWallet: authOwner.walletAddress,
  })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice), config: publicConfig() })
})

router.get('/payment-request/:paymentId', async (req, res) => {
  const invoice = await reconcileX402Invoice(req.params.paymentId)
  if (!invoice) return res.status(404).json({ error: 'x402 payment request not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.post('/verify', (_req, res) => {
  res.status(410).json({
    ok: false,
    error: 'Manual x402 txHash verification is disabled. Pay with a direct MSCA USDC transfer or Unified Balance and wait for on-chain/webhook reconciliation.',
  })
})

router.post('/invoices/:invoiceId/estimate-unified-balance', (req, res) => {
  try {
    const invoice = estimateUnifiedBalanceX402(req.params.invoiceId, req.body || {})
    if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
    res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Unified Balance estimate failed' })
  }
})

router.post('/invoices/:invoiceId/spend-submitted', (req, res) => {
  const invoice = markUnifiedBalanceSpendSubmitted(req.params.invoiceId, req.body || {})
  if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.get('/config', (_req, res) => {
  res.json({ ok: true, config: publicConfig() })
})

// ── Refund management ──
// These endpoints list auto-approved refunds and allow a treasury operator
// to mark them as completed. The actual on-chain USDC transfer must be
// performed by a separately authenticated treasury process; this API only
// tracks the state and audit trail.

router.get('/refunds/approved', (_req, res) => {
  res.json({ ok: true, refunds: listApprovedRefunds() })
})

router.get('/refunds/log', (_req, res) => {
  res.json({ ok: true, log: getRefundLog() })
})

router.post('/refunds/scan', (_req, res) => {
  const approved = scanRefundEligibleInvoices()
  res.json({ ok: true, approved, count: approved.length })
})

router.post('/refunds/:invoiceId/complete', (req, res) => {
  const txHash = String(req.body?.txHash || '').trim()
  if (!txHash) return res.status(400).json({ error: 'txHash is required' })
  const invoice = markRefundCompleted(req.params.invoiceId, txHash)
  if (!invoice) return res.status(404).json({ error: 'Refund-eligible invoice not found' })
  res.json({ ok: true, refund: invoice })
})

function publicConfig() {
  const cfg = x402Config()
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    asset: cfg.asset,
    network: cfg.network,
    chainId: cfg.chainId,
    usdcAddress: cfg.usdcAddress,
    circleEnvironment: cfg.circleEnvironment,
    circleBaseUrl: cfg.circleBaseUrl,
    circleTreasuryWalletId: cfg.circleTreasuryWalletId,
    recipient: cfg.circleTreasuryAddress,
    paymentMethod: 'arc-usdc-direct',
    paymentMethods: ['arc-usdc-direct', 'unified-balance-gateway'],
    baseAmount: cfg.baseAmount,
    expiresInSeconds: cfg.ttlSeconds,
  }
}

export default router
