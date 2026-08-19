import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.env.SUPABASE_BACKFILL_CONFIRM !== 'APPLY') {
  throw new Error('Refusing to write: set SUPABASE_BACKFILL_CONFIRM=APPLY explicitly.')
}

const root = resolve(new URL('..', import.meta.url).pathname)
const client = createClient(String(process.env.SUPABASE_URL || ''), String(process.env.SUPABASE_SERVICE_ROLE_KEY || ''), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const OWNER_RE = /^0x[a-f0-9]{40}$/i

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(resolve(root, file), 'utf8')) } catch { return fallback }
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function iso(value, fallback = new Date().toISOString()) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : fallback
}

function stableUuid(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex')
  const bytes = hex.slice(0, 32).split('')
  bytes[12] = '4'
  bytes[16] = ['8', '9', 'a', 'b'][parseInt(bytes[16], 16) % 4]
  const value = bytes.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function chunks(rows, size = 100) {
  const result = []
  for (let i = 0; i < rows.length; i += size) result.push(rows.slice(i, i + size))
  return result
}

function transactionRows() {
  const db = readJson('tx-history-db.json', {})
  const rows = Object.entries(db).flatMap(([owner, records]) => (Array.isArray(records) ? records : []).map(record => ({ ...record, owner: record.owner || owner })))
  const counts = new Map()
  for (const row of rows) counts.set(String(row.id || ''), (counts.get(String(row.id || '')) || 0) + 1)
  const seen = new Map()
  return rows.map(row => {
    const legacyId = String(row.id || '')
    const owner = String(row.owner || '').toLowerCase()
    const occurrence = (seen.set(`${legacyId}:${owner}`, (seen.get(`${legacyId}:${owner}`) || 0) + 1).get(`${legacyId}:${owner}`))
    // IDs in the legacy store were only unique per owner. Preserve every
    // collision instead of letting the second owner's history overwrite the
    // first one in the Supabase primary key.
    const id = counts.get(legacyId) > 1
      ? `${legacyId}:${owner}${occurrence > 1 ? `:${occurrence}` : ''}`
      : legacyId
    return { ...row, legacyId, id }
  })
}

function invoiceRows() {
  return Object.values(readJson('invoices-db.json', {})).filter(row => row && typeof row === 'object')
}

function webhookRows() {
  return Object.values(readJson('webhook-events-db.json', {})).filter(row => row && typeof row === 'object')
}

function x402Rows() {
  const value = readJson('x402-invoices-db.json', [])
  return (Array.isArray(value) ? value : Object.values(value || {})).filter(row => row && typeof row === 'object')
}

function aiUsageRows() {
  const value = readJson('ai-router-db.json', {})
  return Array.isArray(value.usageLogs) ? value.usageLogs : []
}

function transactionPayload(row) {
  return {
    id: row.id,
    owner_address: String(row.owner || '').toLowerCase(),
    action: String(row.action || 'send'),
    source: String(row.source || 'web-ui'),
    wallet_source: String(row.walletSource || ''),
    from_chain: String(row.from || ''),
    to_chain: String(row.to || ''),
    amount: String(row.amount || ''),
    token: String(row.token || 'USDC'),
    status: String(row.status || 'success'),
    tx_hash: String(row.tx || row.txHash || ''),
    explorer_url: String(row.explorer || row.explorerUrl || ''),
    approve_tx_hash: String(row.approveTx || ''),
    burn_tx_hash: String(row.burnTx || ''),
    burn_explorer_url: String(row.burnExplorerUrl || row.burnExplorer || ''),
    mint_tx_hash: String(row.mintTx || ''),
    mint_explorer_url: String(row.mintExplorerUrl || row.mintExplorer || ''),
    source_domain: Number.isFinite(Number(row.srcDomain)) ? Number(row.srcDomain) : null,
    destination_domain: Number.isFinite(Number(row.dstDomain)) ? Number(row.dstDomain) : null,
    note: String(row.note || ''),
    error: String(row.error || ''),
    metadata: jsonSafe({ ...row, legacyId: row.legacyId }),
    occurred_at: iso(row.ts ? Number(row.ts) : undefined),
    created_at: iso(row.ts ? Number(row.ts) : undefined),
    updated_at: new Date().toISOString(),
  }
}

function invoicePayload(row) {
  return {
    invoice_id: String(row.invoiceId),
    order_id: String(row.orderId || ''),
    merchant_address: String(row.merchantAddress || '').toLowerCase(),
    amount: String(row.amount || '0'),
    token: String(row.token || 'USDC'),
    network: String(row.network || 'arc-testnet'),
    memo: String(row.memo || ''),
    status: String(row.status || 'unpaid'),
    payment_url: String(row.paymentUrl || ''),
    payer_address: String(row.payerAddress || '').toLowerCase(),
    tx_hash: String(row.txHash || ''),
    paid_at: row.paidAt ? iso(row.paidAt) : null,
    expires_at: iso(row.expiresAt),
    timeline: jsonSafe(row.timeline || []),
    metadata: jsonSafe(row),
    created_at: iso(row.createdAt),
    updated_at: new Date().toISOString(),
  }
}

function invoiceEventPayloads(row) {
  return (Array.isArray(row.timeline) ? row.timeline : []).map((event, index) => ({
    id: stableUuid(`${row.invoiceId}:${event?.type || 'event'}:${event?.createdAt || index}:${event?.message || ''}:${event?.txHash || ''}`),
    invoice_id: String(row.invoiceId),
    event_type: String(event?.type || 'update'),
    message: String(event?.message || ''),
    tx_hash: String(event?.txHash || ''),
    metadata: jsonSafe(event),
    created_at: iso(event?.createdAt, iso(row.createdAt)),
  }))
}

function webhookPayload(row) {
  const provider = String(row.provider || '')
  const notificationId = String(row.notificationId || '')
  return {
    id: stableUuid(`${provider}:${notificationId}`),
    provider,
    notification_id: notificationId,
    event_type: String(row.eventType || ''),
    raw_payload: jsonSafe(row.rawPayload || {}),
    processed: Boolean(row.processed),
    matched: Boolean(row.matched),
    related_invoice_id: row.relatedInvoiceId ? String(row.relatedInvoiceId) : null,
    related_tx_hash: String(row.relatedTxHash || ''),
    related_user_operation_hash: String(row.relatedUserOpHash || row.relatedUserOperationHash || ''),
    wallet_address: String(row.walletAddress || '').toLowerCase(),
    status: String(row.status || ''),
    error: String(row.error || ''),
    received_at: iso(row.receivedAt || row.createdAt),
    processed_at: row.processedAt ? iso(row.processedAt) : null,
    created_at: iso(row.createdAt),
    updated_at: new Date().toISOString(),
  }
}

function aiUsagePayload(row) {
  return {
    request_id: String(row.requestId),
    owner_address: String(row.ownerAddress || '').toLowerCase(),
    agent_id: String(row.agentId || ''),
    api_key_id_hash: String(row.apiKeyIdHash || ''),
    sbt_token_id: String(row.sbtTokenId || ''),
    payment_id: String(row.paymentId || ''),
    tx_hash: String(row.txHash || ''),
    memo_id: String(row.memoId || ''),
    job_id: String(row.jobId || ''),
    model: String(row.model || ''),
    provider_used: String(row.providerUsed || ''),
    input_tokens: Math.max(0, Number(row.inputTokens || 0)),
    output_tokens: Math.max(0, Number(row.outputTokens || 0)),
    cost_usdc: String(row.cost || '0.000000'),
    fallback_count: Math.max(0, Number(row.fallbackCount || 0)),
    status: String(row.status || 'created'),
    latency_ms: Math.max(0, Number(row.latency || 0)),
    error: String(row.error || ''),
    metadata: jsonSafe(row),
    updated_at: new Date().toISOString(),
  }
}

function x402Payload(row) {
  return {
    invoice_id: String(row.invoiceId),
    payment_id: String(row.paymentId),
    owner_wallet: String(row.ownerWallet || '').toLowerCase(),
    status: String(row.status || ''),
    amount: String(row.amount || row.uniqueAmount || ''),
    network: String(row.network || ''),
    tx_hash: String(row.txHash || ''),
    payload: jsonSafe(row),
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  }
}

function validate(rows) {
  const errors = []
  for (const row of rows.transactions) if (!row.id || !OWNER_RE.test(String(row.owner || ''))) errors.push({ table: 'transaction_history', id: row.id || '', reason: 'invalid id/owner' })
  for (const row of rows.invoices) if (!row.invoiceId || !OWNER_RE.test(String(row.merchantAddress || ''))) errors.push({ table: 'payment_invoices', id: row.invoiceId || '', reason: 'invalid invoice/merchant' })
  for (const row of rows.webhooks) if (!row.provider || !row.notificationId) errors.push({ table: 'webhook_events', id: row.id || '', reason: 'missing provider/notificationId' })
  for (const row of rows.aiUsage) if (!row.requestId || !OWNER_RE.test(String(row.ownerAddress || ''))) errors.push({ table: 'ai_router_usage', id: row.requestId || '', reason: 'invalid request/owner' })
  for (const row of rows.x402) if (!row.invoiceId || !row.paymentId) errors.push({ table: 'x402_invoices', id: row.invoiceId || '', reason: 'missing invoice/payment id' })
  return errors
}

async function upsert(table, rows, conflict) {
  let written = 0
  for (const batch of chunks(rows)) {
    const { error } = await client.from(table).upsert(batch, { onConflict: conflict })
    if (error) throw new Error(`${table}: ${error.message}`)
    written += batch.length
  }
  return written
}

const transactions = transactionRows()
const invoices = invoiceRows()
const rows = {
  transactions,
  invoices,
  invoiceEvents: invoices.flatMap(invoiceEventPayloads),
  webhooks: webhookRows(),
  aiUsage: aiUsageRows(),
  x402: x402Rows(),
}
const errors = validate(rows)
if (errors.length) throw new Error(`Validation failed for ${errors.length} records: ${JSON.stringify(errors.slice(0, 10))}`)

const written = {}
written.transaction_history = await upsert('transaction_history', transactions.map(transactionPayload), 'id')
written.payment_invoices = await upsert('payment_invoices', invoices.map(invoicePayload), 'invoice_id')
written.invoice_events = await upsert('invoice_events', rows.invoiceEvents, 'id')
written.webhook_events = await upsert('webhook_events', rows.webhooks.map(webhookPayload), 'provider,notification_id')
written.ai_router_usage = await upsert('ai_router_usage', rows.aiUsage.map(aiUsagePayload), 'request_id')
written.x402_invoices = await upsert('x402_invoices', rows.x402.map(x402Payload), 'invoice_id')

console.log(JSON.stringify({
  mode: 'apply-idempotent-backfill',
  writesPerformed: Object.values(written).reduce((sum, count) => sum + count, 0),
  written,
  transactionCollisionPolicy: 'preserve-by-owner',
  sourceCounts: {
    transaction_history: transactions.length,
    payment_invoices: invoices.length,
    invoice_events: rows.invoiceEvents.length,
    webhook_events: rows.webhooks.length,
    ai_router_usage: rows.aiUsage.length,
    x402_invoices: rows.x402.length,
  },
}, null, 2))
