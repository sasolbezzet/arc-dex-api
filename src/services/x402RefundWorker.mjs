// ARCOX x402 auto-refund worker. Scans invoices that are paid but where the
// provider returned an error (provider_not_found, provider_error). Instead
// of automatically sending USDC from the treasury (which would require a
// private key that this service never stores), the worker:
//
//   1. Marks eligible invoices as `refund_approved` after a cooling-off period.
//   2. Exposes them through a list endpoint for an admin/treasury operator to
//      execute the actual on-chain refund via a separate, authenticated
//      treasury process.
//   3. Logs every decision for audit.
//
// This keeps the refund flow auditable and never sends funds without an
// explicit, separately authenticated treasury action. The worker runs on
// a setInterval and is safe to call multiple times (idempotent per invoice).
import { getX402Invoice, publicInvoice, getAllX402Invoices } from '../middleware/x402Middleware.mjs'

function refundCooldownMs() { return Number(process.env.X402_REFUND_COOLDOWN_MS || 5 * 60 * 1000) }
function scanIntervalMs() { return Number(process.env.X402_REFUND_SCAN_INTERVAL_MS || 60 * 1000) }
function maxRefundUsdc() { return Number(process.env.X402_MAX_AUTO_REFUND_USDC || 1.0) }

const refundLog = globalThis.__arcoxX402RefundLog || []
globalThis.__arcoxX402RefundLog = refundLog

let intervalId = globalThis.__arcoxX402RefundInterval || null

/**
 * Scan all known invoices for paid + provider_error + refundEligible +
 * pending_review, then mark them refund_approved after the cooldown.
 * Returns the list of newly approved refunds.
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

    // Safety: only auto-approve refunds under max refund amount
    const amount = Number(invoice.uniqueAmount || invoice.amount || 0)
    if (amount > maxRefundUsdc()) {
      logRefundDecision(invoice.invoiceId, 'skipped_amount_exceeds_max', { amount, max: maxRefundUsdc() })
      continue
    }

    // Only approve for provider errors, not for other reasons
    const eligibleStatuses = ['provider_not_found', 'provider_error']
    if (!eligibleStatuses.includes(invoice.serviceStatus)) continue

    // Mark as refund_approved
    invoice.refundStatus = 'refund_approved'
    invoice.refundApprovedAt = new Date().toISOString()
    invoice.updatedAt = invoice.refundApprovedAt
    // Persist back through getX402Invoice which also updates the map
    const latest = getX402Invoice(invoice.invoiceId)
    if (latest) {
      latest.refundStatus = invoice.refundStatus
      latest.refundApprovedAt = invoice.refundApprovedAt
      latest.updatedAt = invoice.updatedAt
    }

    approved.push(publicInvoice(invoice))
    logRefundDecision(invoice.invoiceId, 'refund_approved', {
      amount: invoice.uniqueAmount,
      ownerWallet: invoice.ownerWallet,
      serviceStatus: invoice.serviceStatus,
      serviceError: invoice.serviceError,
    })
  }

  return approved
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
 * Mark a refund as completed (called by the treasury operator after sending USDC back).
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
  return publicInvoice(invoice)
}

function logRefundDecision(invoiceId, action, details = {}) {
  const entry = { invoiceId, action, at: new Date().toISOString(), ...details }
  refundLog.push(entry)
  if (refundLog.length > 500) refundLog.shift()
}

export function getRefundLog() {
  return [...refundLog]
}

/**
 * Start the periodic refund scanner. Safe to call multiple times; only one
 * interval runs at a time.
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
  }, interval)
  globalThis.__arcoxX402RefundInterval = intervalId
  console.log(`[x402-refund] worker started (interval=${interval}ms, cooldown=${refundCooldownMs()}ms, max=${maxRefundUsdc()} USDC)`)
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
