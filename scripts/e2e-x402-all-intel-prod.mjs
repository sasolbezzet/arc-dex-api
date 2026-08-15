// E2E: remaining intel x402 tools (get_tx, get_token, search, get_entity, get_contract).
// Each: intel tool -> x402 invoice -> preview -> pay (real tx) -> status -> retry with paymentId.
import { createMcpServer } from '../src/services/mcpServer.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769' // active MSCA session
const TARGET_EOA = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'
const TX_HASH = '0xf0c0b43183fa0632d77a7145452851f4faccde3e7e953110597b42822d87d7f7'

const server = createMcpServer(WALLET)
const tools = server._registeredTools

async function call(name, params = {}) {
  const res = await tools[name].handler(params)
  const text = res.content?.[0]?.text || ''
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return parsed
}

function summarize(parsed) {
  const s = { ...parsed }
  if (s.unlockedResult && typeof s.unlockedResult === 'object') s.unlockedResult = { ok: s.unlockedResult.ok, mode: s.unlockedResult.mode, hasData: Boolean(s.unlockedResult.data) }
  if (s.data && typeof s.data === 'object' && !Array.isArray(s.data)) s.data = { hasData: true, keys: Object.keys(s.data).slice(0, 8) }
  if (s.result && typeof s.result === 'object' && s.result.data && typeof s.result.data === 'object') s.result = { hasData: true, keys: Object.keys(s.result.data).slice(0, 8) }
  if (s.invoice && typeof s.invoice === 'object') s.invoice = { invoiceId: s.invoice.invoiceId, paymentId: s.invoice.paymentId, status: s.invoice.status, uniqueAmount: s.invoice.uniqueAmount, resource: s.invoice.resource, txHash: s.invoice.txHash }
  return s
}

const cases = [
  { name: 'arcox_intel_get_tx', params: { hash: TX_HASH }, label: 'get_tx' },
  { name: 'arcox_intel_get_token', params: { id: 'BTC' }, label: 'get_token(BTC)' },
  { name: 'arcox_intel_search', params: { query: TARGET_EOA }, label: 'search' },
  { name: 'arcox_intel_get_entity', params: { entity: 'circle' }, label: 'get_entity(circle)' },
  { name: 'arcox_intel_get_contract', params: { chain: 'ethereum', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }, label: 'get_contract(USDC)' },
]

for (const c of cases) {
  console.log(`\n########## ${c.label} ##########`)
  const first = await call(c.name, c.params)
  const invoice = first.x402 || first.invoice
  if (!invoice) {
    console.log(c.label, '-> no invoice. Response:', JSON.stringify(summarize(first)).slice(0, 400))
    continue
  }
  console.log(c.label, '-> invoice', invoice.invoiceId, invoice.uniqueAmount, 'USDC resource:', invoice.resource)
  const preview = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId })
  console.log(c.label, '-> preview:', preview.status, preview.amount)
  const paid = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId, confirmed: true, confirmationText: 'yes' })
  console.log(c.label, '-> paid:', paid.status, 'tx:', paid.txHash || paid.explorerUrl || '')
  const status = await call('arcox_x402_invoice_status', { invoiceId: invoice.invoiceId })
  console.log(c.label, '-> status:', status.status || status.invoice?.status)
  const unlocked = await call(c.name, { ...c.params, paymentId: invoice.paymentId })
  console.log(c.label, '-> unlock:', JSON.stringify(summarize(unlocked)).slice(0, 500))
}

console.log('\nDONE')
