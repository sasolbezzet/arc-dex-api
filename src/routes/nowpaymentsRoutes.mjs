import { Router } from 'express'
import { randomUUID } from 'crypto'

const router = Router()
const invoices = globalThis.__arcoxNowpaymentsInvoices || new Map()
globalThis.__arcoxNowpaymentsInvoices = invoices

function mode() {
  return String(process.env.NOWPAYMENTS_MODE || 'mock').toLowerCase()
}

function merchantWallet() {
  return process.env.NOWPAYMENTS_MERCHANT_WALLET || process.env.DESTINATION_WALLET_ADDRESS || process.env.ARCOX_TREASURY_WALLET_ADDRESS || ''
}

function makeInvoice(input = {}) {
  const id = `mock_np_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  const now = new Date()
  const invoice = {
    id,
    invoiceId: id,
    status: 'waiting_payment',
    amount: String(input.amount || '1'),
    currency: String(input.currency || input.token || 'USDC').toUpperCase(),
    network: 'Arc Testnet',
    payAddress: process.env.DESTINATION_WALLET_ADDRESS || merchantWallet() || '0x0000000000000000000000000000000000000000',
    merchantWallet: merchantWallet() || 'configure_NOWPAYMENTS_MERCHANT_WALLET',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Number(input.expiresInMinutes || 15) * 60_000).toISOString(),
    mode: mode(),
    metadata: {
      orderId: input.orderId || input.order_id || id,
      memo: input.memo || input.description || '',
    },
  }
  invoices.set(id, invoice)
  return invoice
}

router.post('/invoice', (req, res) => {
  const amount = Number(req.body?.amount || 0)
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be greater than 0' })
  res.json(makeInvoice(req.body || {}))
})

router.get('/invoice/:id', (req, res) => {
  const invoice = invoices.get(req.params.id)
  if (!invoice) return res.status(404).json({ error: 'invoice not found' })
  if (!['paid', 'failed', 'expired'].includes(invoice.status) && Date.now() > new Date(invoice.expiresAt).getTime()) invoice.status = 'expired'
  res.json(invoice)
})

router.post('/invoice/:id/simulate-paid', (req, res) => {
  const invoice = invoices.get(req.params.id)
  if (!invoice) return res.status(404).json({ error: 'invoice not found' })
  if (invoice.status === 'expired') return res.status(400).json({ error: 'invoice expired' })
  invoice.status = 'paid'
  invoice.paidAt = new Date().toISOString()
  invoice.txHash = req.body?.txHash || `0xmocknp${Date.now().toString(16)}`
  invoices.set(invoice.id, invoice)
  res.json(invoice)
})

router.post('/ipn/mock', (req, res) => {
  const id = String(req.body?.invoiceId || req.body?.payment_id || req.body?.id || '')
  const invoice = invoices.get(id)
  if (invoice) {
    invoice.status = mapStatus(req.body?.payment_status || req.body?.status)
    invoice.updatedAt = new Date().toISOString()
    invoices.set(invoice.id, invoice)
  }
  res.json({ ok: true, received: true, provider: 'nowpayments', mode: mode(), invoice: invoice || null })
})

function mapStatus(status) {
  const value = String(status || '').toLowerCase()
  if (['finished', 'paid', 'confirmed'].includes(value)) return 'paid'
  if (['confirming', 'sending'].includes(value)) return 'confirming'
  if (['failed', 'refunded'].includes(value)) return 'failed'
  if (value === 'expired') return 'expired'
  return 'waiting_payment'
}

export default router
