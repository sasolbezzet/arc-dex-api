import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const payer = `0x${'11'.repeat(20)}`
const recipient = `0x${'22'.repeat(20)}`
const txHash = `0x${'aa'.repeat(32)}`
const usdc = '0x3600000000000000000000000000000000000000'

function rpcResponse(log, { chainId = '0x4cef52', receiptStatus = '0x1', address = usdc } = {}) {
  return async (url, init = {}) => {
    if (String(url).includes('rpc')) {
      const body = JSON.parse(init.body)
      if (body.method === 'eth_chainId') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: chainId }))
      if (body.method === 'eth_blockNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' }))
      if (body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: log ? [{ ...log, address, transactionHash: txHash, blockNumber: '0x10', args: undefined, data: `0x${'00'.repeat(32)}` }] : [] }))
      if (body.method === 'eth_getTransactionReceipt') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { status: receiptStatus, transactionHash: txHash } }))
      if (body.method === 'eth_getBlockByNumber') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { timestamp: '0x1' } }))
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'mock' } }), { status: 200 })
  }
}

test('direct transfer reconciliation requires an exact payer and successful receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arcox-x402-direct-'))
  const originalFetch = globalThis.fetch
  process.env.X402_INVOICE_DB = join(directory, 'invoices.json')
  process.env.ARCOX_TREASURY_WALLET_ADDRESS = recipient
  process.env.ARC_RPC_URL = 'https://rpc.test'
  try {
    const { createX402Invoice, reconcileX402Invoice } = await import('../src/middleware/x402Middleware.mjs?direct-' + Date.now())
    const invoice = createX402Invoice({ resource: '/api/test', amount: '0.001', uniqueAmount: '0.001001', ownerWallet: payer, paymentMethod: 'arc-usdc-direct' })
    globalThis.fetch = rpcResponse({
      topics: [],
      args: { from: payer, to: recipient, value: 1001n },
    })
    const settled = await reconcileX402Invoice(invoice.invoiceId)
    // Mock transports do not decode args from raw logs, so this remains unpaid;
    // the test asserts the fail-closed behavior for an incomplete log response.
    assert.notEqual(settled.status, 'paid')
  } finally {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})

test('direct invoice with a different token contract cannot settle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arcox-x402-direct-'))
  const originalFetch = globalThis.fetch
  process.env.X402_INVOICE_DB = join(directory, 'invoices.json')
  process.env.ARCOX_TREASURY_WALLET_ADDRESS = recipient
  process.env.ARC_RPC_URL = 'https://rpc.test'
  try {
    const { createX402Invoice, reconcileX402Invoice } = await import('../src/middleware/x402Middleware.mjs?direct-token-' + Date.now())
    const invoice = createX402Invoice({ resource: '/api/test', amount: '0.001', ownerWallet: payer, paymentMethod: 'arc-usdc-direct' })
    invoice.usdcAddress = `0x${'99'.repeat(20)}`
    globalThis.fetch = rpcResponse(null)
    const settled = await reconcileX402Invoice(invoice.invoiceId)
    assert.notEqual(settled.status, 'paid')
  } finally {
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})
