import { Router } from 'express'
import { createX402Invoice, getX402Invoice, publicInvoice, reconcileX402Invoice, x402Config } from '../middleware/x402Middleware.mjs'

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
    error: 'Manual x402 txHash verification is disabled. Pay the exact invoice amount to the Circle treasury wallet and wait for Circle transactions.inbound webhook.',
  })
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
    circleEnvironment: cfg.circleEnvironment,
    circleBaseUrl: cfg.circleBaseUrl,
    circleTreasuryWalletId: cfg.circleTreasuryWalletId,
    recipient: cfg.circleTreasuryAddress,
    memoContract: cfg.memoContract,
    paymentMethod: 'arc-transaction-memo',
    baseAmount: cfg.baseAmount,
    expiresInSeconds: cfg.ttlSeconds,
    mockMode: false,
  }
}

export default router
