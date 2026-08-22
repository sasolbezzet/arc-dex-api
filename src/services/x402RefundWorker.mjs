// ARCOX x402 auto-refund worker. Scans invoices that are paid but where the
// provider returned an error (provider_not_found, provider_error) and:
//
//   1. Marks eligible invoices as `refund_approved` after a cooling-off period
//      (or `manual_review` when refund farming is detected).
//   2. Executes the actual USDC refund from the treasury Unified Balance back
//      to the payer using the same delegated spend path as Auto Pay (no raw
//      treasury private key is stored anywhere).
//   3. Logs every decision for audit.
//
// Execution is idempotent per invoice, capped per day, and gated by
// X402_REFUND_EXECUTE_ENABLED. When the delegated spend path is unavailable
// (no AI_ROUTER_DELEGATE_PRIVATE_KEY), approved refunds stay in
// `refund_approved` for a treasury operator to complete manually.
import { getX402Invoice, persistX402Invoices, publicInvoice, getAllX402Invoices } from '../middleware/x402Middleware.mjs'
import { treasuryAddress } from '../config/treasury.mjs'
import { scheduleRefundAuditLog } from './supabasePersistence.mjs'

function refundCooldownMs() { return Number(process.env.X402_REFUND_COOLDOWN_MS || 5 * 60 * 1000) }
function scanIntervalMs() { return Number(process.env.X402_REFUND_SCAN_INTERVAL_MS || 60 * 1000) }
function maxRefundUsdc() { return Number(process.env.X402_MAX_AUTO_REFUND_USDC || 1.0) }
function refundExecuteDelayMs() { return Number(process.env.X402_REFUND_EXECUTE_DELAY_MS || 60 * 1000) }
function refundExecuteEnabled() { return String(process.env.X402_REFUND_EXECUTE_ENABLED || 'true').toLowerCase() === 'true' }
function refundDailyCapUsdc() { return Number(process.env.X402_REFUND_DAILY_CAP_USDC || 25) }
function refundMaxAttempts() { return Number(process.env.X402_REFUND_MAX_ATTEMPTS || 3) }
function refundFarmingLimit() { return Number(process.env.X402_REFUND_FARM_LIMIT || 5) }
function refundFarmingWindowMs() { return Number(process.env.X402_REFUND_FARM_WINDOW_MS || 24 * 60 * 60 * 1000) }

const refundLog = globalThis.__arcoxX402RefundLog || []
globalThis.__arcoxX402RefundLog = refundLog

let intervalId = globalThis.__arcoxX402RefundInterval || null

function logRefundDecision(invoiceId, action, details = {}) {
  const entry = { invoiceId, action, at: new Date().toISOString(), ...details }
  refundLog.push(entry)
  if (refundLog.length > 500) refundLog.shift()
  // Audit trail is also persisted on the invoice itself so it survives
  // restarts and rides the Supabase x402_invoices dual-write payload.
  const invoice = getX402Invoice(invoiceId)
  if (invoice) {
    invoice.refundTimeline = [...(invoice.refundTimeline || []), entry]
    if (invoice.refundTimeline.length > 20) invoice.refundTimeline.splice(0, invoice.refundTimeline.length - 20)
    // Financial audit row in Supabase refund_audit_log (fire-and-forget via
    // the dual-write queue; the in-memory log + invoice timeline are the
    // offline fallback).
    try {
      scheduleRefundAuditLog({
        invoiceId,
        paymentId: invoice.paymentId,
        action,
        amount: invoice.amount,
        ownerWallet: invoice.ownerWallet,
        serviceStatus: invoice.serviceStatus,
        txHash: details.txHash,
        at: entry.at,
      })
    } catch { /* audit write is best-effort */ }
  }
}


/**
 * Count refund-activity events for an owner inside the farming window.
 * A high count means the owner repeatedly pays for resources that fail at the
 * provider, which is the classic refund-farming pattern.
 */
export function countOwnerRecentRefunds(ownerWallet, windowMs = refundFarmingWindowMs()) {
  const owner = String(ownerWallet || '').toLowerCase()
  if (!owner) return 0
  const now = Date.now()
  const reviewedStatuses = new Set(['pending_review', 'refund_approved', 'refunded', 'manual_review', 'refund_failed_manual'])
  let count = 0
  for (const invoice of getAllX402Invoices()) {
    if (String(invoice.ownerWallet || '').toLowerCase() !== owner) continue
    if (!reviewedStatuses.has(invoice.refundStatus)) continue
    const at = Date.parse(invoice.serviceOutcomeAt || invoice.refundApprovedAt || invoice.updatedAt || '')
    if (at && now - at < windowMs) count += 1
  }
  return count
}

function refundFarmingDetected(invoice) {
  const limit = refundFarmingLimit()
  if (limit <= 0) return false
  // Exclude the invoice under review itself, then count the rest of the window.
  const owner = String(invoice.ownerWallet || '').toLowerCase()
  if (!owner) return false
  const now = Date.now()
  const reviewedStatuses = new Set(['pending_review', 'refund_approved', 'refunded', 'manual_review', 'refund_failed_manual'])
  let count = 0
  for (const other of getAllX402Invoices()) {
    if (String(other.ownerWallet || '').toLowerCase() !== owner) continue
    if (other.invoiceId === invoice.invoiceId) continue
    if (!reviewedStatuses.has(other.refundStatus)) continue
    const at = Date.parse(other.serviceOutcomeAt || other.refundApprovedAt || other.updatedAt || '')
    if (at && now - at < refundFarmingWindowMs()) count += 1
  }
  return count >= limit
}

/**
 * Scan all known invoices for paid + provider error + refundEligible +
 * pending_review, then mark them refund_approved (or manual_review when
 * farming is detected) after the cooldown. Returns newly approved invoices.
 */
export function scanRefundEligibleInvoices() {
  const approved = []
  const allInvoices = getAllX402Invoices()
  if (allInvoices.length === 0) return approved

  const now = Date.now()

  for (const invoice of allInvoices) {
    // Only process paid invoices with a provider error
    if (invoice.status !== 'paid') continue
    if (!invoice.refundEligible) continue
    if (invoice.refundStatus !== 'pending_review') continue

    // Check cooldown: wait at least cooldown period after serviceOutcomeAt
    const outcomeAt = Date.parse(invoice.serviceOutcomeAt || invoice.paidAt || '')
    if (!outcomeAt || now - outcomeAt < refundCooldownMs()) continue

    // Only approve for provider errors, not for other reasons
    const eligibleStatuses = ['provider_not_found', 'provider_error']
    if (!eligibleStatuses.includes(invoice.serviceStatus)) continue

    // Refund-farming guard: repeated provider failures from one owner are
    // routed to manual review instead of auto-approval.
    if (refundFarmingDetected(invoice)) {
      invoice.refundStatus = 'manual_review'
      invoice.updatedAt = new Date().toISOString()
      logRefundDecision(invoice.invoiceId, 'refund_manual_review', {
        ownerWallet: invoice.ownerWallet,
        serviceStatus: invoice.serviceStatus,
        recentRefunds: countOwnerRecentRefunds(invoice.ownerWallet),
        reason: 'repeated provider-failure refunds from the same owner; manual review required',
      })
      persistInvoiceRef(invoice)
      continue
    }

    // Safety: only auto-approve refunds under max refund amount
    const amount = Number(invoice.uniqueAmount || invoice.amount || 0)
    if (amount > maxRefundUsdc()) {
      logRefundDecision(invoice.invoiceId, 'skipped_amount_exceeds_max', { amount, max: maxRefundUsdc() })
      continue
    }

    // Mark as refund_approved
    invoice.refundStatus = 'refund_approved'
    invoice.refundApprovedAt = new Date().toISOString()
    invoice.updatedAt = invoice.refundApprovedAt

    approved.push(publicInvoice(invoice))
    logRefundDecision(invoice.invoiceId, 'refund_approved', {
      amount: invoice.uniqueAmount,
      ownerWallet: invoice.ownerWallet,
      serviceStatus: invoice.serviceStatus,
      serviceError: invoice.serviceError,
    })
    persistInvoiceRef(invoice)
  }

  return approved
}

/**
 * Persist a mutated invoice back through the middleware map (live reference)
 * AND flush to JSON + Supabase dual-write. Without this the refund status
 * changes would only live in memory and vanish on restart.
 */
function persistInvoiceRef(invoice) {
  const latest = getX402Invoice(invoice.invoiceId)
  if (!latest) return
  for (const key of ['refundStatus', 'refundApprovedAt', 'updatedAt', 'refundAttempts', 'refundExecuteError', 'refundedAt', 'refundTxHash', 'refundTimeline']) {
    if (invoice[key] !== undefined) latest[key] = invoice[key]
  }
  persistX402Invoices()
}

/**
 * Execute a refund for one approved invoice: send USDC from the treasury
 * Unified Balance back to the payer via the delegated spend path, then mark
 * the invoice refunded with the resulting tx hash. Inject spendFn in tests.
 */
export async function executeRefund(invoiceId, options = {}) {
  const spendFn = options.spendFn || null
  const invoice = getX402Invoice(invoiceId)
  if (!invoice) return { ok: false, reason: 'invoice_not_found' }
  if (invoice.refundStatus !== 'refund_approved') {
    return { ok: false, reason: `not_approved (${invoice.refundStatus || 'none'})` }
  }
  if (!refundExecuteEnabled()) {
    return { ok: false, reason: 'disabled', message: 'X402_REFUND_EXECUTE_ENABLED is false; refund stays approved for manual execution' }
  }
  const amount = String(invoice.uniqueAmount || invoice.amount || '0')
  if (Number(amount) <= 0) return { ok: false, reason: 'invalid_amount' }

  // Daily treasury cap: never auto-refund more than the configured budget/day.
  const cap = refundDailyCapUsdc()
  if (cap > 0) {
    const executedToday = executedRefundsToday()
    if (executedToday + Number(amount) > cap) {
      logRefundDecision(invoice.invoiceId, 'refund_execute_skipped_daily_cap', { amount, executedToday, cap })
      return { ok: false, reason: 'daily_cap', message: `daily refund cap reached (${executedToday.toFixed(6)}/${cap} USDC)` }
    }
  }

  let spend
  try {
    if (spendFn) {
      spend = await spendFn({ amount, recipient: invoice.ownerWallet, sourceAccount: options.sourceAccount || treasuryAddress() })
    } else {
      const { spendDelegatedUnifiedBalance } = await import('../services/aiRouterSpendService.mjs')
      spend = await spendDelegatedUnifiedBalance({
        sourceAccount: options.sourceAccount || treasuryAddress(),
        amount,
        recipient: invoice.ownerWallet,
        destinationChain: 'Arc_Testnet',
        maxTotalDebit: (Number(amount) + 0.01).toFixed(6),
      })
    }
  } catch (error) {
    invoice.refundAttempts = (invoice.refundAttempts || 0) + 1
    invoice.refundExecuteError = String(error?.message || error).slice(0, 300)
    invoice.updatedAt = new Date().toISOString()
    if (invoice.refundAttempts >= refundMaxAttempts()) {
      invoice.refundStatus = 'refund_failed_manual'
      invoice.updatedAt = new Date().toISOString()
      logRefundDecision(invoice.invoiceId, 'refund_execute_failed_manual', { error: invoice.refundExecuteError, attempts: invoice.refundAttempts })
    } else {
      logRefundDecision(invoice.invoiceId, 'refund_execute_failed', { error: invoice.refundExecuteError, attempts: invoice.refundAttempts })
    }
    persistInvoiceRef(invoice)
    return { ok: false, reason: 'spend_failed', error: invoice.refundExecuteError }
  }

  const txHash = String(spend?.txHash || spend?.result?.txHash || spend?.transferId || '').trim()
  if (!txHash) {
    invoice.refundAttempts = (invoice.refundAttempts || 0) + 1
    invoice.refundExecuteError = 'Unified Balance spend returned no tx hash'
    invoice.updatedAt = new Date().toISOString()
    logRefundDecision(invoice.invoiceId, 'refund_execute_failed', { error: invoice.refundExecuteError })
    persistInvoiceRef(invoice)
    return { ok: false, reason: 'missing_tx_hash' }
  }
  logRefundDecision(invoice.invoiceId, 'refund_executed', { txHash, amount, ownerWallet: invoice.ownerWallet })
  const completed = markRefundCompleted(invoice.invoiceId, txHash)
  return { ok: true, txHash, amount, refund: completed }
}

/** Sum of refunds executed (refunded) today, used for the daily cap. */
export function executedRefundsToday() {
  const now = Date.now()
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
  let total = 0
  for (const invoice of getAllX402Invoices()) {
    if (invoice.refundStatus !== 'refunded') continue
    const at = Date.parse(invoice.refundedAt || invoice.updatedAt || '')
    if (at && at >= startOfDay.getTime() && at <= now) total += Number(invoice.uniqueAmount || 0) || 0
  }
  return total
}

/**
 * Execute all refund_approved invoices whose approval happened more than
 * X402_REFUND_EXECUTE_DELAY_MS ago. Sequential and fault-tolerant per invoice.
 */
export async function executeApprovedRefunds(options = {}) {
  const results = []
  const now = Date.now()
  for (const invoice of getAllX402Invoices()) {
    if (invoice.refundStatus !== 'refund_approved') continue
    const approvedAt = Date.parse(invoice.refundApprovedAt || '')
    if (!approvedAt || now - approvedAt < refundExecuteDelayMs()) continue
    results.push({ invoiceId: invoice.invoiceId, ...(await executeRefund(invoice.invoiceId, options)) })
  }
  return results
}

/**
 * Return all invoices currently in refund_approved state, sorted by approval time.
 */
export function listApprovedRefunds() {
  const allInvoices = getAllX402Invoices()
  const result = allInvoices
    .filter(invoice => invoice.refundStatus === 'refund_approved')
    .map(invoice => publicInvoice(invoice))
  result.sort((a, b) => Date.parse(b.refundApprovedAt || 0) - Date.parse(a.refundApprovedAt || 0))
  return result
}

/**
 * Mark a refund as completed (called by the treasury operator after sending
 * USDC back, or automatically after a successful delegated spend). Persists
 * to JSON + Supabase so the refunded state survives restarts.
 */
export function markRefundCompleted(invoiceId, txHash) {
  const invoice = getX402Invoice(invoiceId)
  if (!invoice) return null
  invoice.refundStatus = 'refunded'
  invoice.refundTxHash = String(txHash || '')
  invoice.refundedAt = new Date().toISOString()
  invoice.updatedAt = invoice.refundedAt
  // getX402Invoice returns a live reference from the middleware's map
  logRefundDecision(invoice.invoiceId, 'refund_completed', { txHash })
  persistX402Invoices()
  return publicInvoice(invoice)
}

export function getRefundLog() {
  return [...refundLog]
}

/**
 * Start the periodic refund scanner + executor. Safe to call multiple times;
 * only one interval runs at a time.
 */
export function startRefundWorker() {
  if (intervalId) return intervalId
  const interval = scanIntervalMs()
  intervalId = setInterval(() => {
    try {
      const approved = scanRefundEligibleInvoices()
      if (approved.length > 0) {
        console.log(`[x402-refund] auto-approved ${approved.length} refund(s)`)
      }
    } catch (error) {
      console.error('[x402-refund] scan error', error?.message || error)
    }
    if (refundExecuteEnabled()) {
      void executeApprovedRefunds().then(results => {
        const executed = results.filter(result => result.ok)
        if (executed.length > 0) {
          console.log(`[x402-refund] executed ${executed.length} refund(s): ${executed.map(result => result.txHash).join(', ')}`)
        }
      }).catch(error => {
        console.error('[x402-refund] execute error', error?.message || error)
      })
    }
  }, interval)
  globalThis.__arcoxX402RefundInterval = intervalId
  console.log(`[x402-refund] worker started (interval=${interval}ms, cooldown=${refundCooldownMs()}ms, max=${maxRefundUsdc()} USDC, execute=${refundExecuteEnabled() ? 'enabled' : 'disabled'}, dailyCap=${refundDailyCapUsdc()} USDC)`)
  return intervalId
}

/**
 * Stop the periodic refund scanner.
 */
export function stopRefundWorker() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
    globalThis.__arcoxX402RefundInterval = null
  }
}
