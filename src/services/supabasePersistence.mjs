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
const paymentInvoiceReadPrimary = enabled && String(process.env.SUPABASE_PAYMENT_INVOICE_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const invoiceEventsReadPrimary = enabled && String(process.env.SUPABASE_INVOICE_EVENTS_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const x402InvoiceReadPrimary = enabled && String(process.env.SUPABASE_X402_INVOICE_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const aiUsageReadPrimary = enabled && String(process.env.SUPABASE_AI_USAGE_READ_PRIMARY || 'true').toLowerCase() !== 'false'
// Session metadata is shadow-only for now. The local encrypted-key store remains
// the execution authority; this flag is intentionally not a read-primary switch.
const sessionMetadataReadPrimary = false
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
  invoiceReads: 0,
  invoiceMismatches: 0,
  invoiceFailures: 0,
  lastInvoiceError: '',
  invoiceEventReads: 0,
  invoiceEventFailures: 0,
  lastInvoiceEventError: '',
  x402InvoiceReads: 0,
  x402InvoiceFailures: 0,
  lastX402InvoiceError: '',
  aiUsageReads: 0,
  aiUsageFailures: 0,
  lastAiUsageError: '',
  webhookShadowReads: 0,
  webhookShadowMismatches: 0,
  webhookShadowFailures: 0,
  lastWebhookShadowError: '',
  sessionMetadataWrites: 0,
  sessionMetadataReads: 0,
  sessionMetadataMismatches: 0,
  sessionMetadataFailures: 0,
  lastSessionMetadataError: '',
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
    paymentInvoiceReadPrimary,
    shadowReads: stats.shadowReads,
    shadowMismatches: stats.shadowMismatches,
    shadowFailures: stats.shadowFailures,
    lastShadowError: stats.lastShadowError,
    invoiceReads: stats.invoiceReads,
    invoiceMismatches: stats.invoiceMismatches,
    invoiceFailures: stats.invoiceFailures,
    lastInvoiceError: stats.lastInvoiceError,
    invoiceEventsReadPrimary,
    invoiceEventReads: stats.invoiceEventReads,
    invoiceEventFailures: stats.invoiceEventFailures,
    lastInvoiceEventError: stats.lastInvoiceEventError,
    x402InvoiceReadPrimary,
    x402InvoiceReads: stats.x402InvoiceReads,
    x402InvoiceFailures: stats.x402InvoiceFailures,
    lastX402InvoiceError: stats.lastX402InvoiceError,
    aiUsageReadPrimary,
    aiUsageReads: stats.aiUsageReads,
    aiUsageFailures: stats.aiUsageFailures,
    lastAiUsageError: stats.lastAiUsageError,
    // Webhook idempotency remains JSON/file-lock primary. These counters only
    // describe post-write Supabase shadow verification.
    webhookReadPrimary: false,
    webhookShadowReads: stats.webhookShadowReads,
    webhookShadowMismatches: stats.webhookShadowMismatches,
    webhookShadowFailures: stats.webhookShadowFailures,
    lastWebhookShadowError: stats.lastWebhookShadowError,
    // Session metadata is intentionally shadow-only; encrypted delegate keys
    // and activation authority remain local until a separate cutover review.
    sessionMetadataReadPrimary,
    sessionMetadataWrites: stats.sessionMetadataWrites,
    sessionMetadataReads: stats.sessionMetadataReads,
    sessionMetadataMismatches: stats.sessionMetadataMismatches,
    sessionMetadataFailures: stats.sessionMetadataFailures,
    lastSessionMetadataError: stats.lastSessionMetadataError,
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

function invoiceComparable(invoice) {
  return {
    invoiceId: String(invoice?.invoiceId || invoice?.invoice_id || ''),
    merchantAddress: String(invoice?.merchantAddress || invoice?.merchant_address || '').toLowerCase(),
    amount: String(invoice?.amount || ''),
    status: String(invoice?.status || ''),
    txHash: String(invoice?.txHash || invoice?.tx_hash || ''),
  }
}

function paymentInvoiceFromSupabase(row) {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}
  return {
    ...metadata,
    invoiceId: String(row?.invoice_id || metadata.invoiceId || ''),
    orderId: String(row?.order_id || metadata.orderId || ''),
    merchantAddress: String(row?.merchant_address || metadata.merchantAddress || '').toLowerCase(),
    amount: String(row?.amount || metadata.amount || ''),
    token: String(row?.token || metadata.token || 'USDC'),
    network: String(row?.network || metadata.network || 'arc-testnet'),
    memo: String(row?.memo || metadata.memo || ''),
    status: String(row?.status || metadata.status || 'unpaid'),
    paymentUrl: String(row?.payment_url || metadata.paymentUrl || ''),
    payerAddress: String(row?.payer_address || metadata.payerAddress || '').toLowerCase(),
    txHash: String(row?.tx_hash || metadata.txHash || ''),
    paidAt: row?.paid_at || metadata.paidAt || null,
    expiresAt: row?.expires_at || metadata.expiresAt || null,
    timeline: Array.isArray(row?.timeline) ? row.timeline : (Array.isArray(metadata.timeline) ? metadata.timeline : []),
  }
}

export async function readPaymentInvoice(invoiceId, fallback = null) {
  const local = fallback && typeof fallback === 'object' ? fallback : null
  if (!enabled || !paymentInvoiceReadPrimary) return { invoice: local, source: 'json', compared: false }
  try {
    const { data, error } = await client.from('payment_invoices').select('*').eq('invoice_id', String(invoiceId || '')).maybeSingle()
    if (error) throw error
    if (!data) {
      if (local) {
        stats.invoiceReads++
        stats.invoiceMismatches++
        return { invoice: local, source: 'json-fallback', compared: true, mismatch: true }
      }
      return { invoice: null, source: 'supabase', compared: true, mismatch: false }
    }
    const remote = paymentInvoiceFromSupabase(data)
    if (invoiceEventsReadPrimary) {
      try {
        const { data: eventRows, error: eventError } = await client
          .from('invoice_events')
          .select('event_type,message,tx_hash,metadata,created_at')
          .eq('invoice_id', String(invoiceId || ''))
          .order('created_at', { ascending: true })
        if (eventError) throw eventError
        stats.invoiceEventReads++
        if (Array.isArray(eventRows) && eventRows.length > 0) {
          remote.timeline = eventRows.map(row => ({
            ...(row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
            type: String(row?.event_type || 'update'),
            message: String(row?.message || ''),
            ...(row?.tx_hash ? { txHash: String(row.tx_hash) } : {}),
            createdAt: row?.created_at || undefined,
          }))
        }
      } catch (eventError) {
        stats.invoiceEventFailures++
        stats.lastInvoiceEventError = String(eventError?.message || eventError).slice(0, 240)
      }
    }
    const mismatch = local ? JSON.stringify(invoiceComparable(local)) !== JSON.stringify(invoiceComparable(remote)) : false
    stats.invoiceReads++
    if (mismatch) stats.invoiceMismatches++
    return { invoice: paymentInvoiceReadPrimary ? remote : local, source: paymentInvoiceReadPrimary ? 'supabase' : 'json', compared: Boolean(local), mismatch }
  } catch (error) {
    stats.invoiceFailures++
    stats.lastInvoiceError = String(error?.message || error).slice(0, 240)
    return { invoice: local, source: local ? 'json-fallback' : 'json', compared: false, error: stats.lastInvoiceError }
  }
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

function webhookComparable(row) {
  return {
    provider: String(row?.provider || ''),
    notificationId: String(row?.notificationId || row?.notification_id || ''),
    eventType: String(row?.eventType || row?.event_type || ''),
    processed: Boolean(row?.processed),
    matched: Boolean(row?.matched),
    relatedInvoiceId: String(row?.relatedInvoiceId || row?.related_invoice_id || ''),
    relatedTxHash: String(row?.relatedTxHash || row?.related_tx_hash || ''),
    relatedUserOpHash: String(row?.relatedUserOpHash || row?.related_user_operation_hash || ''),
    walletAddress: String(row?.walletAddress || row?.wallet_address || '').toLowerCase(),
    status: String(row?.status || ''),
    error: String(row?.error || ''),
  }
}

function webhookFromSupabase(row) {
  return {
    provider: String(row?.provider || ''),
    notificationId: String(row?.notification_id || ''),
    eventType: String(row?.event_type || ''),
    processed: Boolean(row?.processed),
    matched: Boolean(row?.matched),
    relatedInvoiceId: String(row?.related_invoice_id || ''),
    relatedTxHash: String(row?.related_tx_hash || ''),
    relatedUserOpHash: String(row?.related_user_operation_hash || ''),
    walletAddress: String(row?.wallet_address || '').toLowerCase(),
    status: String(row?.status || ''),
    error: String(row?.error || ''),
    rawPayload: row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {},
    receivedAt: row?.received_at || undefined,
    processedAt: row?.processed_at || undefined,
    createdAt: row?.created_at || undefined,
  }
}

// Shadow verification deliberately waits for queued writes first. It never
// participates in webhook deduplication or processing decisions: JSON plus the
// file lock remains the only idempotency source until transactional cutover is
// designed and tested.
export async function shadowReadWebhookEvent(provider, notificationId, local = null) {
  const localEvent = local && typeof local === 'object' ? local : null
  if (!enabled || !provider || !notificationId) {
    return { event: localEvent, source: 'json', compared: false }
  }
  try {
    await flushSupabaseWrites()
    const { data, error } = await client
      .from('webhook_events')
      .select('*')
      .eq('provider', String(provider))
      .eq('notification_id', String(notificationId))
      .maybeSingle()
    if (error) throw error
    stats.webhookShadowReads++
    if (!data) {
      const mismatch = Boolean(localEvent)
      if (mismatch) stats.webhookShadowMismatches++
      return { event: localEvent, source: 'json', compared: Boolean(localEvent), mismatch }
    }
    const remoteEvent = webhookFromSupabase(data)
    const mismatch = localEvent
      ? JSON.stringify(webhookComparable(localEvent)) !== JSON.stringify(webhookComparable(remoteEvent))
      : false
    if (mismatch) stats.webhookShadowMismatches++
    return { event: localEvent, remoteEvent, source: 'json', compared: Boolean(localEvent), mismatch }
  } catch (error) {
    stats.webhookShadowFailures++
    stats.lastWebhookShadowError = String(error?.message || error).slice(0, 240)
    return { event: localEvent, source: 'json', compared: false, error: stats.lastWebhookShadowError }
  }
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

export async function readX402Invoice(invoiceId, fallback = null) {
  const local = fallback && typeof fallback === 'object' ? fallback : null
  if (!enabled || !x402InvoiceReadPrimary) return { invoice: local, source: 'json', compared: false }
  const lookup = String(invoiceId || '')
  if (!lookup) return { invoice: local, source: 'json', compared: false }
  try {
    let { data, error } = await client.from('x402_invoices').select('*').eq('invoice_id', lookup).maybeSingle()
    if (error) throw error
    if (!data) {
      const result = await client.from('x402_invoices').select('*').eq('payment_id', lookup).maybeSingle()
      data = result.data
      error = result.error
      if (error) throw error
    }
    if (!data) return { invoice: local, source: local ? 'json-fallback' : 'supabase', compared: Boolean(local), mismatch: Boolean(local) }
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {}
    const remote = {
      ...payload,
      invoiceId: String(data.invoice_id || payload.invoiceId || ''),
      paymentId: String(data.payment_id || payload.paymentId || ''),
      ownerWallet: String(data.owner_wallet || payload.ownerWallet || '').toLowerCase(),
      status: String(data.status || payload.status || ''),
      amount: String(data.amount || payload.amount || ''),
      network: String(data.network || payload.network || ''),
      txHash: String(data.tx_hash || payload.txHash || ''),
      updatedAt: data.updated_at || payload.updatedAt || data.created_at || payload.createdAt || '',
    }
    // The async dual-write may briefly leave Supabase behind a just-mutated
    // JSON record. Prefer the newer local state until the queued upsert lands.
    const localUpdated = Date.parse(String(local?.updatedAt || local?.createdAt || ''))
    const remoteUpdated = Date.parse(String(remote.updatedAt || ''))
    const useLocal = local && Number.isFinite(localUpdated) && Number.isFinite(remoteUpdated) && localUpdated > remoteUpdated
    stats.x402InvoiceReads++
    return { invoice: useLocal ? local : remote, source: useLocal ? 'json-newer' : 'supabase', compared: Boolean(local), mismatch: Boolean(local && !useLocal && JSON.stringify({ status: local.status, txHash: local.txHash || '' }) !== JSON.stringify({ status: remote.status, txHash: remote.txHash || '' })) }
  } catch (error) {
    stats.x402InvoiceFailures++
    stats.lastX402InvoiceError = String(error?.message || error).slice(0, 240)
    return { invoice: local, source: local ? 'json-fallback' : 'json', compared: false, error: stats.lastX402InvoiceError }
  }
}

export async function readAiUsage(ownerAddress, fallback = [], limit = 25) {
  const local = Array.isArray(fallback) ? fallback : []
  if (!enabled || !aiUsageReadPrimary || !isUsableOwner(ownerAddress)) return { usageLogs: local, source: 'json', compared: false }
  try {
    const { data, error } = await client
      .from('ai_router_usage')
      .select('*')
      .eq('owner_address', String(ownerAddress).toLowerCase())
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || 25, 1), 100))
    if (error) throw error
    if ((!Array.isArray(data) || data.length === 0) && local.length > 0) {
      stats.aiUsageReads++
      return { usageLogs: local, source: 'json-fallback', compared: true, mismatch: true }
    }
    const usageLogs = (Array.isArray(data) ? data : []).map(row => ({
      ...(row?.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
      requestId: String(row?.request_id || ''),
      ownerAddress: String(row?.owner_address || '').toLowerCase(),
      agentId: String(row?.agent_id || ''),
      apiKeyIdHash: String(row?.api_key_id_hash || ''),
      sbtTokenId: String(row?.sbt_token_id || ''),
      paymentId: String(row?.payment_id || ''),
      txHash: String(row?.tx_hash || ''),
      memoId: String(row?.memo_id || ''),
      jobId: String(row?.job_id || ''),
      model: String(row?.model || ''),
      providerUsed: String(row?.provider_used || ''),
      inputTokens: Number(row?.input_tokens || 0),
      outputTokens: Number(row?.output_tokens || 0),
      cost: String(row?.cost_usdc || '0.000000'),
      fallbackCount: Number(row?.fallback_count || 0),
      status: String(row?.status || 'created'),
      latency: Number(row?.latency_ms || 0),
      error: String(row?.error || ''),
      createdAt: row?.created_at || undefined,
    }))
    stats.aiUsageReads++
    return { usageLogs, source: 'supabase', compared: true, mismatch: JSON.stringify(local) !== JSON.stringify(usageLogs) }
  } catch (error) {
    stats.aiUsageFailures++
    stats.lastAiUsageError = String(error?.message || error).slice(0, 240)
    return { usageLogs: local, source: 'json-fallback', compared: false, error: stats.lastAiUsageError }
  }
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

function sessionMetadataComparable(row) {
  return {
    walletAddress: String(row?.wallet_address || row?.walletAddress || '').toLowerCase(),
    ownerAddresses: [...new Set((row?.owner_addresses || row?.ownerAddresses || []).map(value => String(value).toLowerCase()))].sort(),
    delegateAddress: String(row?.delegate_address || row?.delegateAddress || '').toLowerCase(),
    chain: String(row?.chain || ''),
    active: Boolean(row?.active),
    pendingAuthorization: Boolean(row?.pending_authorization ?? row?.pendingAuthorization),
    manualRevokePending: Boolean(row?.manual_revoke_pending ?? row?.manualRevokePending),
    revokeReason: row?.revoke_reason ?? row?.revokeReason ?? null,
    authorizationUserOpHash: String(row?.authorization_user_op_hash || row?.authorizationUserOpHash || '').toLowerCase(),
    authorizationUserOpHashes: jsonSafe(row?.authorization_user_op_hashes || row?.authorizationUserOpHashes || {}),
  }
}

export function buildSessionMetadataPayloads(data) {
  const users = data?.users && typeof data.users === 'object' ? data.users : {}
  const aliasesByWallet = new Map()
  for (const [owner, wallet] of Object.entries(data?.aliases || {})) {
    const normalizedOwner = String(owner || '').toLowerCase()
    const normalizedWallet = String(wallet || '').toLowerCase()
    if (!isUsableOwner(normalizedOwner) || !isUsableOwner(normalizedWallet)) continue
    if (!aliasesByWallet.has(normalizedWallet)) aliasesByWallet.set(normalizedWallet, new Set())
    aliasesByWallet.get(normalizedWallet).add(normalizedOwner)
  }
  const rowsByWallet = new Map()
  for (const [key, entry] of Object.entries(users)) {
    const walletAddress = String(entry?.walletAddress || key).toLowerCase()
    if (!isUsableOwner(walletAddress) || !entry) continue
    const ownerAddresses = [...(aliasesByWallet.get(walletAddress) || new Set())].sort()
    const candidate = {
      wallet_address: walletAddress,
      owner_addresses: ownerAddresses,
      delegate_address: String(entry.delegateAddress || '').toLowerCase(),
      chain: String(entry.chain || 'arc-testnet'),
      active: Boolean(entry.active),
      pending_authorization: Boolean(entry.pendingAuthorization),
      manual_revoke_pending: Boolean(entry.manualRevokePending),
      revoke_reason: entry.revokeReason ? String(entry.revokeReason) : null,
      authorization_user_op_hash: String(entry.authorizationUserOpHash || '').toLowerCase(),
      authorization_user_op_hashes: jsonSafe(entry.authorizationUserOpHashes || {}),
      authorization_attempt_at: toIso(entry.authorizationAttemptAt, null),
      last_authorized_chain_at: toIso(entry.lastAuthorizedChainAt, null),
      created_at: toIso(entry.createdAt),
      activated_at: toIso(entry.activatedAt, null),
      revoked_at: toIso(entry.revokedAt, null),
      last_used_at: toIso(entry.lastUsedAt, null),
      reconciled_at: toIso(entry.reconciledAt, null),
      reconciled_on_chain: Boolean(entry.reconciledOnChain),
      // Keep only non-secret diagnostic metadata. In particular, do not spread
      // entry because it may contain delegatePrivateKey.
      metadata: { ownerCount: ownerAddresses.length },
    }
    const previous = rowsByWallet.get(walletAddress)
    if (!previous) {
      rowsByWallet.set(walletAddress, candidate)
      continue
    }
    // A malformed legacy store can contain two records for one MSCA. Pick the
    // active record first, then the pending record, then the newest record; do
    // not let iteration order decide which delegate metadata reaches Supabase.
    const rank = row => [row.active, row.pending_authorization, Date.parse(row.created_at) || 0]
    const previousRank = rank(previous)
    const candidateRank = rank(candidate)
    if (candidateRank[0] > previousRank[0]
      || (candidateRank[0] === previousRank[0] && candidateRank[1] > previousRank[1])
      || (candidateRank[0] === previousRank[0] && candidateRank[1] === previousRank[1] && candidateRank[2] > previousRank[2])) {
      candidate.owner_addresses = [...new Set([...candidate.owner_addresses, ...previous.owner_addresses])].sort()
      candidate.metadata.ownerCount = candidate.owner_addresses.length
      rowsByWallet.set(walletAddress, candidate)
    } else {
      previous.owner_addresses = [...new Set([...previous.owner_addresses, ...candidate.owner_addresses])].sort()
      previous.metadata.ownerCount = previous.owner_addresses.length
    }
  }
  return [...rowsByWallet.values()]
}

export function scheduleSessionMetadataSnapshot(data) {
  if (!enabled) return
  for (const payload of buildSessionMetadataPayloads(data)) {
    queueWrite('session-metadata', payload.wallet_address, async () => {
      const { error } = await client.from('session_metadata').upsert(payload, { onConflict: 'wallet_address' })
      if (error) throw error
      stats.sessionMetadataWrites++
    })
  }
}

export async function shadowReadSessionMetadata(walletAddress, fallback = null) {
  const local = fallback && typeof fallback === 'object' ? fallback : null
  if (!enabled || !isUsableOwner(walletAddress)) return { metadata: local, source: 'json', compared: false }
  try {
    const { data, error } = await client.from('session_metadata').select('*').eq('wallet_address', String(walletAddress).toLowerCase()).maybeSingle()
    if (error) throw error
    stats.sessionMetadataReads++
    if (!data) return { metadata: local, source: 'json', compared: false, remoteMissing: true }
    const compared = !local || JSON.stringify(sessionMetadataComparable(data)) === JSON.stringify(sessionMetadataComparable(local))
    if (!compared) stats.sessionMetadataMismatches++
    return { metadata: local, source: 'json', compared, remote: data }
  } catch (error) {
    stats.sessionMetadataFailures++
    stats.lastSessionMetadataError = String(error?.message || error).slice(0, 240)
    return { metadata: local, source: 'json', compared: false, error: stats.lastSessionMetadataError }
  }
}

export async function reconcileDualWriteCounts() {
  if (!enabled) return { enabled: false, counts: {} }
  const tables = ['transaction_history', 'payment_invoices', 'invoice_events', 'webhook_events', 'ai_router_usage', 'x402_invoices', 'session_metadata']
  const counts = {}
  for (const table of tables) {
    const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
    if (error) throw error
    counts[table] = Number(count || 0)
  }
  return { enabled: true, counts, ...supabasePersistenceStatus() }
}

export { enabled as supabasePersistenceEnabled }
