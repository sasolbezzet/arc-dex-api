import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The middleware captures X402_INVOICE_DB at module load. Set it to a temp
// path BEFORE importing so these tests never read or overwrite the real
// production invoice file at the project root.
const dir = await mkdtemp(join(tmpdir(), 'arcox-stats-'))
process.env.X402_INVOICE_DB = join(dir, 'invoices.json')

const { createX402Invoice, getX402Stats, markX402ServiceOutcome } = await import('../src/middleware/x402Middleware.mjs')

const OWNER = '0xcccccccccccccccccccccccccccccccccccccccc'

function resetState() {
  globalThis.__arcoxX402Invoices?.clear?.()
  globalThis.__arcoxX402OwnerActivity?.clear?.()
  globalThis.__arcoxX402UniqueCounter = 0
}

test.after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('x402 stats aggregates revenue, statuses, services, and refund pipeline', () => {
  resetState()
  // Two paid invoices (one with a provider error -> refundable)
  const paidOne = createX402Invoice({ ownerWallet: OWNER, resource: '/api/intel/risk/address/0x1', amount: '0.03', service: 'arcox_intel' })
  paidOne.status = 'paid'
  paidOne.txHash = '0x' + 'a'.repeat(64)
  paidOne.paidAt = new Date(Date.now() - 60_000).toISOString()
  const paidTwo = createX402Invoice({ ownerWallet: OWNER, resource: '/api/intel/address/0x2', amount: '0.01', service: 'arcox_intel' })
  paidTwo.status = 'paid'
  paidTwo.txHash = '0x' + 'b'.repeat(64)
  paidTwo.paidAt = new Date(Date.now() - 120_000).toISOString()
  markX402ServiceOutcome(paidTwo.invoiceId, { status: 'provider_not_found', reason: 'no data', refundEligible: true })

  // One open invoice and one expired
  createX402Invoice({ ownerWallet: OWNER, resource: '/api/intel/balances/0x3', amount: '0.01', service: 'arcox_intel' })
  const expired = createX402Invoice({ ownerWallet: OWNER, resource: '/api/intel/balances/0x4', amount: '0.01', service: 'arcox_intel' })
  expired.status = 'expired'
  expired.settlementStatus = 'expired'
  expired.updatedAt = new Date().toISOString()

  const expectedRevenue = Number(paidOne.uniqueAmount) + Number(paidTwo.uniqueAmount)
  const stats = getX402Stats()
  assert.equal(stats.totals.invoices, 4)
  assert.equal(stats.totals.paid, 2)
  assert.equal(stats.totals.open, 1)
  assert.equal(stats.totals.expired, 1)
  assert.equal(stats.revenueUsdc, expectedRevenue)
  assert.equal(stats.revenueLast24hUsdc, expectedRevenue)
  assert.equal(stats.paid24h, 2)
  assert.equal(stats.providerErrors.provider_not_found, 1)
  assert.equal(stats.providerErrors.provider_error, 0)
  assert.equal(stats.refunds.pending_review, 1)
  assert.equal(stats.byService.arcox_intel, 4)
  assert.equal(stats.byStatus.paid, 2)
})
