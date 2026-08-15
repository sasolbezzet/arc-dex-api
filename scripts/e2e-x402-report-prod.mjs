// E2E: arcox_intel_quote_wallet_report -> arcox_x402_pay_invoice (real tx) ->
// arcox_x402_invoice_status -> arcox_intel_execute_wallet_report (unlock).
import { createMcpServer } from '../src/services/mcpServer.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769' // active MSCA session
const TARGET = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

const server = createMcpServer(WALLET)
const tools = server._registeredTools

async function call(name, params = {}) {
  const res = await tools[name].handler(params)
  const text = res.content?.[0]?.text || ''
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  console.log(`\n=== ${name} ===`)
  // Summarize: drop the huge intel data payloads, keep the x402/payment parts.
  const summarized = { ...parsed }
  if (summarized.unlockedResult && typeof summarized.unlockedResult === 'object') summarized.unlockedResult = { ok: summarized.unlockedResult.ok, mode: summarized.unlockedResult.mode, hasData: Boolean(summarized.unlockedResult.data), keys: Object.keys(summarized.unlockedResult.data || {}) }
  if (summarized.data && typeof summarized.data === 'object') summarized.data = { hasData: true, keys: Object.keys(summarized.data).slice(0, 12) }
  if (summarized.result && typeof summarized.result === 'object' && summarized.result.data) summarized.result = { hasData: true, keys: Object.keys(summarized.result.data).slice(0, 12) }
  console.log(JSON.stringify(summarized, null, 1).slice(0, 2500))
  return parsed
}

// 1. Quote wallet report -> creates x402 invoice (0.05 USDC)
const q = await call('arcox_intel_quote_wallet_report', { address: TARGET })
const invoice = q.x402 || q.invoice || (q.paymentRequired && q.x402)
if (!invoice) {
  console.log('\nNo x402 invoice from quote. Output above shows why.')
  process.exit(0)
}
console.log('\nInvoice: id=%s paymentId=%s amount=%s recipient=%s resource=%s',
  invoice.invoiceId, invoice.paymentId, invoice.uniqueAmount, invoice.recipient, invoice.resource)

// 2. Preview
await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId })

// 3. Pay (real tx)
const paid = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId, confirmed: true, confirmationText: 'yes' })

// 4. Status
await call('arcox_x402_invoice_status', { invoiceId: invoice.invoiceId })

// 5. Execute report with paymentId -> unlocked
await call('arcox_intel_execute_wallet_report', { address: TARGET, paymentId: invoice.paymentId })

console.log('\nDONE')
