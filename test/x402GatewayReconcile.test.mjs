import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('Gateway transfer submitted by the browser finalizes a matching x402 invoice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arcox-x402-'))
  const txHash = `0x${'12'.repeat(32)}`
  const transferId = '12345678-1234-4234-8234-123456789abc'
  const recipient = `0x${'34'.repeat(20)}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async url => {
    assert.match(String(url), new RegExp(`/v1/transfer/${transferId}$`))
    return new Response(JSON.stringify({
      destinationDomain: 26,
      status: 'finalized',
      transactionHash: txHash,
      destinationAddress: recipient,
      amount: '0.001001',
      token: 'USDC',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  process.env.X402_INVOICE_DB = join(directory, 'invoices.json')
  process.env.CIRCLE_GATEWAY_BASE_URL = 'https://gateway.test'
  process.env.X402_RECIPIENT_ADDRESS = recipient

  try {
    const { createX402Invoice, markUnifiedBalanceSpendSubmitted, reconcileX402Invoice } = await import('../src/middleware/x402Middleware.mjs')
    const invoice = createX402Invoice({ resource: '/api/test', amount: '0.001' })
    markUnifiedBalanceSpendSubmitted(invoice.invoiceId, { txHash, transferId })
    const settled = await reconcileX402Invoice(invoice.invoiceId)
    assert.equal(settled.status, 'paid')
    assert.equal(settled.txHash, txHash)
    assert.equal(settled.reconciledBy, 'circle-gateway-finalized-transfer')
  } finally {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})

test('Gateway transfer with a mismatched amount does not settle an x402 invoice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arcox-x402-'))
  const txHash = `0x${'56'.repeat(32)}`
  const transferId = '12345678-1234-4234-8234-123456789abc'
  const recipient = `0x${'34'.repeat(20)}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    destinationDomain: 26,
    status: 'finalized',
    transactionHash: txHash,
    destinationAddress: recipient,
    amount: '0.009999',
    token: 'USDC',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  process.env.X402_INVOICE_DB = join(directory, 'invoices.json')
  process.env.CIRCLE_GATEWAY_BASE_URL = 'https://gateway.test'
  process.env.X402_RECIPIENT_ADDRESS = recipient

  try {
    const { createX402Invoice, markUnifiedBalanceSpendSubmitted, reconcileX402Invoice } = await import('../src/middleware/x402Middleware.mjs')
    const invoice = createX402Invoice({ resource: '/api/test', amount: '0.001' })
    markUnifiedBalanceSpendSubmitted(invoice.invoiceId, { txHash, transferId })
    const settled = await reconcileX402Invoice(invoice.invoiceId)
    assert.notEqual(settled.status, 'paid')
    assert.notEqual(settled.txHash, txHash)
  } finally {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})
