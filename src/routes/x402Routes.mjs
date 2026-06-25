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

const router = Router()

router.post('/invoices/create', (req, res) => {
  const body = req.body || {}
  const resource = String(body.resource || '').trim()
  if (!resource.startsWith('/api/')) return res.status(400).json({ error: 'resource must be an /api/... path' })
  const invoice = createX402Invoice({
    service: body.service || 'arcox_intel',
    amount: body.amount,
    resource,
  })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice), config: publicConfig() })
})

router.get('/invoices/:invoiceId/status', async (req, res) => {
  const invoice = await reconcileX402Invoice(req.params.invoiceId)
  if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.post('/payment-request', (req, res) => {
  const body = req.body || {}
  const resource = String(body.resource || '').trim()
  if (!resource.startsWith('/api/')) return res.status(400).json({ error: 'resource must be an /api/... path' })
  const invoice = createX402Invoice({
    service: body.service || 'arcox_intel',
    amount: body.amount,
    resource,
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
    error: 'Manual x402 txHash verification is disabled. Pay with Arc USDC memo or Unified Balance and wait for on-chain/webhook reconciliation.',
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
    memoContract: cfg.memoContract,
    paymentMethod: 'arc-usdc-memo',
    paymentMethods: ['arc-usdc-memo', 'unified-balance-gateway'],
    baseAmount: cfg.baseAmount,
    expiresInSeconds: cfg.ttlSeconds,
  }
}

export default router
