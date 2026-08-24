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
// Session metadata reads are Supabase-primary with the local encrypted-key
// store as the execution authority. Reads merge remote metadata, but the
// local record always wins for activation state; when the local record is
// missing entirely, Supabase only provides a display-only recovery view that
// is never surfaced as active (without the local keys the session cannot
// sign). Roll back with SUPABASE_SESSION_METADATA_READ_PRIMARY=false.
const sessionMetadataReadPrimary = enabled && String(process.env.SUPABASE_SESSION_METADATA_READ_PRIMARY || 'true').toLowerCase() !== 'false'
// Financial card records and Agent Activity are read from Supabase when the
// migration is present, with JSON fallback during rollout or an outage. PAN,
// CVV, private keys, and bearer tokens are never sent to these tables.
const cardReadPrimary = enabled && String(process.env.SUPABASE_CARD_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const activityReadPrimary = enabled && String(process.env.SUPABASE_ACTIVITY_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const approvalReadPrimary = enabled && String(process.env.SUPABASE_APPROVAL_READ_PRIMARY || 'true').toLowerCase() !== 'false'
const financialSyncEnabled = enabled
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
  refundAuditLogWrites: 0,
  refundAuditLogReads: 0,
  refundAuditLogFailures: 0,
  lastRefundAuditLogError: '',
  activityWrites: 0,
  activityReads: 0,
  activityFailures: 0,
  lastActivityError: '',
  approvalReads: 0,
  approvalFailures: 0,
  lastApprovalError: '',
  approvalWrites: 0,
  cardAccountWrites: 0,
  cardRecordWrites: 0,
  cardTransactionWrites: 0,
  cardReads: 0,
  cardTransactionReads: 0,
  cardReadFailures: 0,
  lastCardReadError: '',
  treasuryEventWrites: 0,
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
    // Session metadata reads are Supabase-primary; the local encrypted-key
    // store remains the activation authority (local always wins, recovery
    // views are never active).
    sessionMetadataReadPrimary,
    activityReadPrimary,
    approvalReadPrimary,
    cardReadPrimary,
    financialSyncEnabled,
    activityWrites: stats.activityWrites,
    activityReads: stats.activityReads,
    activityFailures: stats.activityFailures,
    lastActivityError: stats.lastActivityError,
    approvalReads: stats.approvalReads,
    approvalFailures: stats.approvalFailures,
    lastApprovalError: stats.lastApprovalError,
    approvalWrites: stats.approvalWrites,
    cardAccountWrites: stats.cardAccountWrites,
    cardRecordWrites: stats.cardRecordWrites,
    cardTransactionWrites: stats.cardTransactionWrites,
    cardReads: stats.cardReads,
    cardTransactionReads: stats.cardTransactionReads,
    cardReadFailures: stats.cardReadFailures,
    lastCardReadError: stats.lastCardReadError,
    treasuryEventWrites: stats.treasuryEventWrites,
    sessionMetadataWrites: stats.sessionMetadataWrites,
    sessionMetadataReads: stats.sessionMetadataReads,
    sessionMetadataMismatches: stats.sessionMetadataMismatches,
    sessionMetadataFailures: stats.sessionMetadataFailures,
    lastSessionMetadataError: stats.lastSessionMetadataError,
    refundAuditLogWrites: stats.refundAuditLogWrites,
    refundAuditLogReads: stats.refundAuditLogReads,
    refundAuditLogFailures: stats.refundAuditLogFailures,
    lastRefundAuditLogError: stats.lastRefundAuditLogError,
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

function sessionMetadataFromSupabase(row) {
  return {
    walletAddress: String(row?.wallet_address || '').toLowerCase(),
    ownerAddresses: Array.isArray(row?.owner_addresses) ? [...new Set(row.owner_addresses.map(value => String(value).toLowerCase()))].sort() : [],
    delegateAddress: String(row?.delegate_address || '').toLowerCase(),
    chain: String(row?.chain || 'arc-testnet'),
    active: Boolean(row?.active),
    pendingAuthorization: Boolean(row?.pending_authorization ?? row?.pendingAuthorization),
    manualRevokePending: Boolean(row?.manual_revoke_pending ?? row?.manualRevokePending),
    revokeReason: row?.revoke_reason ?? row?.revokeReason ?? null,
    authorizationUserOpHash: String(row?.authorization_user_op_hash || row?.authorizationUserOpHash || '').toLowerCase(),
    authorizationUserOpHashes: row?.authorization_user_op_hashes && typeof row.authorization_user_op_hashes === 'object' ? row.authorization_user_op_hashes : {},
    createdAt: row?.created_at || undefined,
    activatedAt: row?.activated_at || undefined,
    revokedAt: row?.revoked_at || undefined,
    lastUsedAt: row?.last_used_at || undefined,
    updatedAt: row?.updated_at || undefined,
  }
}

/**
 * Pure merge for a Supabase-primary session metadata read.
 *
 * - When a local record exists, local fields win for every activation/signer
 *   field (active, delegateAddress, walletAddress, pendingAuthorization, ...)
 *   and remote only fills fields the local record does not carry.
 * - When only the remote record exists, the result is a display-only recovery
 *   view: active is forced false because without the local encrypted key
 *   store the session cannot sign anything.
 */
export function mergeSessionMetadata(remote, local = null) {
  if (!remote || typeof remote !== 'object') return local || null
  if (local && typeof local === 'object') {
    const localWins = ['walletAddress', 'delegateAddress', 'chain', 'active', 'pendingAuthorization', 'manualRevokePending', 'revokeReason', 'authorizationUserOpHash', 'statusReason', 'createdAt', 'activatedAt', 'lastUsedAt', 'stale', 'recovery']
    return {
      ...remote,
      ...Object.fromEntries(localWins.filter(key => local[key] !== undefined && local[key] !== null).map(key => [key, local[key]])),
      ownerAddresses: [...new Set([...(remote.ownerAddresses || []), ...(local.ownerAddresses || [])].map(value => String(value).toLowerCase()))].sort(),
    }
  }
  return { ...remote, active: false, stale: true, recovery: true }
}

/**
 * Supabase-primary session metadata read with local fallback. Local activation
 * state always wins; a remote-only result is a recovery view (never active).
 */
export async function readSessionMetadata(walletAddress, fallback = null) {
  const local = fallback && typeof fallback === 'object' ? fallback : null
  if (!enabled || !sessionMetadataReadPrimary || !isUsableOwner(walletAddress)) {
    return { metadata: local, source: local ? 'json' : 'none', compared: false }
  }
  try {
    const lookup = String(walletAddress).toLowerCase()
    const response = await Promise.race([
      client.from('session_metadata').select('*').eq('wallet_address', lookup).maybeSingle(),
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 5_000)),
    ])
    if (response?.timedOut) throw new Error('session metadata read timed out')
    const { data, error } = response
    if (error) throw error
    stats.sessionMetadataReads++
    if (!data) {
      return { metadata: local, source: local ? 'json-fallback' : 'json', compared: Boolean(local), remoteMissing: true }
    }
    const remote = sessionMetadataFromSupabase(data)
    const merged = mergeSessionMetadata(remote, local)
    const mismatch = Boolean(local) && JSON.stringify(sessionMetadataComparable(remote)) !== JSON.stringify(sessionMetadataComparable(local))
    if (mismatch) stats.sessionMetadataMismatches++
    return { metadata: merged, source: local ? 'supabase-merged' : 'supabase-recovery', compared: Boolean(local), mismatch, remote }
  } catch (error) {
    stats.sessionMetadataFailures++
    stats.lastSessionMetadataError = String(error?.message || error).slice(0, 240)
    return { metadata: local, source: local ? 'json-fallback' : 'json', compared: false, error: stats.lastSessionMetadataError }
  }
}

/**
 * Fire-and-forget write of one refund decision into public.refund_audit_log.
 * Idempotent per (invoiceId, action, at) via a stable UUID so worker rescans
 * never duplicate audit rows. Falls back silently to the in-memory log.
 */
export function scheduleRefundAuditLog(entry) {
  if (!enabled || !entry?.invoiceId || !entry?.action) return
  const payload = {
    id: stableUuid(`${entry.invoiceId}:${entry.action}:${entry.at || ''}`),
    invoice_id: String(entry.invoiceId),
    payment_id: String(entry.paymentId || ''),
    action: String(entry.action),
    amount_usdc: Number(entry.amount || 0) || 0,
    owner_wallet: String(entry.ownerWallet || '').toLowerCase(),
    service_status: String(entry.serviceStatus || ''),
    tx_hash: String(entry.txHash || ''),
    details: jsonSafe(entry),
    created_at: toIso(entry.at, null),
  }
  queueWrite('refund-audit', payload.id, async () => {
    const { error } = await client.from('refund_audit_log').upsert(payload, { onConflict: 'id' })
    if (error) throw error
    stats.refundAuditLogWrites++
  })
}

/**
 * Supabase-primary read of the refund audit log with the in-memory log as
 * fallback (including when the table has not been migrated yet).
 */
export async function readRefundAuditLog(options = {}, fallback = []) {
  const local = Array.isArray(fallback) ? fallback : []
  const filteredLocal = local
    .filter(entry => !options.invoiceId || String(entry.invoiceId || '') === String(options.invoiceId))
    .filter(entry => !options.ownerWallet || String(entry.ownerWallet || entry.invoiceId || '').toLowerCase() === String(options.ownerWallet).toLowerCase())
    .slice(0, Math.min(Math.max(Number(options.limit) || 200, 1), 500))
  if (!enabled) return { entries: filteredLocal, source: 'json', compared: false }
  try {
    let query = client.from('refund_audit_log').select('*')
    if (options.invoiceId) query = query.eq('invoice_id', String(options.invoiceId))
    if (options.ownerWallet) query = query.eq('owner_wallet', String(options.ownerWallet).toLowerCase())
    query = query.order('created_at', { ascending: false }).limit(Math.min(Math.max(Number(options.limit) || 200, 1), 500))
    const { data, error } = await query
    if (error) throw error
    stats.refundAuditLogReads++
    if (!Array.isArray(data) || data.length === 0) {
      if (filteredLocal.length > 0) stats.refundAuditLogFailures++ // surfaced as a mismatch-style fallback
      return { entries: filteredLocal, source: filteredLocal.length ? 'json-fallback' : 'json', compared: Boolean(filteredLocal.length), mismatch: Boolean(filteredLocal.length) }
    }
    const entries = data.map(row => ({
      ...(row?.details && typeof row.details === 'object' ? row.details : {}),
      invoiceId: String(row.invoice_id || ''),
      paymentId: String(row.payment_id || ''),
      action: String(row.action || ''),
      amount: String(row.amount_usdc ?? ''),
      ownerWallet: String(row.owner_wallet || ''),
      serviceStatus: String(row.service_status || ''),
      txHash: String(row.tx_hash || ''),
      at: row.created_at || row.details?.at || undefined,
    }))
    return { entries, source: 'supabase', compared: true, mismatch: JSON.stringify(filteredLocal.map(stripRefundComparable)) !== JSON.stringify(entries.map(stripRefundComparable)) }
  } catch (error) {
    stats.refundAuditLogFailures++
    stats.lastRefundAuditLogError = String(error?.message || error).slice(0, 240)
    return { entries: filteredLocal, source: filteredLocal.length ? 'json-fallback' : 'json', compared: false, error: stats.lastRefundAuditLogError }
  }
}

function stripRefundComparable(entry) {
  return { invoiceId: entry.invoiceId || '', action: entry.action || '', at: entry.at || '' }
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

function ownerAddress(value) {
  return String(value || '').toLowerCase()
}

function localActivityPayload(entry) {
  return {
    id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(entry?.id || '')) ? String(entry.id) : stableUuid(`${entry?.owner || ''}:${entry?.type || ''}:${entry?.ts || ''}:${JSON.stringify(entry?.data || {})}`),
    owner_address: ownerAddress(entry?.owner),
    activity_type: String(entry?.type || 'activity'),
    data: jsonSafe(entry?.data || {}),
    occurred_at: toIso(entry?.ts),
    created_at: toIso(entry?.ts),
  }
}

export function scheduleAgentActivityUpsert(entry) {
  const payload = localActivityPayload(entry)
  if (!enabled || !isUsableOwner(payload.owner_address)) return
  queueWrite('agent-activity', payload.id, async () => {
    const { error } = await client.from('agent_activity').upsert(payload, { onConflict: 'id' })
    if (error) throw error
    stats.activityWrites++
  })
}

export async function readAgentActivity(owner, fallback = [], limit = 5) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 5)
  // Callers normally pass listActivity(), which is already newest-first.
  const local = Array.isArray(fallback) ? fallback.slice(0, safeLimit) : []
  if (!enabled || !activityReadPrimary || !isUsableOwner(owner)) return { activity: local, source: 'json', compared: false }
  try {
    const { data, error } = await client.from('agent_activity').select('*').eq('owner_address', ownerAddress(owner)).order('occurred_at', { ascending: false }).limit(safeLimit)
    if (error) throw error
    const remoteActivity = (data || []).map(row => ({
      id: String(row?.id || ''),
      owner: ownerAddress(row?.owner_address),
      type: String(row?.activity_type || 'activity'),
      data: row?.data && typeof row.data === 'object' ? row.data : {},
      ts: Date.parse(String(row?.occurred_at || row?.created_at || '')) || Date.now(),
    }))
    // A queued local event can be newer than the remote read. Merge by ID so
    // the five-entry UI never hides a just-completed transaction during the
    // async dual-write window, while still recovering remote history after a
    // restart or local-file loss.
    const byId = new Map(remoteActivity.map(entry => [entry.id, entry]))
    for (const entry of local) byId.set(String(entry.id), entry)
    const activity = [...byId.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, safeLimit)
    stats.activityReads++
    if (activity.length === 0 && local.length > 0) return { activity: local, source: 'json-fallback', compared: true, mismatch: true }
    return { activity, source: local.length ? 'supabase-merged' : 'supabase', compared: true, mismatch: JSON.stringify(local) !== JSON.stringify(activity) }
  } catch (error) {
    stats.activityFailures++
    stats.lastActivityError = String(error?.message || error).slice(0, 240)
    return { activity: local, source: local.length ? 'json-fallback' : 'json', compared: false, error: stats.lastActivityError }
  }
}

function approvalFromSupabase(row) {
  const details = row?.details && typeof row.details === 'object' ? row.details : {}
  return {
    ...details,
    id: String(row?.id || ''),
    owner: ownerAddress(row?.owner_address),
    agent: String(row?.agent || ''),
    action: String(row?.action || ''),
    amount: String(row?.amount || ''),
    token: String(row?.token || 'USDC'),
    source: String(row?.source || ''),
    to: String(row?.destination || ''),
    status: String(row?.status || 'pending'),
    txHash: String(row?.tx_hash || ''),
    explorerUrl: String(row?.explorer_url || ''),
    error: String(row?.error || ''),
    details: JSON.stringify(details),
    createdAt: row?.created_at ? Date.parse(row.created_at) : Date.now(),
    approvedAt: row?.approved_at ? Date.parse(row.approved_at) : undefined,
    completedAt: row?.completed_at ? Date.parse(row.completed_at) : undefined,
    updatedAt: row?.updated_at ? Date.parse(row.updated_at) : undefined,
  }
}

export async function readAgentApprovals(owner, fallback = [], limit = 200) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500)
  const local = Array.isArray(fallback) ? fallback.filter(item => ownerAddress(item?.owner) === ownerAddress(owner)).slice(0, safeLimit) : []
  if (!enabled || !approvalReadPrimary || !isUsableOwner(owner)) return { approvals: local, source: 'json', compared: false }
  try {
    const { data, error } = await client.from('agent_approvals').select('*').eq('owner_address', ownerAddress(owner)).order('updated_at', { ascending: false }).limit(safeLimit)
    if (error) throw error
    const remote = (data || []).map(approvalFromSupabase)
    const byId = new Map(remote.map(item => [item.id, item]))
    // Local state is the synchronous execution authority. Prefer it during
    // the queued-write window, and use Supabase rows to recover after restart.
    for (const item of local) byId.set(String(item.id), item)
    const approvals = [...byId.values()].sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).slice(0, safeLimit)
    stats.approvalReads++
    if (approvals.length === 0 && local.length > 0) return { approvals: local, source: 'json-fallback', compared: true, mismatch: true }
    return { approvals, source: local.length ? 'supabase-merged' : 'supabase', compared: true, mismatch: remote.length !== local.length }
  } catch (error) {
    stats.approvalFailures++
    stats.lastApprovalError = String(error?.message || error).slice(0, 240)
    return { approvals: local, source: local.length ? 'json-fallback' : 'json', compared: false, error: stats.lastApprovalError }
  }
}

function approvalPayload(approval) {
  let details = {}
  try { details = typeof approval?.details === 'string' ? JSON.parse(approval.details || '{}') : (approval?.details || {}) } catch { details = {} }
  return {
    id: String(approval?.id || stableUuid(`${approval?.owner || ''}:${approval?.action || ''}:${approval?.createdAt || ''}`)),
    owner_address: ownerAddress(approval?.owner),
    agent: String(approval?.agent || ''),
    action: String(approval?.action || ''),
    amount: String(approval?.amount || ''),
    token: String(approval?.token || 'USDC'),
    source: String(approval?.source || ''),
    destination: String(approval?.to || ''),
    status: String(approval?.status || 'pending'),
    tx_hash: String(approval?.txHash || ''),
    explorer_url: String(approval?.explorerUrl || ''),
    error: String(approval?.error || ''),
    details: jsonSafe(details),
    created_at: toIso(approval?.createdAt),
    approved_at: approval?.approvedAt ? toIso(approval.approvedAt, null) : null,
    completed_at: approval?.completedAt ? toIso(approval.completedAt, null) : null,
    updated_at: toIso(approval?.updatedAt || approval?.createdAt),
  }
}

export function scheduleApprovalUpsert(approval) {
  const payload = approvalPayload(approval)
  if (!enabled || !isUsableOwner(payload.owner_address)) return
  queueWrite('agent-approval', payload.id, async () => {
    const { error } = await client.from('agent_approvals').upsert(payload, { onConflict: 'id' })
    if (error) throw error
    stats.approvalWrites++
  })
}

function cardRecordPayload(card) {
  return {
    card_id: String(card?.cardId || ''),
    owner_address: ownerAddress(card?.owner),
    label: String(card?.label || ''),
    brand: String(card?.brand || 'Visa Test'),
    network: String(card?.network || 'visa'),
    provider: String(card?.provider || 'simulator'),
    provider_card_id: card?.providerCardId ? String(card.providerCardId) : null,
    last4: String(card?.last4 || card?.pan || '').slice(-4),
    exp_month: String(card?.expMonth || ''),
    exp_year: String(card?.expYear || ''),
    status: String(card?.status || 'active'),
    blocked_categories: Array.isArray(card?.blockedCategories) ? card.blockedCategories.map(String).slice(0, 10) : [],
    limits: jsonSafe(card?.limits || {}),
    usage: jsonSafe(card?.usage || {}),
    created_at: toIso(card?.createdAt),
    updated_at: new Date().toISOString(),
  }
}

export function scheduleCardRecordUpsert(card) {
  const payload = cardRecordPayload(card)
  if (!enabled || !payload.card_id || !isUsableOwner(payload.owner_address)) return
  queueWrite('card-record', payload.card_id, async () => {
    const { error } = await client.from('card_records').upsert(payload, { onConflict: 'card_id' })
    if (error) throw error
    stats.cardRecordWrites++
  })
}

export function scheduleCardAccountUpsert(account) {
  const payload = {
    owner_address: ownerAddress(account?.owner || account?.ownerAddress),
    msca_address: ownerAddress(account?.mscaAddress || account?.wallet || account?.walletAddress),
    balance: String(account?.balance || '0'),
    source: String(account?.source || 'onchain'),
    synced_at: account?.syncedAt ? toIso(account.syncedAt, null) : null,
    metadata: jsonSafe(account?.metadata || {}),
    updated_at: new Date().toISOString(),
  }
  if (!enabled || !isUsableOwner(payload.owner_address)) return
  queueWrite('card-account', payload.owner_address, async () => {
    const { error } = await client.from('card_accounts').upsert(payload, { onConflict: 'owner_address' })
    if (error) throw error
    stats.cardAccountWrites++
  })
}

function cardTransactionPayload(tx) {
  return {
    transaction_id: String(tx?.id || tx?.txId || ''),
    card_id: String(tx?.cardId || ''),
    owner_address: ownerAddress(tx?.owner),
    merchant_id: String(tx?.merchantId || ''),
    merchant_name: String(tx?.merchantName || tx?.merchant?.name || ''),
    category: String(tx?.category || tx?.merchant?.category || ''),
    description: String(tx?.description || ''),
    amount: String(tx?.amount || '0'),
    status: String(tx?.status || ''),
    auth_code: String(tx?.authCode || ''),
    onchain: Boolean(tx?.onchain),
    provider: String(tx?.provider || ''),
    tx_hash: String(tx?.txHash || ''),
    explorer_url: String(tx?.explorerUrl || ''),
    created_at: toIso(tx?.createdAt),
    settled_at: tx?.settledAt ? toIso(tx.settledAt, null) : null,
    refunded_at: tx?.refundedAt ? toIso(tx.refundedAt, null) : null,
    decline_reason: String(tx?.declineReason || ''),
    metadata: jsonSafe(tx?.metadata || {}),
  }
}

export function scheduleCardTransactionUpsert(tx) {
  const payload = cardTransactionPayload(tx)
  if (!enabled || !payload.transaction_id || !payload.card_id || !isUsableOwner(payload.owner_address)) return
  queueWrite('card-transaction', payload.transaction_id, async () => {
    const { error } = await client.from('card_transactions').upsert(payload, { onConflict: 'transaction_id' })
    if (error) throw error
    stats.cardTransactionWrites++
  })
}

function cardFromSupabase(row) {
  const last4 = String(row?.last4 || '').slice(-4)
  return {
    cardId: String(row?.card_id || ''),
    owner: ownerAddress(row?.owner_address),
    label: String(row?.label || ''),
    brand: String(row?.brand || 'Visa Test'),
    network: String(row?.network || 'visa'),
    provider: String(row?.provider || 'simulator'),
    providerCardId: row?.provider_card_id || null,
    last4,
    expMonth: String(row?.exp_month || ''),
    expYear: String(row?.exp_year || ''),
    // Supabase intentionally stores only the masked representation. Reveal
    // always reads the local/provider secret store after fresh Passkey auth.
    pan: `••••••••••••${last4}`,
    status: row?.status || 'active',
    blockedCategories: Array.isArray(row?.blocked_categories) ? row.blocked_categories : [],
    limits: row?.limits && typeof row.limits === 'object' ? row.limits : {},
    usage: row?.usage && typeof row.usage === 'object' ? row.usage : { today: '0', month: '0' },
    createdAt: row?.created_at || new Date().toISOString(),
  }
}

export async function readCardRecords(owner, fallback = [], limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100)
  const local = Array.isArray(fallback) ? fallback.slice(0, safeLimit) : []
  if (!enabled || !cardReadPrimary || !isUsableOwner(owner)) return { cards: local, source: 'json', compared: false }
  try {
    const { data, error } = await client.from('card_records').select('*').eq('owner_address', ownerAddress(owner)).order('created_at', { ascending: false }).limit(safeLimit)
    if (error) throw error
    const remoteCards = (data || []).map(cardFromSupabase)
    const byId = new Map(remoteCards.map(card => [card.cardId, card]))
    for (const card of local) byId.set(String(card.cardId), card)
    const cards = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, safeLimit)
    stats.cardReads++
    if (cards.length === 0 && local.length > 0) return { cards: local, source: 'json-fallback', compared: true, mismatch: true }
    return { cards, source: local.length ? 'supabase-merged' : 'supabase', compared: true, mismatch: cards.length !== local.length }
  } catch (error) {
    stats.cardReadFailures++
    stats.lastCardReadError = String(error?.message || error).slice(0, 240)
    return { cards: local, source: local.length ? 'json-fallback' : 'json', compared: false, error: stats.lastCardReadError }
  }
}

function cardTransactionFromSupabase(row) {
  return {
    id: String(row?.transaction_id || ''),
    cardId: String(row?.card_id || ''),
    owner: ownerAddress(row?.owner_address),
    merchantId: String(row?.merchant_id || ''),
    merchantName: String(row?.merchant_name || ''),
    category: String(row?.category || ''),
    description: String(row?.description || ''),
    amount: String(row?.amount || '0'),
    status: String(row?.status || 'authorized'),
    authCode: String(row?.auth_code || ''),
    onchain: Boolean(row?.onchain),
    provider: String(row?.provider || ''),
    txHash: String(row?.tx_hash || ''),
    explorerUrl: String(row?.explorer_url || ''),
    createdAt: row?.created_at || new Date().toISOString(),
    settledAt: row?.settled_at || null,
    refundedAt: row?.refunded_at || null,
    declineReason: String(row?.decline_reason || ''),
  }
}

export async function readCardTransactions(owner, fallback = [], cardId = null, limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100)
  const local = (Array.isArray(fallback) ? fallback : []).filter(tx => !cardId || tx.cardId === cardId).slice(0, safeLimit)
  if (!enabled || !cardReadPrimary || !isUsableOwner(owner)) return { transactions: local, source: 'json', compared: false }
  try {
    let query = client.from('card_transactions').select('*').eq('owner_address', ownerAddress(owner))
    if (cardId) query = query.eq('card_id', String(cardId))
    const { data, error } = await query.order('created_at', { ascending: false }).limit(safeLimit)
    if (error) throw error
    const remoteTransactions = (data || []).map(cardTransactionFromSupabase)
    const byId = new Map(remoteTransactions.map(tx => [tx.id, tx]))
    for (const tx of local) byId.set(String(tx.id), tx)
    const transactions = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, safeLimit)
    stats.cardTransactionReads++
    if (transactions.length === 0 && local.length > 0) return { transactions: local, source: 'json-fallback', compared: true, mismatch: true }
    return { transactions, source: local.length ? 'supabase-merged' : 'supabase', compared: true, mismatch: transactions.length !== local.length }
  } catch (error) {
    stats.cardReadFailures++
    stats.lastCardReadError = String(error?.message || error).slice(0, 240)
    return { transactions: local, source: local.length ? 'json-fallback' : 'json', compared: false, error: stats.lastCardReadError }
  }
}

export function scheduleTreasuryFinancialEvent(entry) {
  const payload = {
    id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(entry?.id || '')) ? String(entry.id) : stableUuid(`${entry?.id || ''}:${entry?.eventType || entry?.type || ''}:${entry?.createdAt || ''}`),
    owner_address: ownerAddress(entry?.ownerAddress || entry?.owner),
    event_type: String(entry?.eventType || entry?.type || 'treasury_event'),
    amount: String(entry?.amount || ''),
    token: String(entry?.token || 'USDC'),
    chain: String(entry?.chain || entry?.network || ''),
    status: String(entry?.status || ''),
    tx_hash: String(entry?.txHash || ''),
    metadata: jsonSafe(entry),
    occurred_at: toIso(entry?.createdAt || entry?.ts),
  }
  if (!enabled) return
  queueWrite('treasury-financial-event', payload.id, async () => {
    const { error } = await client.from('treasury_financial_events').upsert(payload, { onConflict: 'id' })
    if (error) throw error
    stats.treasuryEventWrites++
  })
}

export async function reconcileDualWriteCounts() {
  if (!enabled) return { enabled: false, counts: {} }
  const tables = ['transaction_history', 'payment_invoices', 'invoice_events', 'webhook_events', 'ai_router_usage', 'x402_invoices', 'session_metadata', 'agent_activity', 'agent_approvals', 'card_accounts', 'card_records', 'card_transactions', 'treasury_financial_events']
  const counts = {}
  for (const table of tables) {
    const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
    if (error) throw error
    counts[table] = Number(count || 0)
  }
  return { enabled: true, counts, ...supabasePersistenceStatus() }
}

export { enabled as supabasePersistenceEnabled }
