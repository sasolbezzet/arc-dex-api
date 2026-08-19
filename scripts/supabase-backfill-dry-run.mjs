import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const OWNER_RE = /^0x[a-f0-9]{40}$/i
const root = resolve(new URL('..', import.meta.url).pathname)
const reportPath = process.env.SUPABASE_BACKFILL_REPORT || `/tmp/arcox-supabase-backfill-${Date.now()}.json`
const client = createClient(String(process.env.SUPABASE_URL || ''), String(process.env.SUPABASE_SERVICE_ROLE_KEY || ''), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(resolve(root, file), 'utf8')) } catch { return fallback }
}

function stableUuid(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex')
  const bytes = hex.slice(0, 32).split('')
  bytes[12] = '4'
  bytes[16] = ['8', '9', 'a', 'b'][parseInt(bytes[16], 16) % 4]
  const value = bytes.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function asIso(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : ''
}

function keyFor(kind, record, collisionKeys = new Map()) {
  if (kind === 'transaction_history') {
    const legacyId = String(record.id || '')
    const owner = String(record.owner || '').toLowerCase()
    return collisionKeys.get(`${legacyId}:${owner}`) || legacyId
  }
  if (kind === 'payment_invoices') return String(record.invoiceId || record.invoice_id || '')
  if (kind === 'invoice_events') return String(record.id || '')
  if (kind === 'webhook_events') return `${record.provider || ''}:${record.notificationId || record.notification_id || ''}`
  if (kind === 'ai_router_usage') return String(record.requestId || record.request_id || '')
  if (kind === 'x402_invoices') return String(record.invoiceId || record.invoice_id || '')
  return ''
}

function sourceTransactionRows() {
  const db = readJson('tx-history-db.json', {})
  return Object.entries(db).flatMap(([owner, records]) => (Array.isArray(records) ? records : []).map(record => ({
    ...record,
    owner: record.owner || owner,
  })))
}

function sourceInvoiceRows() {
  return Object.values(readJson('invoices-db.json', {})).filter(record => record && typeof record === 'object')
}

function sourceWebhookRows() {
  return Object.values(readJson('webhook-events-db.json', {})).filter(record => record && typeof record === 'object')
}

function sourceX402Rows() {
  const value = readJson('x402-invoices-db.json', [])
  return (Array.isArray(value) ? value : Object.values(value || {})).filter(record => record && typeof record === 'object')
}

function sourceAiUsageRows() {
  const value = readJson('ai-router-db.json', {})
  return Array.isArray(value.usageLogs) ? value.usageLogs : []
}

function sourceInvoiceEventRows(invoices) {
  const rows = []
  for (const invoice of invoices) {
    for (const [index, event] of (Array.isArray(invoice.timeline) ? invoice.timeline : []).entries()) {
      rows.push({
        id: stableUuid(`${invoice.invoiceId}:${event?.type || 'event'}:${event?.createdAt || index}:${event?.message || ''}:${event?.txHash || ''}`),
        invoice_id: String(invoice.invoiceId || ''),
        event_type: String(event?.type || 'update'),
        message: String(event?.message || ''),
        tx_hash: String(event?.txHash || ''),
        created_at: asIso(event?.createdAt) || asIso(invoice.createdAt),
      })
    }
  }
  return rows
}

function buildSourceRows() {
  const invoices = sourceInvoiceRows()
  return {
    transaction_history: sourceTransactionRows(),
    payment_invoices: invoices,
    invoice_events: sourceInvoiceEventRows(invoices),
    webhook_events: sourceWebhookRows(),
    ai_router_usage: sourceAiUsageRows(),
    x402_invoices: sourceX402Rows(),
  }
}

function validateSource(kind, row) {
  const errors = []
  if (!keyFor(kind, row)) errors.push('missing_key')
  if (kind === 'transaction_history' && !OWNER_RE.test(String(row.owner || ''))) errors.push('invalid_owner')
  if (kind === 'payment_invoices' && !OWNER_RE.test(String(row.merchantAddress || ''))) errors.push('invalid_merchant')
  if (kind === 'ai_router_usage' && !OWNER_RE.test(String(row.ownerAddress || ''))) errors.push('invalid_owner')
  if (kind === 'x402_invoices' && row.ownerWallet && !OWNER_RE.test(String(row.ownerWallet))) errors.push('invalid_owner_wallet')
  return errors
}

function sourceComparable(kind, row) {
  if (kind === 'transaction_history') return {
    owner: String(row.owner || '').toLowerCase(),
    status: String(row.status || ''),
    tx: String(row.tx || row.txHash || ''),
    burnTx: String(row.burnTx || ''),
    mintTx: String(row.mintTx || ''),
  }
  if (kind === 'payment_invoices') return {
    owner: String(row.merchantAddress || '').toLowerCase(),
    status: String(row.status || ''),
    amount: String(row.amount || ''),
    tx: String(row.txHash || ''),
  }
  if (kind === 'invoice_events') return {
    invoiceId: String(row.invoice_id || ''),
    type: String(row.event_type || ''),
    message: String(row.message || ''),
    tx: String(row.tx_hash || ''),
  }
  if (kind === 'webhook_events') return {
    provider: String(row.provider || ''),
    status: String(row.status || ''),
    eventType: String(row.eventType || ''),
    processed: Boolean(row.processed),
    tx: String(row.relatedTxHash || ''),
  }
  if (kind === 'ai_router_usage') return {
    owner: String(row.ownerAddress || '').toLowerCase(),
    status: String(row.status || ''),
    cost: String(row.cost || '0.000000'),
  }
  return {
    owner: String(row.ownerWallet || '').toLowerCase(),
    status: String(row.status || ''),
    amount: String(row.amount || row.uniqueAmount || ''),
    tx: String(row.txHash || ''),
  }
}

function remoteComparable(kind, row) {
  if (kind === 'transaction_history') return {
    owner: String(row.owner_address || '').toLowerCase(),
    status: String(row.status || ''),
    tx: String(row.tx_hash || ''),
    burnTx: String(row.burn_tx_hash || ''),
    mintTx: String(row.mint_tx_hash || ''),
  }
  if (kind === 'payment_invoices') return {
    owner: String(row.merchant_address || '').toLowerCase(),
    status: String(row.status || ''),
    amount: String(row.amount || ''),
    tx: String(row.tx_hash || ''),
  }
  if (kind === 'invoice_events') return {
    invoiceId: String(row.invoice_id || ''),
    type: String(row.event_type || ''),
    message: String(row.message || ''),
    tx: String(row.tx_hash || ''),
  }
  if (kind === 'webhook_events') return {
    provider: String(row.provider || ''),
    status: String(row.status || ''),
    eventType: String(row.event_type || ''),
    processed: Boolean(row.processed),
    tx: String(row.related_tx_hash || ''),
  }
  if (kind === 'ai_router_usage') return {
    owner: String(row.owner_address || '').toLowerCase(),
    status: String(row.status || ''),
    cost: String(row.cost_usdc || '0.000000'),
  }
  return {
    owner: String(row.owner_wallet || '').toLowerCase(),
    status: String(row.status || ''),
    amount: String(row.amount || ''),
    tx: String(row.tx_hash || ''),
  }
}

async function fetchRemote(table) {
  const { data, error } = await client.from(table).select('*').range(0, 9999)
  if (error) throw error
  return data || []
}

function analyze(kind, sourceRows, remoteRows) {
  const sourceByKey = new Map()
  const remoteByKey = new Map()
  const invalid = []
  const sourceDuplicates = []
  const remoteDuplicates = []
  const collisionKeys = new Map()
  if (kind === 'transaction_history') {
    const grouped = new Map()
    for (const row of sourceRows) {
      const legacyId = String(row.id || '')
      const owner = String(row.owner || '').toLowerCase()
      const key = `${legacyId}:${owner}`
      if (!grouped.has(legacyId)) grouped.set(legacyId, [])
      grouped.get(legacyId).push(key)
    }
    for (const [legacyId, keys] of grouped) {
      if (keys.length > 1) for (const key of keys) collisionKeys.set(key, key)
    }
  }
  for (const row of sourceRows) {
    const errors = validateSource(kind, row)
    const key = keyFor(kind, row, collisionKeys)
    if (errors.length) invalid.push({ key, errors })
    if (sourceByKey.has(key)) sourceDuplicates.push(key)
    sourceByKey.set(key, row)
  }
  for (const row of remoteRows) {
    const key = keyFor(kind, row, collisionKeys)
    if (remoteByKey.has(key)) remoteDuplicates.push(key)
    remoteByKey.set(key, row)
  }
  const missingRemote = []
  const mismatches = []
  for (const [key, source] of sourceByKey) {
    const remote = remoteByKey.get(key)
    if (!remote) {
      missingRemote.push(key)
      continue
    }
    const expected = sourceComparable(kind, source)
    const actual = remoteComparable(kind, remote)
    if (JSON.stringify(expected) !== JSON.stringify(actual)) mismatches.push({ key, expected, actual })
  }
  const remoteOnly = [...remoteByKey.keys()].filter(key => !sourceByKey.has(key))
  return {
    sourceCount: sourceRows.length,
    sourceUniqueCount: sourceByKey.size,
    remoteCount: remoteRows.length,
    remoteUniqueCount: remoteByKey.size,
    invalidCount: invalid.length,
    invalid: invalid.slice(0, 25),
    legacyCollisionCount: collisionKeys.size,
    legacyCollisions: [...collisionKeys.values()].slice(0, 25),
    sourceDuplicateCount: sourceDuplicates.length,
    sourceDuplicates: sourceDuplicates.slice(0, 25),
    remoteDuplicateCount: remoteDuplicates.length,
    remoteDuplicates: remoteDuplicates.slice(0, 25),
    missingRemoteCount: missingRemote.length,
    missingRemote: missingRemote.slice(0, 25),
    remoteOnlyCount: remoteOnly.length,
    remoteOnly: remoteOnly.slice(0, 25),
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 25),
    proposedUpserts: missingRemote.length + mismatches.length,
  }
}

const source = buildSourceRows()
const remote = {}
for (const table of Object.keys(source)) remote[table] = await fetchRemote(table)
const analysis = {}
for (const table of Object.keys(source)) analysis[table] = analyze(table, source[table], remote[table])

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'dry-run-read-only',
  writesPerformed: 0,
  sourceFiles: ['tx-history-db.json', 'invoices-db.json', 'webhook-events-db.json', 'x402-invoices-db.json', 'ai-router-db.json'],
  analysis,
  totals: Object.values(analysis).reduce((total, item) => ({
    source: total.source + item.sourceCount,
    remote: total.remote + item.remoteCount,
    invalid: total.invalid + item.invalidCount,
    duplicates: total.duplicates + item.sourceDuplicateCount + item.remoteDuplicateCount,
    missingRemote: total.missingRemote + item.missingRemoteCount,
    remoteOnly: total.remoteOnly + item.remoteOnlyCount,
    mismatches: total.mismatches + item.mismatchCount,
    proposedUpserts: total.proposedUpserts + item.proposedUpserts,
  }), { source: 0, remote: 0, invalid: 0, duplicates: 0, missingRemote: 0, remoteOnly: 0, mismatches: 0, proposedUpserts: 0 }),
}

mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, `${JSON.stringify(jsonSafe(report), null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ reportPath, mode: report.mode, writesPerformed: 0, totals: report.totals, tables: analysis }, null, 2))
