// ARCOX x402 client SDK.
//
// Pay-per-request read-only access to Arkham intelligence through the ARCOX
// backend. Flow:
//
//   1. createInvoice(resource)            -> x402 invoice (HTTP 402 payload)
//   2. pay the invoice (your wallet or app) — the invoice is a direct USDC
//      transfer to the treasury on Arc; reconciliation happens on-chain
//   3. unlock(resource, paymentId)        -> the Arkham data
//
// The SDK never moves funds itself: `pay()` takes a caller-supplied transfer
// function so the wallet/signing layer stays in your application.
//
//   import { createX402Client } from './arcox-x402.mjs'
//   const client = createX402Client({ baseUrl, ownerWallet, authToken })
//   const { data: invoice } = await client.createInvoice('/api/intel/risk/address/0x123')
//   await client.pay(invoice, async inv => transferUsdc(inv))  // your function
//   const { data } = await client.unlock('/api/intel/risk/address/0x123', invoice.paymentId)

export function createX402Client(options = {}) {
  const baseUrl = String(options.baseUrl || 'https://43.134.14.43.nip.io').replace(/\/+$/, '')
  const authToken = options.authToken || ''
  const ownerWallet = options.ownerWallet || ''
  const agentId = options.agentId || ''

  function authHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(ownerWallet ? { 'X-Arcox-Owner': ownerWallet } : {}),
      ...(agentId ? { 'X-Arcox-Agent-Id': agentId } : {}),
      ...extra,
    }
  }

  async function request(path, { method = 'GET', body, query, headers = {} } = {}) {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const response = await fetch(url, {
      method,
      headers: authHeaders(headers),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const data = await response.json().catch(() => ({}))
    return { status: response.status, ok: response.ok, data }
  }

  return {
    /** Current public x402 configuration (asset, recipient, limits). */
    config: () => request('/api/x402/config'),
    /** This OpenAPI document. */
    openApi: () => request('/api/x402/openapi.json'),
    /** Structured catalog of every paid Intel service (free). */
    catalog: () => request('/api/intel/catalog'),
    /** Arkham circuit-breaker state per service group (free). */
    providerHealth: () => request('/api/intel/provider-health'),

    /** Create an x402 invoice for a resource path. */
    createInvoice: (resource, opts = {}) => request('/api/x402/invoices/create', {
      method: 'POST',
      body: { resource, ...opts },
    }),
    /** Alias of createInvoice (x402 payment-request terminology). */
    paymentRequest: (resource, opts = {}) => request('/api/x402/payment-request', {
      method: 'POST',
      body: { resource, ...opts },
    }),
    /** Reconcile + read invoice state by invoiceId. */
    getInvoice: invoiceId => request(`/api/x402/invoices/${encodeURIComponent(invoiceId)}/status`),
    /** Read a payment request by paymentId. */
    getPaymentRequest: paymentId => request(`/api/x402/payment-request/${encodeURIComponent(paymentId)}`),

    /**
     * Unlock a paid resource. Call this with the paymentId of the paid
     * invoice; the backend serves the Arkham data (or an error payload).
     */
    unlock: (resource, paymentId) => request(resource, { query: { paymentId } }),

    /**
     * Poll an invoice until it reaches a final state (paid/expired).
     * Returns the final invoice payload.
     */
    waitForInvoice: async (invoiceId, { timeoutMs = 120_000, pollMs = 5_000 } = {}) => {
      const deadline = Date.now() + timeoutMs
      let last
      while (Date.now() < deadline) {
        const { data } = await request(`/api/x402/invoices/${encodeURIComponent(invoiceId)}/status`)
        last = data?.invoice || data?.x402 || data
        if (last && ['paid', 'expired', 'failed', 'cancelled', 'refunded'].includes(last.status)) return last
        await new Promise(resolve => setTimeout(resolve, pollMs))
      }
      return last
    },

    /**
     * Pay an invoice. `transfer` is YOUR function that moves USDC to the
     * invoice recipient (e.g. a wallet client or Circle AppKit session).
     * The SDK only passes the invoice and records the outcome.
     */
    pay: async (invoice, transfer) => {
      if (!invoice?.recipient || !invoice?.amount) throw new Error('Invalid x402 invoice; call createInvoice first')
      const result = await transfer(invoice)
      return { invoice, transferResult: result }
    },

    /** Usage analytics (owner-gated). */
    stats: () => request('/api/x402/stats'),
    /** Treasury unified-balance health. */
    treasuryHealth: () => request('/api/x402/treasury-health'),
    /** List auto-approved refunds. */
    approvedRefunds: () => request('/api/x402/refunds/approved'),
    /** Refund audit log. */
    refundLog: () => request('/api/x402/refunds/log'),
  }
}
