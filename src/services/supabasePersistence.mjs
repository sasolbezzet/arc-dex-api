import { createClient } from '@supabase/supabase-js'
import { createHash, randomUUID } from 'node:crypto'

// Production defaults to the safe canary when server-only Supabase credentials
// exist. Set SUPABASE_PERSISTENCE_MODE=off for an explicit rollback.
const mode = String(process.env.SUPABASE_PERSISTENCE_MODE || (process.env.NODE_ENV === 'production' ? 'shadow' : 'off')).toLowerCase()
const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const configured = mode === 'shadow' || mode === 'canary'
const enabled = configured && /^https:\/\/[^\s]+\.supabase\.co$/.test(url) && serviceRoleKey.length > 20
const transactionHistoryReadPrimary = enabled && String(process.env.SUPABASE_TX_HISTORY_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const client = enabled
  ? createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null

const stats = globalThis.__arcoxSupabasePersistenceStats || {
  enabled,
  mode,
  queued: 0,
  succeeded: 0,
  failed: 0,
  lastError: '',
  lastSuccessAt: null,
  shadowReads: 0,
  shadowMismatches: 0,
  shadowFailures: 0,
  lastShadowError: '',
}
globalThis.__arcoxSupabasePersistenceStats = stats

const pendingOperations = new Map()
const activeDrains = new Map()

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === 'bigint' ? item.toString() : item))
}

function queueWrite(label, key, operation) {
  if (!enabled) return
  const dedupeKey = `${label}:${key}`
  // Keep the newest payload for a key. This prevents stale webhook/invoice
  // updates from overwriting a newer state while still preserving the latest
  // update that arrived during an in-flight request.
  pendingOperations.set(dedupeKey, { label, operation })
  stats.queued++
  if (activeDrains.has(dedupeKey)) return

  const drain = (async () => {
    while (pendingOperations.has(dedupeKey)) {
      const next = pendingOperations.get(dedupeKey)
      pendingOperations.delete(dedupeKey)
      try {
        await next.operation()
        stats.succeeded++
        stats.lastSuccessAt = new Date().toISOString()
      } catch (error) {
        stats.failed++
        stats.lastError = `${next.label}: ${String(error?.message || error).slice(0, 240)}`
        console.error(`[supabase:${next.label}] dual-write failed`, stats.lastError)
      }
    }
  })()
  activeDrains.set(dedupeKey, drain)
  void drain.finally(() => activeDrains.delete(dedupeKey))
}

function isUsableOwner(value) {
  return /^0x[a-f0-9]{40}$/i.test(String(value || ''))
}

function toIso(value, fallback = new Date().toISOString()) {
  if (!value) return fallback
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString()
}

function stableUuid(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex')
  const bytes = hex.slice(0, 32).split('')
  bytes[12] = '4'
  bytes[16] = ['8', '9', 'a', 'b'][parseInt(bytes[16], 16) % 4]
  const value = bytes.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function supabasePersistenceStatus() {
  return {
    enabled: Boolean(enabled),
    mode,
    configured,
    queued: stats.queued,
    succeeded: stats.succeeded,
    failed: stats.failed,
    lastError: stats.lastError,
    lastSuccessAt: stats.lastSuccessAt,
    transactionHistoryReadPrimary,
    shadowReads: stats.shadowReads,
    shadowMismatches: stats.shadowMismatches,
    shadowFailures: stats.shadowFailures,
    lastShadowError: stats.lastShadowError,
  }
}

export async function flushSupabaseWrites() {
  while (activeDrains.size > 0) await Promise.all([...activeDrains.values()])
  return supabasePersistenceStatus()
}

export async function probeSupabasePersistence() {
  if (!enabled) return { ok: false, enabled: false, mode, reason: 'SUPABASE_PERSISTENCE_MODE is not shadow/canary' }
  const { error } = await client.from('transaction_history').select('id').limit(1)
  if (error) throw error
  return { ok: true, ...supabasePersistenceStatus() }
}

function historyComparable(row) {
  return {
    id: String(row?.id || ''),
    owner: String(row?.owner || row?.owner_address || '').toLowerCase(),
    action: String(row?.action || ''),
    status: String(row?.status || ''),
    tx: String(row?.tx || row?.tx_hash || ''),
    burnTx: String(row?.burnTx || row?.burn_tx_hash || ''),
    mintTx: String(row?.mintTx || row?.mint_tx_hash || ''),
    amount: String(row?.amount || ''),
  }
}

function transactionHistoryFromSupabase(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  const occurredAt = Date.parse(String(row?.occurred_at || row?.created_at || ''))
  return {
    ...metadata,
    // Backfill preserves legacy IDs in metadata when it has to namespace a
    // collision by owner. Keep the public history shape compatible with JSON;
    // the Supabase row ID remains an internal storage key.
    id: String(metadata.legacyId || metadata.id || row?.id || ''),
    ts: Number.isFinite(occurredAt) ? occurredAt : Number(metadata.ts || Date.now()),
    owner: String(row?.owner_address || metadata.owner || '').toLowerCase(),
    action: String(row?.action || metadata.action || 'send'),
    source: String(row?.source || metadata.source || 'web-ui'),
    walletSource: String(row?.wallet_source || metadata.walletSource || ''),
    from: String(row?.from_chain || metadata.from || ''),
    to: String(row?.to_chain || metadata.to || ''),
    amount: String(row?.amount || metadata.amount || ''),
    token: String(row?.token || metadata.token || 'USDC'),
    status: String(row?.status || metadata.status || 'success'),
    tx: String(row?.tx_hash || metadata.tx || metadata.txHash || ''),
    explorer: String(row?.explorer_url || metadata.explorer || ''),
    approveTx: String(row?.approve_tx_hash || metadata.approveTx || ''),
    burnTx: String(row?.burn_tx_hash || metadata.burnTx || ''),
    burnExplorerUrl: String(row?.burn_explorer_url || metadata.burnExplorerUrl || ''),
    mintTx: String(row?.mint_tx_hash || metadata.mintTx || ''),
    mintExplorerUrl: String(row?.mint_explorer_url || metadata.mintExplorerUrl || ''),
    srcDomain: row?.source_domain ?? metadata.srcDomain,
    dstDomain: row?.destination_domain ?? metadata.dstDomain,
    note: String(row?.note || metadata.note || ''),
    error: String(row?.error || metadata.error || ''),
  }
}

export async function readTransactionHistory(ownerAddress, fallback = [], limit = 100) {
  const localRows = Array.isArray(fallback) ? fallback.slice(0, limit) : []
  if (!enabled || !isUsableOwner(ownerAddress)) return { items: localRows, source: 'json', compared: false }
  try {
    const { data, error } = await client
      .from('transaction_history')
      .select('*')
      .eq('owner_address', String(ownerAddress).toLowerCase())
      .order('occurred_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    const remoteRows = (data || []).map(transactionHistoryFromSupabase)
    const localById = new Map(localRows.map(row => [String(row?.id || ''), row]))
    const remoteById = new Map(remoteRows.map(row => [String(row?.id || ''), row]))
    const mismatch = localRows.length !== remoteRows.length
      || localRows.some(row => JSON.stringify(historyComparable(row)) !== JSON.stringify(historyComparable(remoteById.get(String(row?.id || '')))))
      || remoteRows.some(row => !localById.has(String(row?.id || '')))
    stats.shadowReads++
    if (mismatch) stats.shadowMismatches++
    return {
      items: transactionHistoryReadPrimary ? remoteRows : localRows,
      source: transactionHistoryReadPrimary ? 'supabase' : 'json',
      compared: true,
      mismatch,
    }
  } catch (error) {
    stats.shadowFailures++
    stats.lastShadowError = String(error?.message || error).slice(0, 240)
    if (transactionHistoryReadPrimary) {
      // Availability takes priority over the canary: preserve the old JSON
      // response if Supabase is temporarily unavailable.
      return { items: localRows, source: 'json-fallback', compared: false, error: stats.lastShadowError }
    }
    return { items: localRows, source: 'json', compared: false, error: stats.lastShadowError }
  }
}

export function scheduleTransactionHistoryUpsert(record) {
  if (!record?.id || !isUsableOwner(record.owner)) return
  const payload = {
    id: String(record.id),
    owner_address: String(record.owner).toLowerCase(),
    action: String(record.action || 'send'),
    source: String(record.source || 'web-ui'),
    wallet_source: String(record.walletSource || ''),
    from_chain: String(record.from || ''),
    to_chain: String(record.to || ''),
    amount: String(record.amount || ''),
    token: String(record.token || 'USDC'),
    status: String(record.status || 'success'),
    tx_hash: String(record.tx || ''),
    explorer_url: String(record.explorer || ''),
    approve_tx_hash: String(record.approveTx || ''),
    burn_tx_hash: String(record.burnTx || ''),
    burn_explorer_url: String(record.burnExplorerUrl || ''),
    mint_tx_hash: String(record.mintTx || ''),
    mint_explorer_url: String(record.mintExplorerUrl || ''),
    source_domain: Number.isFinite(Number(record.srcDomain)) ? Number(record.srcDomain) : null,
    destination_domain: Number.isFinite(Number(record.dstDomain)) ? Number(record.dstDomain) : null,
    note: String(record.note || ''),
    error: String(record.error || ''),
    metadata: jsonSafe(record),
    occurred_at: toIso(record.ts ? Number(record.ts) : undefined),
    created_at: toIso(record.ts ? Number(record.ts) : undefined),
    updated_at: new Date().toISOString(),
  }
  queueWrite('transaction-history', payload.id, async () => {
    const { error } = await client.from('transaction_history').upsert(payload, { onConflict: 'id' })
    if (error) throw error
  })
}

export function schedulePaymentInvoiceUpsert(invoice) {
  if (!invoice?.invoiceId || !isUsableOwner(invoice.merchantAddress)) return
  const payload = {
    invoice_id: String(invoice.invoiceId),
    order_id: String(invoice.orderId || ''),
    merchant_address: String(invoice.merchantAddress).toLowerCase(),
    amount: String(invoice.amount || '0'),
    token: String(invoice.token || 'USDC'),
    network: String(invoice.network || 'arc-testnet'),
    memo: String(invoice.memo || ''),
    status: String(invoice.status || 'unpaid'),
    payment_url: String(invoice.paymentUrl || ''),
    payer_address: String(invoice.payerAddress || '').toLowerCase(),
    tx_hash: String(invoice.txHash || ''),
    paid_at: invoice.paidAt ? toIso(invoice.paidAt) : null,
    expires_at: toIso(invoice.expiresAt),
    timeline: jsonSafe(invoice.timeline || []),
    metadata: jsonSafe(invoice),
    created_at: toIso(invoice.createdAt),
    updated_at: new Date().toISOString(),
  }
  const timelineEvents = (Array.isArray(invoice.timeline) ? invoice.timeline : []).map((event, index) => ({
    id: stableUuid(`${payload.invoice_id}:${event?.type || 'event'}:${event?.createdAt || index}:${event?.message || ''}:${event?.txHash || ''}`),
    invoice_id: payload.invoice_id,
    event_type: String(event?.type || 'update'),
    message: String(event?.message || ''),
    tx_hash: String(event?.txHash || ''),
    metadata: jsonSafe(event),
    created_at: toIso(event?.createdAt, payload.created_at),
  }))
  queueWrite('payment-invoice', payload.invoice_id, async () => {
    const { error } = await client.from('payment_invoices').upsert(payload, { onConflict: 'invoice_id' })
    if (error) throw error
    if (timelineEvents.length > 0) {
      const { error: eventError } = await client.from('invoice_events').upsert(timelineEvents, { onConflict: 'id' })
      if (eventError) throw eventError
    }
  })
}

export function scheduleWebhookEventUpsert(event) {
  if (!event?.provider || !event?.notificationId) return
  const payload = {
    id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(event.id || '')) ? event.id : randomUUID(),
    provider: String(event.provider),
    notification_id: String(event.notificationId),
    event_type: String(event.eventType || ''),
    raw_payload: jsonSafe(event.rawPayload || {}),
    processed: Boolean(event.processed),
    matched: Boolean(event.matched),
    related_invoice_id: event.relatedInvoiceId ? String(event.relatedInvoiceId) : null,
    related_tx_hash: String(event.relatedTxHash || ''),
    related_user_operation_hash: String(event.relatedUserOpHash || ''),
    wallet_address: String(event.walletAddress || '').toLowerCase(),
    status: String(event.status || ''),
    error: String(event.error || ''),
    received_at: toIso(event.receivedAt || event.createdAt),
    processed_at: event.processedAt ? toIso(event.processedAt) : null,
    created_at: toIso(event.createdAt),
    updated_at: new Date().toISOString(),
  }
  queueWrite('webhook-event', `${payload.provider}:${payload.notification_id}`, async () => {
    const { error } = await client.from('webhook_events').upsert(payload, { onConflict: 'provider,notification_id' })
    if (error) throw error
  })
}

export function scheduleAiUsageUpsert(entry) {
  if (!entry?.requestId || !isUsableOwner(entry.ownerAddress)) return
  const payload = {
    request_id: String(entry.requestId),
    owner_address: String(entry.ownerAddress).toLowerCase(),
    agent_id: String(entry.agentId || ''),
    api_key_id_hash: String(entry.apiKeyIdHash || ''),
    sbt_token_id: String(entry.sbtTokenId || ''),
    payment_id: String(entry.paymentId || ''),
    tx_hash: String(entry.txHash || ''),
    memo_id: String(entry.memoId || ''),
    job_id: String(entry.jobId || ''),
    model: String(entry.model || ''),
    provider_used: String(entry.providerUsed || ''),
    input_tokens: Math.max(0, Number(entry.inputTokens || 0)),
    output_tokens: Math.max(0, Number(entry.outputTokens || 0)),
    cost_usdc: String(entry.cost || '0.000000'),
    fallback_count: Math.max(0, Number(entry.fallbackCount || 0)),
    status: String(entry.status || 'created'),
    latency_ms: Math.max(0, Number(entry.latency || 0)),
    error: String(entry.error || ''),
    metadata: jsonSafe(entry),
    updated_at: new Date().toISOString(),
  }
  queueWrite('ai-usage', payload.request_id, async () => {
    const { error } = await client.from('ai_router_usage').upsert(payload, { onConflict: 'request_id' })
    if (error) throw error
  })
}

export function scheduleX402InvoiceUpsert(invoice) {
  if (!invoice?.invoiceId || !invoice?.paymentId) return
  const payload = {
    invoice_id: String(invoice.invoiceId),
    payment_id: String(invoice.paymentId),
    owner_wallet: String(invoice.ownerWallet || '').toLowerCase(),
    status: String(invoice.status || ''),
    amount: String(invoice.amount || invoice.uniqueAmount || ''),
    network: String(invoice.network || ''),
    tx_hash: String(invoice.txHash || ''),
    payload: jsonSafe(invoice),
    created_at: toIso(invoice.createdAt),
    updated_at: toIso(invoice.updatedAt),
  }
  queueWrite('x402-invoice', payload.invoice_id, async () => {
    const { error } = await client.from('x402_invoices').upsert(payload, { onConflict: 'invoice_id' })
    if (error) throw error
  })
}

export async function reconcileDualWriteCounts() {
  if (!enabled) return { enabled: false, counts: {} }
  const tables = ['transaction_history', 'payment_invoices', 'invoice_events', 'webhook_events', 'ai_router_usage', 'x402_invoices']
  const counts = {}
  for (const table of tables) {
    const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
    if (error) throw error
    counts[table] = Number(count || 0)
  }
  return { enabled: true, counts, ...supabasePersistenceStatus() }
}

export { enabled as supabasePersistenceEnabled }
