import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('paid x402 invoice records provider 5xx timeout as refund-review eligible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-x402-outcome-5xx-'))
  const previousDb = process.env.X402_INVOICE_DB
  process.env.X402_INVOICE_DB = join(dir, 'invoices.json')
  try {
    const { createX402Invoice, markX402ServiceOutcome, publicInvoice } = await import('../src/middleware/x402Middleware.mjs?outcome-5xx-' + Date.now() + '-' + Math.random())
    const invoice = createX402Invoice({
      invoiceId: 'test_invoice_5xx_' + Date.now(),
      paymentId: 'test_payment_5xx_' + Date.now(),
      ownerWallet: '0x2222222222222222222222222222222222222222',
      resource: '/api/intel/balances/solana/subaccounts/address/x',
      amount: '0.02',
    })
    invoice.status = 'paid'
    const updated = markX402ServiceOutcome(invoice, {
      status: 'provider_error',
      reason: 'The operation was aborted due to timeout',
      refundEligible: true,
    })
    const visible = publicInvoice(updated)
    assert.equal(visible.status, 'paid')
    assert.equal(visible.serviceStatus, 'provider_error')
    assert.equal(visible.refundEligible, true)
    assert.equal(visible.refundStatus, 'pending_review')
    assert.match(visible.serviceError, /timeout/i)
  } finally {
    if (previousDb === undefined) delete process.env.X402_INVOICE_DB
    else process.env.X402_INVOICE_DB = previousDb
    await rm(dir, { recursive: true, force: true })
  }
})

test('paid x402 invoice records provider-not-found as refund-review eligible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-x402-outcome-'))
  const previousDb = process.env.X402_INVOICE_DB
  process.env.X402_INVOICE_DB = join(dir, 'invoices.json')
  try {
    const { createX402Invoice, markX402ServiceOutcome, publicInvoice } = await import('../src/middleware/x402Middleware.mjs?outcome-' + Date.now() + '-' + Math.random())
    const invoice = createX402Invoice({
      invoiceId: 'test_invoice_' + Date.now(),
      paymentId: 'test_payment_' + Date.now(),
      ownerWallet: '0x2222222222222222222222222222222222222222',
      resource: '/api/intel/token/bitcoin',
      amount: '0.005',
    })
    invoice.status = 'paid'
    const updated = markX402ServiceOutcome(invoice, {
      status: 'provider_not_found',
      reason: 'token not found: bitcoin',
      refundEligible: true,
    })
    const visible = publicInvoice(updated)
    assert.equal(visible.status, 'paid')
    assert.equal(visible.serviceStatus, 'provider_not_found')
    assert.equal(visible.refundEligible, true)
    assert.equal(visible.refundStatus, 'pending_review')
    assert.match(visible.serviceError, /not found/i)
  } finally {
    if (previousDb === undefined) delete process.env.X402_INVOICE_DB
    else process.env.X402_INVOICE_DB = previousDb
    await rm(dir, { recursive: true, force: true })
  }
})
