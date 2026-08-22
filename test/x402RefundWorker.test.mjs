import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createX402Invoice, markX402ServiceOutcome, getX402Invoice, getAllX402Invoices, publicInvoice } from '../src/middleware/x402Middleware.mjs'
import { scanRefundEligibleInvoices, listApprovedRefunds, markRefundCompleted, getRefundLog } from '../src/services/x402RefundWorker.mjs'

const MSCA = '0x2222222222222222222222222222222222222222'

test('auto-refund worker marks eligible invoices after cooldown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-refund-'))
  const previousDb = process.env.X402_INVOICE_DB
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  process.env.X402_INVOICE_DB = join(dir, 'invoices.json')
  process.env.X402_REFUND_COOLDOWN_MS = '0' // no cooldown in test
  // Clear ALL global invoice state so prior tests don't leak into this one
  globalThis.__arcoxX402Invoices?.clear?.()
  globalThis.__arcoxX402RefundLog.length = 0
  globalThis.__arcoxX402UniqueCounter = 0

  try {
    // Create an invoice, simulate payment, then mark provider error
    const invoice = createX402Invoice({
      ownerWallet: MSCA,
      resource: '/api/intel/risk/address/0x123',
      amount: '0.03',
    })
    // Simulate paid
    invoice.status = 'paid'
    invoice.txHash = '0x' + 'a'.repeat(64)
    invoice.paidAt = new Date().toISOString()
    // Mark provider not found
    markX402ServiceOutcome(invoice.invoiceId, {
      status: 'provider_not_found',
      reason: 'Address not found in Arkham',
      refundEligible: true,
    })

    // Verify only our test invoice is in the eligible state
    const allBefore = getAllX402Invoices()
    const eligibleBefore = allBefore.filter(i => i.status === 'paid' && i.refundEligible && i.refundStatus === 'pending_review' && ['provider_not_found', 'provider_error'].includes(i.serviceStatus))
    assert.equal(eligibleBefore.length, 1, `expected 1 eligible invoice before scan, got ${eligibleBefore.length}`)

    // Scan should auto-approve
    const approved = scanRefundEligibleInvoices()
    assert.equal(approved.length, 1)
    assert.equal(approved[0].refundStatus, 'refund_approved')
    assert.ok(approved[0].refundApprovedAt)

    // List approved
    const list = listApprovedRefunds()
    assert.equal(list.length, 1)
    assert.equal(list[0].invoiceId, invoice.invoiceId)

    // Mark completed
    const completed = markRefundCompleted(invoice.invoiceId, '0x' + 'b'.repeat(64))
    assert.equal(completed.refundStatus, 'refunded')
    assert.ok(completed.refundTxHash)

    // Log should have entries
    const log = getRefundLog()
    assert.ok(log.length >= 2)
    assert.match(log[0].action, /refund_approved/)
  } finally {
    if (previousDb === undefined) delete process.env.X402_INVOICE_DB
    else process.env.X402_INVOICE_DB = previousDb
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto-refund worker skips invoices without provider error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-refund-skip-'))
  const previousDb = process.env.X402_INVOICE_DB
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  process.env.X402_INVOICE_DB = join(dir, 'invoices.json')
  process.env.X402_REFUND_COOLDOWN_MS = '0'
  // Clear ALL global invoice state so prior tests don't leak into this one
  globalThis.__arcoxX402Invoices?.clear?.()
  globalThis.__arcoxX402RefundLog.length = 0
  globalThis.__arcoxX402UniqueCounter = 0

  try {
    // Create a paid invoice without provider error (service_unlocked)
    const invoice = createX402Invoice({
      ownerWallet: MSCA,
      resource: '/api/intel/address/0x123',
      amount: '0.005',
    })
    invoice.status = 'paid'
    invoice.txHash = '0x' + 'c'.repeat(64)
    invoice.paidAt = new Date().toISOString()
    invoice.serviceStatus = 'service_unlocked'
    invoice.refundEligible = false
    invoice.refundStatus = 'not_eligible'

    const approved = scanRefundEligibleInvoices()
    assert.equal(approved.length, 0, 'should not auto-approve invoices without provider error')
  } finally {
    if (previousDb === undefined) delete process.env.X402_INVOICE_DB
    else process.env.X402_INVOICE_DB = previousDb
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
    await rm(dir, { recursive: true, force: true })
  }
})
