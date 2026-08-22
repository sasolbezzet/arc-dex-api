import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The middleware captures X402_INVOICE_DB at module load. Set it to a temp
// path BEFORE importing so these tests never read or overwrite the real
// production invoice file at the project root.
const dir = await mkdtemp(join(tmpdir(), 'arcox-refund-'))
process.env.X402_INVOICE_DB = join(dir, 'invoices.json')

const { createX402Invoice, markX402ServiceOutcome, getX402Invoice, getAllX402Invoices, publicInvoice } = await import('../src/middleware/x402Middleware.mjs')
const {
  scanRefundEligibleInvoices,
  listApprovedRefunds,
  markRefundCompleted,
  getRefundLog,
  executeRefund,
  executedRefundsToday,
} = await import('../src/services/x402RefundWorker.mjs')

const MSCA = '0x2222222222222222222222222222222222222222'

function resetState() {
  globalThis.__arcoxX402Invoices?.clear?.()
  globalThis.__arcoxX402RefundLog.length = 0
  globalThis.__arcoxX402UniqueCounter = 0
}

test.after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('auto-refund worker marks eligible invoices after cooldown', () => {
  resetState()
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  process.env.X402_REFUND_COOLDOWN_MS = '0' // no cooldown in test

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
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
  }
})

test('auto-refund worker skips invoices without provider error', () => {
  resetState()
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  process.env.X402_REFUND_COOLDOWN_MS = '0'

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
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
  }
})

test('auto-refund executes approved refund via injected spend and marks refunded', async () => {
  resetState()
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  const previousExecute = process.env.X402_REFUND_EXECUTE_ENABLED
  const previousCap = process.env.X402_REFUND_DAILY_CAP_USDC
  process.env.X402_REFUND_COOLDOWN_MS = '0'
  process.env.X402_REFUND_EXECUTE_ENABLED = 'true'
  process.env.X402_REFUND_DAILY_CAP_USDC = '10'

  try {
    const invoice = createX402Invoice({ ownerWallet: MSCA, resource: '/api/intel/risk/address/0xabc', amount: '0.03' })
    invoice.status = 'paid'
    invoice.txHash = '0x' + 'a'.repeat(64)
    invoice.paidAt = new Date().toISOString()
    markX402ServiceOutcome(invoice.invoiceId, { status: 'provider_error', reason: 'timeout', refundEligible: true })

    const approved = scanRefundEligibleInvoices()
    assert.equal(approved.length, 1)

    let spent
    const result = await executeRefund(invoice.invoiceId, {
      spendFn: async ({ amount, recipient }) => {
        spent = { amount, recipient }
        return { txHash: '0x' + 'd'.repeat(64) }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.txHash, '0x' + 'd'.repeat(64))
    assert.equal(spent.amount, invoice.uniqueAmount)
    assert.equal(spent.recipient, MSCA)

    const latest = getX402Invoice(invoice.invoiceId)
    assert.equal(latest.refundStatus, 'refunded')
    assert.equal(latest.refundTxHash, '0x' + 'd'.repeat(64))
    assert.equal(executedRefundsToday(), Number(invoice.uniqueAmount))
  } finally {
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
    if (previousExecute === undefined) delete process.env.X402_REFUND_EXECUTE_ENABLED
    else process.env.X402_REFUND_EXECUTE_ENABLED = previousExecute
    if (previousCap === undefined) delete process.env.X402_REFUND_DAILY_CAP_USDC
    else process.env.X402_REFUND_DAILY_CAP_USDC = previousCap
  }
})

test('auto-refund respects the daily cap and marks repeated failures manual', async () => {
  resetState()
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  const previousExecute = process.env.X402_REFUND_EXECUTE_ENABLED
  const previousCap = process.env.X402_REFUND_DAILY_CAP_USDC
  const previousAttempts = process.env.X402_REFUND_MAX_ATTEMPTS
  process.env.X402_REFUND_COOLDOWN_MS = '0'
  process.env.X402_REFUND_EXECUTE_ENABLED = 'true'
  process.env.X402_REFUND_DAILY_CAP_USDC = '0.01'
  process.env.X402_REFUND_MAX_ATTEMPTS = '2'

  try {
    const invoice = createX402Invoice({ ownerWallet: MSCA, resource: '/api/intel/loans/0xabc', amount: '0.03' })
    invoice.status = 'paid'
    invoice.txHash = '0x' + 'e'.repeat(64)
    invoice.paidAt = new Date().toISOString()
    markX402ServiceOutcome(invoice.invoiceId, { status: 'provider_error', reason: 'timeout', refundEligible: true })
    scanRefundEligibleInvoices()

    // Daily cap is 0.01 USDC, refund is 0.03 -> blocked
    const capped = await executeRefund(invoice.invoiceId, {
      spendFn: async () => ({ txHash: '0x' + 'f'.repeat(64) }),
    })
    assert.equal(capped.ok, false)
    assert.equal(capped.reason, 'daily_cap')

    // After raising the cap, the spend fails twice -> refund_failed_manual
    process.env.X402_REFUND_DAILY_CAP_USDC = '10'
    const failSpend = async () => { throw new Error('Gateway unreachable') }
    const first = await executeRefund(invoice.invoiceId, { spendFn: failSpend })
    assert.equal(first.ok, false)
    assert.equal(first.reason, 'spend_failed')
    const second = await executeRefund(invoice.invoiceId, { spendFn: failSpend })
    assert.equal(second.ok, false)
    const latest = getX402Invoice(invoice.invoiceId)
    assert.equal(latest.refundStatus, 'refund_failed_manual')
    assert.equal(latest.refundAttempts, 2)
    assert.match(latest.refundExecuteError, /Gateway unreachable/)
  } finally {
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
    if (previousExecute === undefined) delete process.env.X402_REFUND_EXECUTE_ENABLED
    else process.env.X402_REFUND_EXECUTE_ENABLED = previousExecute
    if (previousCap === undefined) delete process.env.X402_REFUND_DAILY_CAP_USDC
    else process.env.X402_REFUND_DAILY_CAP_USDC = previousCap
    if (previousAttempts === undefined) delete process.env.X402_REFUND_MAX_ATTEMPTS
    else process.env.X402_REFUND_MAX_ATTEMPTS = previousAttempts
  }
})

test('refund farming routes repeated provider-failure refunds to manual review', () => {
  resetState()
  const previousCooldown = process.env.X402_REFUND_COOLDOWN_MS
  const previousFarmLimit = process.env.X402_REFUND_FARM_LIMIT
  process.env.X402_REFUND_COOLDOWN_MS = '0'
  process.env.X402_REFUND_FARM_LIMIT = '3'

  try {
    // Three earlier refunds from the same owner inside the window
    for (let index = 0; index < 3; index += 1) {
      const previous = createX402Invoice({ ownerWallet: MSCA, resource: `/api/intel/address/0xfarm${index}`, amount: '0.01' })
      previous.status = 'paid'
      previous.refundStatus = 'refunded'
      previous.refundedAt = new Date(Date.now() - 60_000).toISOString()
      previous.serviceOutcomeAt = new Date(Date.now() - 120_000).toISOString()
    }
    // A fourth provider-failure refund -> farming detected -> manual review
    const invoice = createX402Invoice({ ownerWallet: MSCA, resource: '/api/intel/address/0xfarm3', amount: '0.01' })
    invoice.status = 'paid'
    invoice.txHash = '0x' + 'c'.repeat(64)
    invoice.paidAt = new Date().toISOString()
    markX402ServiceOutcome(invoice.invoiceId, { status: 'provider_error', reason: 'timeout', refundEligible: true })

    const approved = scanRefundEligibleInvoices()
    assert.equal(approved.length, 0, 'farming invoice must not be auto-approved')
    const latest = getX402Invoice(invoice.invoiceId)
    assert.equal(latest.refundStatus, 'manual_review')
    assert.match(getRefundLog().map(entry => entry.action).join(','), /refund_manual_review/)
  } finally {
    if (previousCooldown === undefined) delete process.env.X402_REFUND_COOLDOWN_MS
    else process.env.X402_REFUND_COOLDOWN_MS = previousCooldown
    if (previousFarmLimit === undefined) delete process.env.X402_REFUND_FARM_LIMIT
    else process.env.X402_REFUND_FARM_LIMIT = previousFarmLimit
  }
})
