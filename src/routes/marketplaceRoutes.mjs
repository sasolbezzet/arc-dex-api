// ARCOX x402 marketplace surface.
//
// Discovery and quoting are free and open: an agent can list every resource in
// the Circle x402 directory, see the provider's price per chain, and see
// exactly what ARCOX's platform fee adds — without paying anything. Only
// /call settles money, and only when an outbound payment executor is
// configured, so the mirror can ship safely before any wallet is funded.
import { Router } from 'express'
import { markX402ServiceOutcome, persistX402Invoices, publicInvoice, withArcoxX402 } from '../middleware/x402Middleware.mjs'
import { verifyOwnerToken } from '../services/authToken.mjs'
import { validateSession, getSessionKeyInfo } from '../services/vaultStore.mjs'
import {
  getMarketplaceEntry,
  marketplaceCatalogStats,
  marketplaceQuote,
  searchMarketplaceCatalog,
  syncMarketplaceCatalog,
} from '../services/x402Marketplace.mjs'
import { marketplaceExecutorStatus, payMarketplaceEndpoint } from '../services/x402MarketplacePayment.mjs'
import { platformFeeBps } from '../services/platformFee.mjs'

const router = Router()

async function authenticatedOwner(req) {
  const auth = String(req.headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  let owner = verifyOwnerToken(token)
  if (!owner && token.startsWith('arx_vs_')) owner = validateSession(token)
  if (!owner) return null
  const session = await getSessionKeyInfo(owner)
  return session?.active ? { owner, walletAddress: String(session.walletAddress).toLowerCase() } : null
}

function compactEntry(entry) {
  return {
    id: entry.id,
    resource: entry.resource,
    provider: entry.provider,
    category: entry.category,
    description: entry.description,
    method: entry.method,
    priceUsdc: entry.priceUsdc,
    chains: entry.chains,
    payableChains: entry.payableChains,
    gateway: entry.supportsCircleGateway,
    vanilla: entry.supportsVanillaX402,
    tags: entry.tags,
    lastUpdated: entry.lastUpdated,
  }
}

function clampLimit(value, fallback = 20, max = 100) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

// ── Free discovery ──

router.get('/stats', (_req, res) => {
  res.json({ ok: true, readOnly: true, stats: marketplaceCatalogStats(), executor: marketplaceExecutorStatus() })
})

router.get('/catalog', (req, res) => {
  const result = searchMarketplaceCatalog({
    query: req.query.q || req.query.query || '',
    category: req.query.category || '',
    provider: req.query.provider || '',
    network: req.query.network || req.query.chain || '',
    maxPriceUsdc: req.query.maxPriceUsdc || req.query.maxPrice,
    gatewayOnly: String(req.query.gatewayOnly || '') === 'true',
    payableOnly: String(req.query.payableOnly || '') === 'true',
    limit: clampLimit(req.query.limit),
    offset: Number(req.query.offset) || 0,
  })
  res.json({
    ok: true,
    readOnly: true,
    syncedAt: result.syncedAt,
    catalogTotal: result.catalogTotal,
    total: result.total,
    offset: result.offset,
    limit: result.limit,
    items: result.items.map(compactEntry),
    platformFee: { bps: platformFeeBps(), chargedOn: 'top-of-price' },
    safeNextStep: 'Quote a resource with /api/marketplace/quote, then POST /api/marketplace/call to buy it through ARCOX.',
  })
})

router.get('/quote', (req, res) => {
  const ref = req.query.resource || req.query.id || req.query.url || ''
  const entry = getMarketplaceEntry(ref)
  if (!entry) return res.status(404).json({ ok: false, error: 'marketplace resource not found', ref })
  const quote = marketplaceQuote(entry, {
    chain: req.query.chain || '',
    network: req.query.network || '',
    executor: marketplaceExecutorStatus(),
  })
  res.json({ ok: true, readOnly: true, quote, resource: compactEntry(entry), executor: marketplaceExecutorStatus() })
})

// Refresh the mirror from the discovery directory (owner-gated: it writes the
// shared catalogue every agent reads).
router.post('/sync', async (req, res) => {
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const summary = await syncMarketplaceCatalog()
  res.status(summary.ok ? 200 : 502).json({ ok: summary.ok, ...summary })
})

// ── Paid resale ──

router.post('/call', async (req, res, next) => {
  const executor = marketplaceExecutorStatus()
  if (!executor.configured) {
    return res.status(503).json({
      ok: false,
      error: 'marketplace payment executor is not configured; discovery and quoting stay available',
      executor,
    })
  }
  const body = req.body || {}
  const entry = getMarketplaceEntry(body.resource || body.id || body.url || '')
  if (!entry) return res.status(404).json({ ok: false, error: 'marketplace resource not found' })
  const quote = marketplaceQuote(entry, { chain: body.chain || '', network: body.network || '' })
  if (!quote?.cliChain) {
    return res.status(400).json({ ok: false, error: 'resource has no chain ARCOX can pay from', quote })
  }
  const upstreamCap = Number(process.env.X402_MARKETPLACE_MAX_UPSTREAM_USDC || 5)
  if (Number(quote.upstream.amountUsdc) > upstreamCap) {
    return res.status(400).json({ ok: false, error: `upstream price exceeds the ${upstreamCap} USDC per-call cap`, quote })
  }
  const payerMax = Number(body.maxAmountUsdc)
  if (Number.isFinite(payerMax) && payerMax > 0 && Number(quote.totalUsdc) > payerMax) {
    return res.status(400).json({ ok: false, error: `quote total ${quote.totalUsdc} USDC exceeds maxAmountUsdc ${payerMax}`, quote })
  }

  const resource = `/api/marketplace/call/${entry.id}`
  return withArcoxX402(async (paidReq, paidRes) => {
    const invoice = paidReq.arcoxX402?.invoice
    const payment = await payMarketplaceEndpoint({
      resource: entry.resource,
      method: entry.method,
      data: body.data,
      headers: body.headers,
      chain: quote.cliChain,
      maxAmountUsdc: Number(quote.upstream.amountUsdc),
    })
    if (payment.ok && invoice) {
      invoice.upstream = {
        amountUsdc: quote.upstream.amountUsdc,
        resource: entry.resource,
        provider: entry.provider,
        chain: quote.chain,
        cliChain: quote.cliChain,
        paidAt: new Date().toISOString(),
      }
      invoice.serviceStatus = 'service_unlocked'
      invoice.serviceUnlockedAt = new Date().toISOString()
      persistX402Invoices()
    } else if (!payment.ok && invoice?.status === 'paid') {
      markX402ServiceOutcome(invoice.invoiceId, {
        status: 'provider_error',
        reason: String(payment.error || payment.reason || 'marketplace payment failed').slice(0, 300),
        refundEligible: true,
      })
    }
    paidRes.status(payment.ok ? 200 : 502).json({
      ok: payment.ok,
      quote,
      platformFee: quote.platformFee,
      x402Payment: invoice ? publicInvoice(invoice) : null,
      result: payment.ok ? payment.providerPayload : null,
      upstream: {
        resource: entry.resource,
        provider: entry.provider,
        method: payment.method,
        ok: payment.ok,
        reason: payment.reason || '',
        error: payment.error || '',
      },
      safeNextStep: payment.ok
        ? 'Hasil provider sudah diteruskan. ARCOX menagih harga provider + platform fee pada invoice ini.'
        : 'Provider gagal dibayar. Invoice sudah ditandai refund-review (pending_review) oleh auto-refund worker; jangan charge ulang sebelum rekonsiliasi.',
    })
  }, {
    service: 'arcox_marketplace',
    amount: quote.upstream.amountUsdc,
    resource,
    platformFee: {
      applied: Number(quote.platformFee.amountUsdc) > 0,
      bps: quote.platformFee.bps,
      amountUsdc: quote.platformFee.amountUsdc,
      source: 'marketplace',
    },
    upstreamQuote: {
      resource: entry.resource,
      provider: entry.provider,
      category: entry.category,
      amountUsdc: quote.upstream.amountUsdc,
      chain: quote.chain,
      cliChain: quote.cliChain,
      quotedAt: quote.quotedAt,
    },
  })(req, res, next)
})

export default router
