// ARCOX x402 marketplace surface.
//
// Discovery and quoting are free and open: an agent can list every resource in
// the Circle x402 directory, see the provider's price per chain, and see
// exactly what ARCOX's platform fee adds — without paying anything.
//
// /call is the only money path, and in `msca` executor mode the money is the
// buyer's own: the calling agent pays ARCOX's fee invoice from its Agent Wallet
// (MSCA), then ARCOX settles the provider with an x402 payment signed by that
// same MSCA (ERC-1271 on the vanilla EIP-3009 rail). The provider price never
// passes through an ARCOX key, and a failed delivery leaves the fee
// refund-review-eligible.
import { Router } from 'express'
import { markX402ServiceOutcome, persistX402Invoices, publicInvoice, withArcoxX402 } from '../middleware/x402Middleware.mjs'
import { verifyOwnerToken } from '../services/authToken.mjs'
import { validateSession, getSessionKeyInfo } from '../services/vaultStore.mjs'
import {
  entryMscaPayable,
  getMarketplaceEntry,
  marketplaceCatalogStats,
  marketplaceQuote,
  searchMarketplaceCatalog,
  syncMarketplaceCatalog,
} from '../services/x402Marketplace.mjs'
import { marketplaceExecutorStatus, payMarketplaceEndpoint } from '../services/x402MarketplacePayment.mjs'
import { mscaNetworkForChainKey } from '../services/x402MscaPayer.mjs'
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
    mscaPayable: entryMscaPayable(entry),
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
    safeNextStep: 'Quote a resource with /api/marketplace/quote, then POST /api/marketplace/call to buy it through ARCOX. mscaPayable marks resources an Agent Wallet can settle itself.',
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

  // The buyer must be an authenticated Agent Wallet: in msca mode its own MSCA
  // is the payer for both legs, so there is no platform key to fall back on.
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) {
    return res.status(401).json({ ok: false, error: 'Active authenticated MSCA session required to buy from the marketplace' })
  }
  const authSession = await getSessionKeyInfo(authOwner.owner)
  const chainKey = String(authSession?.chain || 'arc-mainnet')
  const buyerNetwork = mscaNetworkForChainKey(chainKey)
  if (!buyerNetwork) {
    return res.status(400).json({ ok: false, error: `Agent Wallet on ${chainKey} cannot settle x402 payments yet` })
  }

  // Only the vanilla EIP-3009 rail is settleable by a contract account, so the
  // quote is pinned to it instead of surfacing a price the buyer cannot pay.
  const quote = marketplaceQuote(entry, { network: buyerNetwork, rail: 'vanilla', executor })
  if (!quote || quote.rail !== 'vanilla' || !quote.mscaPayable) {
    return res.status(400).json({
      ok: false,
      error: `resource has no vanilla EIP-3009 accept on ${buyerNetwork} that an Agent Wallet can settle`,
      quote,
      mscaPayable: false,
    })
  }
  const upstreamCap = Number(process.env.X402_MARKETPLACE_MAX_UPSTREAM_USDC || 5)
  if (Number(quote.upstream.amountUsdc) > upstreamCap) {
    return res.status(400).json({ ok: false, error: `upstream price exceeds the ${upstreamCap} USDC per-call cap`, quote })
  }
  const payerMax = Number(body.maxAmountUsdc)
  if (Number.isFinite(payerMax) && payerMax > 0 && Number(quote.upstream.amountUsdc) > payerMax) {
    return res.status(400).json({ ok: false, error: `provider price ${quote.upstream.amountUsdc} USDC exceeds maxAmountUsdc ${payerMax}`, quote })
  }
  // Fee-only invoice: the provider is paid by the buyer's MSCA, so the ARCOX
  // invoice must charge exactly the platform fee, not the resale price.
  const feeAmountUsdc = quote.platformFee.amountUsdc
  if (!(Number(feeAmountUsdc) > 0)) {
    return res.status(400).json({ ok: false, error: 'marketplace platform fee is disabled; enable X402_PLATFORM_FEE_BPS before proxying purchases' })
  }
  const acceptSnapshot = {
    rail: 'vanilla',
    network: quote.network,
    chain: quote.chain,
    chainId: quote.chainId,
    asset: quote.asset,
    payTo: quote.payTo,
    amount: quote.upstream.amountBaseUnits,
    amountUsdc: quote.upstream.amountUsdc,
    maxTimeoutSeconds: quote.maxTimeoutSeconds,
    extra: quote.extra,
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
      chainKey,
      payerMsca: invoice?.ownerWallet || authOwner.walletAddress,
      maxAmountUsdc: Number(quote.upstream.amountUsdc),
      acceptSnapshot: invoice?.upstreamPayment || acceptSnapshot,
    })
    if (payment.ok && invoice) {
      invoice.upstream = {
        amountUsdc: quote.upstream.amountUsdc,
        resource: entry.resource,
        provider: entry.provider,
        chain: quote.chain,
        network: quote.network,
        rail: 'vanilla',
        payer: invoice.ownerWallet,
        txHash: payment.settlement?.txHash || '',
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
      settlement: payment.ok ? payment.settlement || null : null,
      upstream: {
        resource: entry.resource,
        provider: entry.provider,
        method: payment.method,
        executor: payment.executor || '',
        payer: invoice?.ownerWallet || authOwner.walletAddress,
        ok: payment.ok,
        reason: payment.reason || '',
        error: payment.error || '',
      },
      safeNextStep: payment.ok
        ? 'Hasil provider sudah diteruskan. Harga provider dibayar langsung dari Agent Wallet MSCA; invoice ARCOX hanya menagih platform fee.'
        : 'Provider gagal dibayar dari Agent Wallet. Fee sudah ditandai refund-review (pending_review) oleh auto-refund worker; jangan charge ulang sebelum rekonsiliasi.',
    })
  }, {
    service: 'arcox_marketplace',
    amount: feeAmountUsdc,
    resource,
    // Zero net: this invoice resells nothing, it only bills ARCOX's fee on a
    // purchase the buyer's own wallet settles with the provider.
    split: { netAmount: '0', feeAmount: feeAmountUsdc, source: 'marketplace' },
    upstreamQuote: {
      resource: entry.resource,
      provider: entry.provider,
      category: entry.category,
      amountUsdc: quote.upstream.amountUsdc,
      chain: quote.chain,
      network: quote.network,
      cliChain: quote.cliChain,
      quotedAt: quote.quotedAt,
    },
    upstreamPayment: acceptSnapshot,
  })(req, res, next)
})

export default router
