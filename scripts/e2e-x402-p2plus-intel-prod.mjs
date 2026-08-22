// E2E: P2+ read-only Arkham resources added in commit 02425a6.
// Tests: global transfers, swaps, hypercore markets, polymarket events,
// portfolio series, and market (arkm circulating) with real x402 payments.
import { createMcpServer } from '../src/services/mcpServer.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769' // active MSCA session
const TARGET_EOA = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

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
  { name: 'arcox_intel_get_global_transfers', params: { service: 'transfers', base: TARGET_EOA, chains: 'ethereum', limit: 5 }, label: 'global_transfers' },
  { name: 'arcox_intel_get_swaps', params: { base: TARGET_EOA, chains: 'ethereum', limit: 5 }, label: 'swaps' },
  { name: 'arcox_intel_get_hypercore', params: { service: 'markets' }, label: 'hypercore_markets' },
  { name: 'arcox_intel_get_polymarket', params: { service: 'events', active: true, limit: 5 }, label: 'polymarket_events' },
  { name: 'arcox_intel_get_portfolio_series', params: { address: TARGET_EOA, pricingId: 'ethereum', chains: 'ethereum' }, label: 'portfolio_series' },
  { name: 'arcox_intel_get_market', params: { service: 'arkm-circulating' }, label: 'arkm_circulating' },
]

let totalCost = 0
const results = []

for (const c of cases) {
  console.log(`\n########## ${c.label} ##########`)
  const first = await call(c.name, c.params)
  const invoice = first.x402 || first.invoice
  if (!invoice) {
    console.log(c.label, '-> no invoice. Response:', JSON.stringify(summarize(first)).slice(0, 400))
    results.push({ label: c.label, status: 'no_invoice' })
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
  const summary = summarize(unlocked)
  console.log(c.label, '-> unlock:', JSON.stringify(summary).slice(0, 500))
  totalCost += Number(invoice.uniqueAmount || 0)
  results.push({ label: c.label, status: 'ok', invoice: invoice.invoiceId, txHash: paid.txHash, readOnly: unlocked.readOnly })
}

console.log('\n========== SUMMARY ==========')
for (const r of results) {
  console.log(`${r.label}: ${r.status} ${r.invoice || ''} ${r.txHash || ''} readOnly=${r.readOnly}`)
}
console.log(`Total cost: ${totalCost.toFixed(6)} USDC`)
console.log(`Tests: ${results.filter(r => r.status === 'ok').length}/${results.length} passed`)
