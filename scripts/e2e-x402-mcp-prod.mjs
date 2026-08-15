// E2E: exercise every x402 MCP tool with the active MSCA session (real testnet tx).
// Flow: intel tool creates x402 invoice -> preview -> pay (real USDC transfer) ->
// status -> retry intel tool with paymentId (unlock).
import { createMcpServer } from '../src/services/mcpServer.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769' // active MSCA session
const TARGET = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e' // analysis target (user EOA)

const server = createMcpServer(WALLET)
const tools = server._registeredTools

async function call(name, params = {}) {
  const t = tools[name]
  if (!t) throw new Error(`tool not found: ${name}`)
  const res = await t.handler(params)
  const text = res.content?.[0]?.text || ''
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  console.log(`\n=== ${name} ===`)
  console.log(JSON.stringify(parsed, null, 1).slice(0, 2200))
  return parsed
}

// 1. Intel tool -> should create a payer-bound x402 invoice (HTTP 402 style response)
const q = await call('arcox_intel_get_address', { address: TARGET })
const invoice = q.x402 || q.invoice
if (!invoice) {
  console.log('\nNo x402 invoice created (paymentRequired response shape unexpected). Aborting before any tx.')
  process.exit(0)
}
console.log('\nInvoice: id=%s paymentId=%s amount=%s owner=%s recipient=%s resource=%s status=%s',
  invoice.invoiceId, invoice.paymentId, invoice.uniqueAmount, invoice.ownerWallet, invoice.recipient, invoice.resource, invoice.status)

// 2. Preview (no confirmation)
const preview = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId })
if (preview.status !== 'preview') {
  console.log('\nPreview did not reach preview state:', JSON.stringify(preview).slice(0, 500))
  process.exit(0)
}

// 3. Execute real payment with confirmation
const paid = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId, confirmed: true, confirmationText: 'yes' })
console.log('\nPayment outcome: status=%s executed=%s txHash=%s',
  paid.status, paid.executed, paid.txHash || paid.explorerUrl || '')

// 4. Invoice status
await call('arcox_x402_invoice_status', { invoiceId: invoice.invoiceId })

// 5. Retry intel tool with paymentId -> unlocked result
await call('arcox_intel_get_address', { address: TARGET, paymentId: invoice.paymentId })

console.log('\nDONE')
