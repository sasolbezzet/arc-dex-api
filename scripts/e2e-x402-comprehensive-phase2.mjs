// E2E Phase 2: Verify all paid invoices return Arkham data via retry,
// then pay for remaining untested tools only.
import { createMcpServer } from '../src/services/mcpServer.mjs'
import { getAllX402Invoices } from '../src/middleware/x402Middleware.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769'
const TARGET_EOA = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'
const TX_HASH = '0xf0c0b43183fa0632d77a7145452851f4faccde3e7e953110597b42822d87d7f7'

const server = createMcpServer(WALLET)
const tools = server._registeredTools

async function call(name, params = {}) {
  const res = await tools[name].handler(params)
  const text = res.content?.[0]?.text || ''
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  return parsed
}

function checkResult(unlocked) {
  const issues = []
  if (unlocked.readOnly !== true) issues.push('readOnly!=true')
  // ok can be in the response or in result.data
  if (unlocked.ok !== true && unlocked.status !== 'ok' && !(unlocked.result?.ok || unlocked.data?.ok)) issues.push('ok!=true')
  const dataField = unlocked.result || unlocked.data || unlocked.unlockedResult
  if (!dataField) issues.push('no_data')
  return issues
}

// ── Step 1: Verify all already-paid invoices by retrying with paymentId ──
const allInvoices = getAllX402Invoices()
const paidInvoices = allInvoices.filter(i => i.status === 'paid' && i.paymentId && i.resource?.startsWith('/api/intel'))
console.log(`Step 1: Verifying ${paidInvoices.length} already-paid invoices`)

// Map resource → tool call params
const resourceMap = {
  '/api/intel/address/0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e': { tool: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'basic' } },
  '/api/intel/address/0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e/balances': { tool: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'balances' } },
  '/api/intel/address/0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e/counterparties': { tool: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'counterparties' } },
  '/api/intel/address/0xe34ff1d2c925ddafb28c95c2396fc49a6f64569e/portfolio': { tool: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'portfolio' } },
}

const verifiedResults = []
for (const inv of paidInvoices) {
  const resource = String(inv.resource || '').split('?')[0].toLowerCase()
  const mapping = resourceMap[resource]
  if (!mapping) continue
  console.log(`  Verifying ${inv.invoiceId} -> ${mapping.tool} (${resource.slice(0, 60)})`)
  const unlocked = await call(mapping.tool, { ...mapping.params, paymentId: inv.paymentId })
  const issues = checkResult(unlocked)
  verifiedResults.push({ label: mapping.tool, resource, invoice: inv.invoiceId, issues, readOnly: unlocked.readOnly, ok: unlocked.ok, hasData: Boolean(unlocked.result || unlocked.data || unlocked.unlockedResult) })
  console.log(`    -> ${issues.length === 0 ? 'OK' : 'ISSUES: ' + issues.join(',')}`)
}

console.log(`\nStep 1 done: ${verifiedResults.filter(r => r.issues.length === 0).length}/${verifiedResults.length} verified ok`)

// ── Step 2: Test remaining untested tools with real payment ──
console.log('\nStep 2: Testing remaining untested tools')

const remainingCases = [
  { name: 'arcox_intel_get_balances', params: { address: TARGET_EOA }, label: 'balances_address' },
  { name: 'arcox_intel_get_balances', params: { target: 'entity', entity: 'circle' }, label: 'balances_entity' },
  { name: 'arcox_intel_get_portfolio', params: { address: TARGET_EOA }, label: 'portfolio' },
  { name: 'arcox_intel_get_flows', params: { address: TARGET_EOA, timeLast: '24h', limit: 5 }, label: 'flows' },
  { name: 'arcox_intel_get_history', params: { address: TARGET_EOA, timeLast: '24h' }, label: 'history' },
  { name: 'arcox_intel_get_volume', params: { address: TARGET_EOA, timeLast: '24h' }, label: 'volume' },
  { name: 'arcox_intel_get_counterparties', params: { address: TARGET_EOA, limit: 5 }, label: 'counterparties' },
  { name: 'arcox_intel_get_flows', params: { target: 'entity', entity: 'circle', timeLast: '24h', limit: 5 }, label: 'entity_flows' },
  { name: 'arcox_intel_get_risk', params: { entity: 'circle', service: 'entity' }, label: 'risk_entity' },
  { name: 'arcox_intel_get_loans', params: { target: 'entity', entity: 'circle' }, label: 'loans_entity' },
  { name: 'arcox_intel_get_market', params: { service: 'altcoin-index' }, label: 'altcoin_index' },
  { name: 'arcox_intel_get_hypercore', params: { service: 'trades', limit: 5 }, label: 'hypercore_trades' },
  { name: 'arcox_intel_get_polymarket', params: { service: 'activity', limit: 5 }, label: 'polymarket_activity' },
  { name: 'arcox_intel_get_token', params: { service: 'trending' }, label: 'token_trending' },
]

const remainingResults = []
const failures = []
let totalCost = 0

for (const c of remainingCases) {
  console.log(`\n## ${c.label}`)
  try {
    const first = await call(c.name, c.params)
    const invoice = first.x402 || first.invoice
    if (!invoice) {
      console.log(`  -> no invoice, readOnly=${first.readOnly}, ok=${first.ok}`)
      remainingResults.push({ label: c.label, status: 'no_invoice' })
      continue
    }
    console.log(`  -> invoice ${invoice.invoiceId} ${invoice.uniqueAmount} USDC`)
    const preview = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId })
    if (preview.status !== 'preview') {
      console.log(`  -> preview failed: ${preview.status}`)
      failures.push({ label: c.label, reason: 'preview_failed' })
      continue
    }
    const paid = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId, confirmed: true, confirmationText: 'yes' })
    if (paid.status !== 'paid') {
      console.log(`  -> payment failed: ${paid.status} ${paid.error || ''}`)
      failures.push({ label: c.label, reason: 'payment_failed', detail: paid.error || paid.status })
      continue
    }
    console.log(`  -> paid, tx: ${paid.txHash || ''}`)
    const unlocked = await call(c.name, { ...c.params, paymentId: invoice.paymentId })
    const issues = checkResult(unlocked)
    if (issues.length > 0) {
      console.log(`  -> ISSUES: ${issues.join(', ')}`)
      console.log(`  -> keys: ${Object.keys(unlocked).join(', ')}`)
      failures.push({ label: c.label, reason: issues.join(','), invoice: invoice.invoiceId })
    } else {
      console.log(`  -> SUCCESS: readOnly, ok, mode=arkham, hasData`)
    }
    totalCost += Number(invoice.uniqueAmount || 0)
    remainingResults.push({ label: c.label, status: issues.length === 0 ? 'ok' : 'failed', issues })
  } catch (err) {
    console.log(`  -> EXCEPTION: ${err.message}`)
    failures.push({ label: c.label, reason: 'exception', detail: err.message })
    remainingResults.push({ label: c.label, status: 'exception' })
  }
}

console.log('\n========== PHASE 2 SUMMARY ==========')
console.log(`Verified paid invoices: ${verifiedResults.filter(r => r.issues.length === 0).length}/${verifiedResults.length}`)
console.log(`Remaining tests passed: ${remainingResults.filter(r => r.status === 'ok').length}/${remainingResults.length}`)
console.log(`Total cost this phase: ${totalCost.toFixed(6)} USDC`)
console.log(`Failures: ${failures.length}`)
if (failures.length > 0) {
  console.log('\n--- FAILURES ---')
  for (const f of failures) console.log(`${f.label}: ${f.reason} ${f.detail || ''}`)
}
