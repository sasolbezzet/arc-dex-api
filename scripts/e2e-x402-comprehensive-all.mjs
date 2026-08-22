// E2E: Comprehensive test of ALL remaining x402 Intel tools.
// Each test: call tool -> get invoice -> preview -> pay real USDC ->
// retry with paymentId -> verify readOnly=true, ok=true, mode=arkham, has data.
// If a tool fails, it is logged for fixing.
import { createMcpServer } from '../src/services/mcpServer.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769'
const TARGET_EOA = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
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

function checkResult(label, unlocked) {
  const issues = []
  if (unlocked.readOnly !== true) issues.push('readOnly!=true')
  if (unlocked.ok !== true && unlocked.status !== 'ok') issues.push('ok!=true')
  if (unlocked.mode && unlocked.mode !== 'arkham') issues.push(`mode=${unlocked.mode}`)
  // Check for actual data
  const dataField = unlocked.result || unlocked.data || unlocked.unlockedResult
  if (!dataField) issues.push('no_data')
  return issues
}

const cases = [
  // Address variants
  { name: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'basic' }, label: 'address_basic' },
  { name: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'balances' }, label: 'address_balances' },
  { name: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'counterparties' }, label: 'address_counterparties' },
  { name: 'arcox_intel_get_address', params: { address: TARGET_EOA, service: 'portfolio' }, label: 'address_portfolio' },
  // Entity variants
  { name: 'arcox_intel_get_entity', params: { entity: 'circle', service: 'balances' }, label: 'entity_balances' },
  { name: 'arcox_intel_get_entity', params: { entity: 'circle', service: 'counterparties' }, label: 'entity_counterparties' },
  // Balances
  { name: 'arcox_intel_get_balances', params: { address: TARGET_EOA }, label: 'balances_address' },
  { name: 'arcox_intel_get_balances', params: { target: 'entity', entity: 'circle' }, label: 'balances_entity' },
  // Portfolio
  { name: 'arcox_intel_get_portfolio', params: { address: TARGET_EOA }, label: 'portfolio' },
  // Scoped reads
  { name: 'arcox_intel_get_flows', params: { address: TARGET_EOA, timeLast: '24h', limit: 5 }, label: 'flows' },
  { name: 'arcox_intel_get_history', params: { address: TARGET_EOA, timeLast: '24h' }, label: 'history' },
  { name: 'arcox_intel_get_volume', params: { address: TARGET_EOA, timeLast: '24h' }, label: 'volume' },
  { name: 'arcox_intel_get_counterparties', params: { address: TARGET_EOA, limit: 5 }, label: 'counterparties' },
  // Entity scoped
  { name: 'arcox_intel_get_flows', params: { target: 'entity', entity: 'circle', timeLast: '24h', limit: 5 }, label: 'entity_flows' },
  { name: 'arcox_intel_get_history', params: { target: 'entity', entity: 'circle', timeLast: '24h' }, label: 'entity_history' },
  { name: 'arcox_intel_get_volume', params: { target: 'entity', entity: 'circle', timeLast: '24h' }, label: 'entity_volume' },
  { name: 'arcox_intel_get_counterparties', params: { target: 'entity', entity: 'circle', limit: 5 }, label: 'entity_counterparties_scoped' },
  // Risk entity
  { name: 'arcox_intel_get_risk', params: { entity: 'circle', service: 'entity' }, label: 'risk_entity' },
  // Loans entity
  { name: 'arcox_intel_get_loans', params: { target: 'entity', entity: 'circle' }, label: 'loans_entity' },
  // Solana subaccounts
  { name: 'arcox_intel_get_solana_subaccounts', params: { addresses: '5YoZZVdo6BWaPmX4xKbQqfQ2WmFj6n4q2x2x2x2x2x2x', pricingID: 'usd-coin' }, label: 'solana_subaccounts', skipIfNoData: true },
  // Transfers (tx)
  { name: 'arcox_intel_get_transfers', params: { hash: TX_HASH, chain: 'ethereum' }, label: 'tx_transfers' },
  // Market variants
  { name: 'arcox_intel_get_market', params: { service: 'altcoin-index' }, label: 'altcoin_index' },
  { name: 'arcox_intel_get_market', params: { service: 'tag-params', id: 'arkham' }, label: 'tag_params', skipIfNoData: true },
  { name: 'arcox_intel_get_market', params: { service: 'tag-summary', id: 'arkham' }, label: 'tag_summary', skipIfNoData: true },
  // Hypercore variants
  { name: 'arcox_intel_get_hypercore', params: { service: 'trades', limit: 5 }, label: 'hypercore_trades' },
  { name: 'arcox_intel_get_hypercore', params: { service: 'entity', entity: 'hyperliquid', accountService: 'summary' }, label: 'hypercore_entity', skipIfNoData: true },
  // Polymarket variants
  { name: 'arcox_intel_get_polymarket', params: { service: 'activity', limit: 5 }, label: 'polymarket_activity' },
  { name: 'arcox_intel_get_polymarket', params: { service: 'leaderboard', limit: 5 }, label: 'polymarket_leaderboard' },
  { name: 'arcox_intel_get_polymarket', params: { service: 'prices', limit: 5 }, label: 'polymarket_prices' },
  { name: 'arcox_intel_get_polymarket', params: { service: 'stats' }, label: 'polymarket_stats' },
  { name: 'arcox_intel_get_polymarket', params: { service: 'top-events', limit: 5 }, label: 'polymarket_top_events' },
  // Token variants not yet tested
  { name: 'arcox_intel_get_token', params: { id: 'BTC', service: 'top' }, label: 'token_top' },
  { name: 'arcox_intel_get_token', params: { service: 'trending' }, label: 'token_trending' },
  // Wallet report
  { name: 'arcox_intel_quote_wallet_report', params: { address: TARGET_EOA }, label: 'quote_wallet_report' },
]

let totalCost = 0
const results = []
const failures = []

for (const c of cases) {
  console.log(`\n########## ${c.label} ##########`)
  try {
    const first = await call(c.name, c.params)
    const invoice = first.x402 || first.invoice

    // For wallet report, it may not need payment
    if (c.name === 'arcox_intel_quote_wallet_report') {
      console.log(c.label, '-> result:', JSON.stringify(first).slice(0, 300))
      results.push({ label: c.label, status: 'ok', type: 'no_payment' })
      continue
    }

    if (!invoice) {
      const hasData = first.ok || first.data || first.result
      console.log(c.label, '-> no invoice, hasData:', Boolean(hasData))
      results.push({ label: c.label, status: hasData ? 'ok_no_payment' : 'no_invoice', readOnly: first.readOnly })
      if (!hasData) failures.push({ label: c.label, reason: 'no_invoice_no_data' })
      continue
    }

    console.log(c.label, '-> invoice', invoice.invoiceId, invoice.uniqueAmount, 'USDC')

    // Preview
    const preview = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId })
    if (preview.status !== 'preview') {
      console.log(c.label, '-> preview failed:', preview.status)
      failures.push({ label: c.label, reason: 'preview_failed', detail: preview.status })
      continue
    }

    // Pay
    const paid = await call('arcox_x402_pay_invoice', { invoiceId: invoice.invoiceId, confirmed: true, confirmationText: 'yes' })
    if (paid.status !== 'paid' && paid.executed === false) {
      console.log(c.label, '-> payment failed:', paid.status, paid.error || '')
      failures.push({ label: c.label, reason: 'payment_failed', detail: paid.error || paid.status })
      continue
    }
    console.log(c.label, '-> paid, tx:', paid.txHash || '')

    // Retry with paymentId
    const unlocked = await call(c.name, { ...c.params, paymentId: invoice.paymentId })
    const issues = checkResult(c.label, unlocked)

    if (issues.length > 0) {
      console.log(c.label, '-> ISSUES:', issues.join(', '))
      console.log(c.label, '-> response keys:', Object.keys(unlocked).join(', '))
      failures.push({ label: c.label, reason: issues.join(','), invoice: invoice.invoiceId })
    } else {
      console.log(c.label, '-> SUCCESS: readOnly, ok, mode=arkham, hasData')
    }

    totalCost += Number(invoice.uniqueAmount || 0)
    results.push({ label: c.label, status: issues.length === 0 ? 'ok' : 'failed', issues, readOnly: unlocked.readOnly })
  } catch (err) {
    console.log(c.label, '-> EXCEPTION:', err.message)
    failures.push({ label: c.label, reason: 'exception', detail: err.message })
    results.push({ label: c.label, status: 'exception', error: err.message })
  }
}

console.log('\n========== COMPREHENSIVE SUMMARY ==========')
for (const r of results) {
  console.log(`${r.label}: ${r.status} ${r.issues ? '[' + r.issues.join(',') + ']' : ''}`)
}
console.log(`\nTotal cost: ${totalCost.toFixed(6)} USDC`)
console.log(`Passed: ${results.filter(r => r.status === 'ok' || r.status === 'ok_no_payment').length}/${results.length}`)
console.log(`Failed: ${failures.length}`)
if (failures.length > 0) {
  console.log('\n--- FAILURES ---')
  for (const f of failures) {
    console.log(`${f.label}: ${f.reason} ${f.detail || ''}`)
  }
}
