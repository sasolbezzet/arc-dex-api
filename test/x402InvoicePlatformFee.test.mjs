import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Invoice-level contract for the platform fee: the buyer pays the service price
// plus the fee, the service price itself never shrinks, and switching the fee
// off reproduces the pre-fee behaviour exactly.
const dir = mkdtempSync(join(tmpdir(), 'arcox-invoice-fee-'))
process.env.X402_INVOICE_DB = join(dir, 'x402-invoices.json')
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
process.env.X402_PLATFORM_FEE_BPS = '500'
process.env.X402_PLATFORM_FEE_FIXED_USDC = '0'
process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'false'

const { createX402Invoice, publicInvoice } = await import('../src/middleware/x402Middleware.mjs?fee-test-' + Date.now())

const OWNER = '0xe43007a7f4a01f020f9ee11cabcd880f0ea25aa9'

test('without the services switch an ARCOX service invoice is unchanged', () => {
  const invoice = createX402Invoice({ amount: '0.05', ownerWallet: OWNER, resource: '/api/intel/address/0xabc' })
  assert.equal(invoice.baseAmount, '0.050000')
  assert.equal(invoice.platformFeeAmount, '0.000000')
  assert.equal(invoice.platformFeeSource, 'none')
  assert.equal(invoice.fee.amount, '0.000000')
  assert.match(invoice.fee.note, /^No ARCOX x402 platform fee/)
  // Only the unique-payment counter moves the payable amount.
  assert.equal(Number(invoice.uniqueAmount) - 0.05 < 0.001, true)
})

test('with the switch on the fee is added on top of the service price', () => {
  process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'true'
  const invoice = createX402Invoice({ amount: '0.050000', ownerWallet: OWNER, resource: '/api/intel/token/0xabc', uniqueAmount: '0.052500' })
  assert.equal(invoice.baseAmount, '0.050000', 'harga layanan tidak dipotong')
  assert.equal(invoice.platformFeeAmount, '0.002500')
  assert.equal(invoice.platformFeeBps, 500)
  assert.equal(invoice.platformFeeSource, 'arcox_services')
  assert.equal(invoice.fee.amount, '0.002500')
  assert.equal(invoice.fee.netAmount, '0.050000')
  assert.equal(invoice.fee.totalAmount, '0.052500')
  assert.equal(invoice.amount, '0.052500')
  assert.equal(invoice.amountBaseUnits, '52500')
  assert.match(invoice.fee.note, /5%|500 bps/)
  assert.equal(publicInvoice(invoice).platformFee.amountUsdc, '0.002500')
  process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'false'
})

test('an explicit split (marketplace resale) is honoured as given', () => {
  const invoice = createX402Invoice({
    service: 'arcox_marketplace',
    amount: '0.007000',
    ownerWallet: OWNER,
    resource: '/api/marketplace/call/mkt_aaaaaaaaaaaa',
    uniqueAmount: '0.007350',
    platformFee: { applied: true, bps: 500, amountUsdc: '0.000350', source: 'marketplace' },
    upstreamQuote: { resource: 'https://api.exa.ai/search', provider: 'Exa', amountUsdc: '0.007000' },
  })
  assert.equal(invoice.baseAmount, '0.007000')
  assert.equal(invoice.platformFeeAmount, '0.000350')
  assert.equal(invoice.platformFeeSource, 'marketplace')
  assert.equal(invoice.uniqueAmount, '0.007350')
  const publicShape = publicInvoice(invoice)
  assert.equal(publicShape.platformFee.amountUsdc, '0.000350')
  assert.equal(publicShape.platformFee.source, 'marketplace')
  assert.equal(publicShape.upstreamQuote.provider, 'Exa')
})
