import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The middleware captures X402_INVOICE_DB at module load. Set it to a temp
// path BEFORE importing so these tests never read or overwrite the real
// production invoice file at the project root.
const dir = await mkdtemp(join(tmpdir(), 'arcox-abuse-'))
process.env.X402_INVOICE_DB = join(dir, 'invoices.json')

const { createX402Invoice, countOpenX402Invoices } = await import('../src/middleware/x402Middleware.mjs')
const { countOwnerRecentRefunds } = await import('../src/services/x402RefundWorker.mjs')

const OWNER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OWNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function resetState() {
  globalThis.__arcoxX402Invoices?.clear?.()
  globalThis.__arcoxX402OwnerActivity?.clear?.()
  globalThis.__arcoxX402UniqueCounter = 0
}

test.after(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('x402 abuse guard caps open invoices per owner and counts them', () => {
  resetState()
  const previousMax = process.env.X402_MAX_UNPAID_PER_OWNER
  const previousCooldown = process.env.X402_INVOICE_COOLDOWN_MS
  process.env.X402_MAX_UNPAID_PER_OWNER = '2'
  process.env.X402_INVOICE_COOLDOWN_MS = '0'
  try {
    createX402Invoice({ ownerWallet: OWNER_A, resource: '/api/intel/a', amount: '0.005' })
    createX402Invoice({ ownerWallet: OWNER_A, resource: '/api/intel/b', amount: '0.005' })
    assert.equal(countOpenX402Invoices(OWNER_A), 2)
    assert.throws(() => createX402Invoice({ ownerWallet: OWNER_A, resource: '/api/intel/c', amount: '0.005' }), error => {
      assert.equal(error.code, 'X402_MAX_UNPAID_INVOICES')
      assert.equal(error.statusCode, 429)
      return true
    })
    // A different owner is not affected by A's cap
    createX402Invoice({ ownerWallet: OWNER_B, resource: '/api/intel/d', amount: '0.005' })
    // Paying one invoice frees a slot
    const paid = createX402Invoice({ ownerWallet: OWNER_B, resource: '/api/intel/e', amount: '0.005' })
    paid.status = 'paid'
    paid.txHash = '0x' + 'a'.repeat(64)
    paid.paidAt = new Date().toISOString()
    createX402Invoice({ ownerWallet: OWNER_B, resource: '/api/intel/f', amount: '0.005' })
    assert.equal(countOpenX402Invoices(OWNER_B), 2)
  } finally {
    if (previousMax === undefined) delete process.env.X402_MAX_UNPAID_PER_OWNER
    else process.env.X402_MAX_UNPAID_PER_OWNER = previousMax
    if (previousCooldown === undefined) delete process.env.X402_INVOICE_COOLDOWN_MS
    else process.env.X402_INVOICE_COOLDOWN_MS = previousCooldown
  }
})

test('x402 abuse guard enforces invoice creation cooldown when configured', () => {
  resetState()
  const previousMax = process.env.X402_MAX_UNPAID_PER_OWNER
  const previousCooldown = process.env.X402_INVOICE_COOLDOWN_MS
  process.env.X402_MAX_UNPAID_PER_OWNER = '100'
  process.env.X402_INVOICE_COOLDOWN_MS = '60000'
  try {
    createX402Invoice({ ownerWallet: OWNER_A, resource: '/api/intel/a', amount: '0.005' })
    assert.throws(() => createX402Invoice({ ownerWallet: OWNER_A, resource: '/api/intel/b', amount: '0.005' }), error => {
      assert.equal(error.code, 'X402_INVOICE_RATE_LIMITED')
      assert.equal(error.statusCode, 429)
      return true
    })
  } finally {
    if (previousMax === undefined) delete process.env.X402_MAX_UNPAID_PER_OWNER
    else process.env.X402_MAX_UNPAID_PER_OWNER = previousMax
    if (previousCooldown === undefined) delete process.env.X402_INVOICE_COOLDOWN_MS
    else process.env.X402_INVOICE_COOLDOWN_MS = previousCooldown
  }
})

test('refund farming detection counts provider-failure refunds per owner', () => {
  resetState()
  const previousLimit = process.env.X402_REFUND_FARM_LIMIT
  const previousWindow = process.env.X402_REFUND_FARM_WINDOW_MS
  process.env.X402_REFUND_FARM_LIMIT = '3'
  process.env.X402_REFUND_FARM_WINDOW_MS = '86400000'
  try {
    for (let index = 0; index < 3; index += 1) {
      const invoice = createX402Invoice({ ownerWallet: OWNER_A, resource: `/api/intel/farm/${index}`, amount: '0.01' })
      invoice.status = 'paid'
      invoice.refundStatus = 'refunded'
      invoice.refundedAt = new Date(Date.now() - 60_000).toISOString()
      invoice.serviceOutcomeAt = new Date(Date.now() - 120_000).toISOString()
    }
    assert.equal(countOwnerRecentRefunds(OWNER_A), 3)
    assert.equal(countOwnerRecentRefunds(OWNER_B), 0)
  } finally {
    if (previousLimit === undefined) delete process.env.X402_REFUND_FARM_LIMIT
    else process.env.X402_REFUND_FARM_LIMIT = previousLimit
    if (previousWindow === undefined) delete process.env.X402_REFUND_FARM_WINDOW_MS
    else process.env.X402_REFUND_FARM_WINDOW_MS = previousWindow
  }
})
