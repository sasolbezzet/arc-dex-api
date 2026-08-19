import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const mode = String(process.env.SUPABASE_PERSISTENCE_MODE || (process.env.NODE_ENV === 'production' ? 'shadow' : 'off')).toLowerCase()
const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const enabled = (mode === 'shadow' || mode === 'canary')
  && /^https:\/\/[^\s]+\.supabase\.co$/.test(url)
  && serviceRoleKey.length > 20

const client = enabled
  ? createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === 'bigint' ? item.toString() : item))
}

function isoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function eventPayload(event) {
  return {
    event_type: String(event?.eventType || ''),
    raw_payload: jsonSafe(event?.rawPayload || {}),
    processed: Boolean(event?.processed),
    matched: Boolean(event?.matched),
    related_invoice_id: event?.relatedInvoiceId ? String(event.relatedInvoiceId) : '',
    related_tx_hash: String(event?.relatedTxHash || ''),
    related_user_operation_hash: String(event?.relatedUserOpHash || ''),
    wallet_address: String(event?.walletAddress || '').toLowerCase(),
    status: String(event?.status || ''),
    error: String(event?.error || ''),
    received_at: isoOrNull(event?.receivedAt || event?.createdAt),
    processed_at: isoOrNull(event?.processedAt),
  }
}

function jobFromRow(row) {
  if (!row) return null
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {}
  return {
    ...payload,
    jobId: String(row.job_id || payload.jobId || ''),
    burnTx: String(row.burn_tx_hash || payload.burnTx || ''),
    owner: String(row.owner_address || payload.owner || '').toLowerCase(),
    fromChain: String(row.from_chain || payload.fromChain || ''),
    toChain: String(row.to_chain || payload.toChain || ''),
    status: String(row.status || payload.status || 'polling'),
    retryable: Boolean(row.retryable ?? payload.retryable),
    attempts: Number(row.attempts || payload.attempts || 0),
    totalAttempts: Number(row.total_attempts || payload.totalAttempts || 0),
    retryCount: Number(row.retry_count || payload.retryCount || 0),
    nextRetryAt: row.next_retry_at || payload.nextRetryAt || undefined,
    lastAttemptAt: row.last_attempt_at || payload.lastAttemptAt || undefined,
    readyAt: row.ready_at || payload.readyAt || undefined,
    attestation: String(row.attestation || payload.attestation || ''),
    message: String(row.message || payload.message || ''),
    messageTransmitter: String(row.message_transmitter || payload.messageTransmitter || ''),
    error: String(row.error || payload.error || ''),
    createdAt: row.created_at || payload.createdAt || Date.now(),
    updatedAt: row.updated_at || payload.updatedAt || undefined,
  }
}

function jobPayload(job) {
  return {
    job_id: String(job?.jobId || ''),
    burn_tx_hash: String(job?.burnTx || ''),
    owner_address: String(job?.owner || '').toLowerCase(),
    from_chain: String(job?.fromChain || ''),
    to_chain: String(job?.toChain || ''),
    status: String(job?.status || 'polling'),
    retryable: Boolean(job?.retryable),
    attempts: Math.max(0, Number(job?.attempts || 0)),
    total_attempts: Math.max(0, Number(job?.totalAttempts || 0)),
    retry_count: Math.max(0, Number(job?.retryCount || 0)),
    next_retry_at: isoOrNull(job?.nextRetryAt),
    last_attempt_at: isoOrNull(job?.lastAttemptAt),
    ready_at: isoOrNull(job?.readyAt),
    attestation: String(job?.attestation || ''),
    message: String(job?.message || ''),
    message_transmitter: String(job?.messageTransmitter || ''),
    error: String(job?.error || ''),
    payload: jsonSafe(job),
    created_at: isoOrNull(job?.createdAt) || new Date().toISOString(),
  }
}

export function supabaseOperationalStatus() {
  return { enabled, mode, webhookPrimary: enabled, autoMintPrimary: enabled }
}

export function newLeaseToken() {
  return randomUUID()
}

export async function claimWebhookEvent(event, claimToken = newLeaseToken(), leaseSeconds = 120) {
  if (!enabled) return { enabled: false, claimed: true, duplicate: false, claimToken, event }
  try {
    const { data, error } = await client.rpc('arcox_claim_webhook_event', {
      p_provider: String(event?.provider || ''),
      p_notification_id: String(event?.notificationId || ''),
      p_claim_token: String(claimToken),
      p_lease_seconds: Number(leaseSeconds),
      p_event: eventPayload(event),
    })
    if (error) throw error
    const result = data && typeof data === 'object' ? data : {}
    return {
      enabled: true,
      claimed: Boolean(result.claimed),
      duplicate: Boolean(result.duplicate),
      claimToken,
      event: result.event || event,
    }
  } catch (error) {
    // Availability fallback is intentional: local file-lock remains capable
    // of accepting a webhook while Supabase is unavailable.
    return { enabled: true, unavailable: true, claimed: true, duplicate: false, claimToken, event, error: String(error?.message || error).slice(0, 240) }
  }
}

export async function completeWebhookEvent(event, claimToken) {
  if (!enabled || !claimToken) return { enabled: false, completed: false }
  try {
    const { data, error } = await client.rpc('arcox_complete_webhook_event', {
      p_provider: String(event?.provider || ''),
      p_notification_id: String(event?.notificationId || ''),
      p_claim_token: String(claimToken),
      p_event: eventPayload(event),
    })
    if (error) throw error
    return { enabled: true, completed: data === true }
  } catch (error) {
    return { enabled: true, completed: false, error: String(error?.message || error).slice(0, 240) }
  }
}

export async function listAutoMintJobs() {
  if (!enabled) return { enabled: false, jobs: [] }
  try {
    const { data, error } = await client.from('auto_mint_jobs').select('*').order('updated_at', { ascending: false }).range(0, 9999)
    if (error) throw error
    return { enabled: true, jobs: (data || []).map(jobFromRow).filter(Boolean) }
  } catch (error) {
    return { enabled: true, unavailable: true, jobs: [], error: String(error?.message || error).slice(0, 240) }
  }
}

export async function readAutoMintJob(jobId) {
  if (!enabled || !jobId) return { enabled: false, job: null }
  try {
    const { data, error } = await client.from('auto_mint_jobs').select('*').eq('job_id', String(jobId)).maybeSingle()
    if (error) throw error
    return { enabled: true, job: jobFromRow(data) }
  } catch (error) {
    return { enabled: true, unavailable: true, job: null, error: String(error?.message || error).slice(0, 240) }
  }
}

export async function upsertAutoMintJob(job) {
  if (!enabled || !job?.jobId || !job?.burnTx || !job?.owner) return { enabled: false, written: false }
  try {
    const { error } = await client.from('auto_mint_jobs').upsert(jobPayload(job), { onConflict: 'job_id' })
    if (error) throw error
    return { enabled: true, written: true }
  } catch (error) {
    return { enabled: true, written: false, error: String(error?.message || error).slice(0, 240) }
  }
}

export async function claimAutoMintLease(job, leaseToken = newLeaseToken(), leaseSeconds = 180) {
  if (!enabled) return { enabled: false, claimed: true, conflict: false, leaseToken, job }
  try {
    const { data, error } = await client.rpc('arcox_claim_auto_mint_job', {
      p_job_id: String(job?.jobId || ''),
      p_burn_tx_hash: String(job?.burnTx || ''),
      p_owner_address: String(job?.owner || '').toLowerCase(),
      p_from_chain: String(job?.fromChain || ''),
      p_to_chain: String(job?.toChain || ''),
      p_lease_token: String(leaseToken),
      p_lease_seconds: Number(leaseSeconds),
    })
    if (error) throw error
    const result = data && typeof data === 'object' ? data : {}
    return { enabled: true, claimed: Boolean(result.claimed), conflict: Boolean(result.conflict), leaseToken, job: jobFromRow(result.job) || job }
  } catch (error) {
    return { enabled: true, unavailable: true, claimed: true, conflict: false, leaseToken, job, error: String(error?.message || error).slice(0, 240) }
  }
}

export async function releaseAutoMintLease(jobId, leaseToken) {
  if (!enabled || !jobId || !leaseToken) return { enabled: false, released: false }
  try {
    const { data, error } = await client.rpc('arcox_release_auto_mint_lease', {
      p_job_id: String(jobId),
      p_lease_token: String(leaseToken),
    })
    if (error) throw error
    return { enabled: true, released: data === true }
  } catch (error) {
    return { enabled: true, released: false, error: String(error?.message || error).slice(0, 240) }
  }
}

export { enabled as supabaseOperationalEnabled }
