import { Router } from 'express'
import { createX402PaymentRequest, getX402PaymentRequest, verifyX402Payment, x402Config } from '../middleware/x402Middleware.mjs'

const router = Router()

router.post('/payment-request', (req, res) => {
  const body = req.body || {}
  const resource = String(body.resource || '').trim()
  if (!resource.startsWith('/api/')) return res.status(400).json({ error: 'resource must be an /api/... path' })
  const payment = createX402PaymentRequest({
    service: body.service || 'arcox_intel',
    amount: body.amount,
    resource,
  })
  res.json({ ok: true, x402: payment, config: publicConfig() })
})

router.get('/payment-request/:paymentId', (req, res) => {
  const payment = getX402PaymentRequest(req.params.paymentId)
  if (!payment) return res.status(404).json({ error: 'x402 payment request not found' })
  res.json({ ok: true, x402: payment })
})

router.post('/verify', async (req, res) => {
  try {
    const result = await verifyX402Payment({
      paymentId: req.body?.paymentId,
      txHash: req.body?.txHash,
      payerAddress: req.body?.payerAddress,
    })
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'x402 verification failed' })
  }
})

router.get('/config', (_req, res) => {
  res.json({ ok: true, config: publicConfig() })
})

function publicConfig() {
  const cfg = x402Config()
  return {
    enabled: cfg.enabled,
    verifyPayment: cfg.verifyPayment,
    network: cfg.network,
    chainId: cfg.chainId,
    asset: cfg.asset,
    tokenAddress: cfg.tokenAddress,
    recipient: cfg.recipient,
    expiresInSeconds: cfg.expiresInSeconds,
  }
}

export default router
