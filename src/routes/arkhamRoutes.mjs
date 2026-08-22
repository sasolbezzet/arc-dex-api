import { Router } from 'express'
import { ArkhamService, circuitStatus, degradedForProviderPath } from '../services/arkhamService.mjs'
import { priceFromEnv, withArcoxX402, markX402ServiceOutcome } from '../middleware/x402Middleware.mjs'
import { buildIntelPresentation } from '../services/intelPresentation.mjs'
import { getIntelCatalog } from '../services/intelCatalog.mjs'

const router = Router()
const arkham = new ArkhamService()

function paid(priceEnv, fallback, handler) {
  return withArcoxX402(handler, { amount: priceFromEnv(priceEnv, fallback), priceEnv, service: 'arcox_intel' })
}

function withPaymentMeta(req, payload, context = {}) {
  const invoice = req.arcoxX402?.invoice
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return {
    ...payload,
    intelPresentation: buildIntelPresentation(payload, context),
    ...(invoice ? { x402Payment: {
      invoiceId: invoice.invoiceId,
      paymentId: invoice.paymentId,
      agentId: invoice.agentId || '',
      ownerWallet: invoice.ownerWallet || '',
      status: invoice.status,
      amount: invoice.uniqueAmount,
      asset: invoice.asset,
      network: invoice.network,
      recipient: invoice.recipient,
      txHash: invoice.txHash,
      paidAt: invoice.paidAt,
      reconciledBy: invoice.reconciledBy,
      memoId: invoice.memoId,
      memoProofTxHash: invoice.memoProofTxHash || '',
    } } : {}),
  }
}

function queryWithDefaults(req, defaults = {}) {
  const base = typeof defaults === 'function' ? defaults(req) : defaults
  return { ...base, ...(req.query || {}) }
}

function last24hWindow() {
  const to = Date.now()
  return { from: String(to - 24 * 60 * 60 * 1000), to: String(to) }
}

function sendArkham(pathBuilder, priceEnv, fallback, defaults = {}) {
  return paid(priceEnv, fallback, async (req, res) => {
    try {
      const providerPath = pathBuilder(req)
      const query = queryWithDefaults(req, defaults)
      const payload = await arkham.get(providerPath, query)
      const service = serviceName(req.route?.path || req.path)
      res.json(withPaymentMeta(req, payload, {
        service,
        serviceLabel: service,
        resource: req.originalUrl,
        providerPath,
        query,
      }))
    } catch (error) {
      // A paid request that fails at the provider (404 = no data, 5xx/timeout
      // = provider error) must be recorded as refund-review-eligible so the
      // auto-refund worker can approve a refund instead of silently losing
      // the user's payment.
      const invoice = req.arcoxX402?.invoice
      if (invoice?.status === 'paid' && !invoice.serviceStatus) {
        const statusCode = error.status || 502
        const notFound = statusCode === 404
        markX402ServiceOutcome(invoice.invoiceId, {
          status: notFound ? 'provider_not_found' : 'provider_error',
          reason: String(error?.message || '').slice(0, 300),
          refundEligible: true,
        })
      }
      res.status(error.status || 502).json({ ok: false, mode: 'arkham', error: error.message, disclaimer: 'Informational only. Not financial advice.' })
    }
  })
}

function serviceName(routePath) {
  const label = String(routePath || 'ARCOX Intel')
    .replace(/:[^/]+/g, '')
    .replace(/\//g, ' ')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
  return label ? `${label} Intel` : 'ARCOX Intel'
}

// Structured service catalog: lists every Intel route, price, cache tier,
// required parameters, and defaults. This is a free read-only endpoint that
// helps agents discover available services without guessing.
router.get('/catalog', (_req, res) => {
  const services = getIntelCatalog().map(entry => ({
    ...entry,
    degraded: degradedForProviderPath(entry.provider),
  }))
  res.json({ ok: true, readOnly: true, services })
})

// Free circuit-breaker state per Arkham service group. Agents can check this
// before paying for a resource so they do not pay for a degraded service.
router.get('/provider-health', (_req, res) => {
  res.json({ ok: true, readOnly: true, circuits: circuitStatus() })
})

router.get('/address/:address', sendArkham(req => `/intelligence/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_ADDRESS', '0.005'))
router.get('/address/:address/all', sendArkham(req => `/intelligence/address/${encodeURIComponent(req.params.address)}/all`, 'ARCOX_INTEL_PRICE_ADDRESS_ALL', '0.01'))
router.get('/address/:address/enriched', sendArkham(req => `/intelligence/address_enriched/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_ADDRESS_ENRICHED', '0.01'))
router.get('/address/:address/balances', sendArkham(req => `/balances/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_BALANCES', '0.01'))
router.get('/address/:address/counterparties', sendArkham(req => `/counterparties/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_COUNTERPARTIES', '0.02', { limit: '100' }))
router.get('/address/:address/flows', sendArkham(req => `/flow/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_FLOWS', '0.03', { timeLast: '24h' }))
router.get('/address/:address/history', sendArkham(req => `/history/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_HISTORY', '0.03', { timeLast: '24h' }))
router.get('/address/:address/volume', sendArkham(req => `/volume/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_VOLUME', '0.03', { timeLast: '24h' }))
router.get('/address/:address/portfolio', sendArkham(req => `/portfolio/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_BALANCES', '0.01', () => ({ time: String(Date.now()) })))
router.get('/risk/address/:address/paths', sendArkham(req => `/risk/address/${encodeURIComponent(req.params.address)}/paths`, 'ARCOX_INTEL_PRICE_RISK_PATHS', '0.05'))
router.get('/risk/address/:address', sendArkham(req => `/risk/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_RISK', '0.03'))
router.get('/loans/address/:address', sendArkham(req => `/loans/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_LOANS', '0.03'))
router.get('/loans/entity/:entity', sendArkham(req => `/loans/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_LOANS_ENTITY', '0.03'))
router.get('/risk/entity/:entity', sendArkham(req => `/risk/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_RISK_ENTITY', '0.03'))
router.get('/intelligence/entity/:entity/predictions', sendArkham(req => `/intelligence/entity_predictions/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_ENTITY_PREDICTIONS', '0.03'))
router.get('/chains', sendArkham(() => '/chains', 'ARCOX_INTEL_PRICE_NETWORK', '0.005'))
router.get('/networks/status', sendArkham(() => '/networks/status', 'ARCOX_INTEL_PRICE_NETWORK', '0.005'))
router.get('/networks/history/:chain', sendArkham(req => `/networks/history/${encodeURIComponent(req.params.chain)}`, 'ARCOX_INTEL_PRICE_NETWORK_HISTORY', '0.02'))
router.get('/arkm/circulating', sendArkham(() => '/arkm/circulating', 'ARCOX_INTEL_PRICE_ARKM_CIRCULATING', '0.005'))
router.get('/marketdata/altcoin-index', sendArkham(() => '/marketdata/altcoin_index', 'ARCOX_INTEL_PRICE_ALTCOIN_INDEX', '0.01'))
router.get('/cluster/:id/summary', sendArkham(req => `/cluster/${encodeURIComponent(req.params.id)}/summary`, 'ARCOX_INTEL_PRICE_CLUSTER', '0.02'))
router.get('/tx/:hash', sendArkham(req => `/tx/${encodeURIComponent(req.params.hash)}`, 'ARCOX_INTEL_PRICE_TX', '0.005'))
router.get('/tx/:hash/transfers', sendArkham(req => `/transfers/tx/${encodeURIComponent(req.params.hash)}`, 'ARCOX_INTEL_PRICE_TX', '0.005', { chain: 'ethereum' }))
router.get('/transfers/histogram', sendArkham(() => '/transfers/histogram', 'ARCOX_INTEL_PRICE_TRANSFERS_HISTOGRAM', '0.03'))
router.get('/transfers/unenriched', sendArkham(() => '/transfers/unenriched', 'ARCOX_INTEL_PRICE_TRANSFERS_UNENRICHED', '0.03'))
router.get('/transfers', sendArkham(() => '/transfers', 'ARCOX_INTEL_PRICE_TRANSFERS', '0.03'))
router.get('/swaps', sendArkham(() => '/swaps', 'ARCOX_INTEL_PRICE_SWAPS', '0.03'))
router.get('/portfolio/time-series/address/:address', sendArkham(req => `/portfolio/timeSeries/address/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_PORTFOLIO_SERIES', '0.02'))
router.get('/portfolio/time-series/entity/:entity', sendArkham(req => `/portfolio/timeSeries/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_PORTFOLIO_SERIES', '0.02'))

// HyperCore/Hyperliquid analytics are read-only market and account data.
const hypercoreAccountServices = new Set(['active', 'perp-positions', 'portfolio-history', 'spot-balances', 'subaccounts', 'summary', 'trades'])
const hypercoreEntityServices = new Set(['active', 'perp-positions', 'portfolio-history', 'spot-balances', 'summary'])
router.get('/hypercore/markets', sendArkham(() => '/hypercore/markets', 'ARCOX_INTEL_PRICE_HYPERCORE_MARKETS', '0.02'))
router.get('/hypercore/account/:address/:service', sendArkham(req => {
  if (!hypercoreAccountServices.has(req.params.service)) throw Object.assign(new Error('Unsupported HyperCore account service'), { status: 400 })
  return `/hypercore/account/${encodeURIComponent(req.params.address)}/${req.params.service}`
}, 'ARCOX_INTEL_PRICE_HYPERCORE_ACCOUNT', '0.03'))
router.get('/hypercore/entity/:entity/:service', sendArkham(req => {
  if (!hypercoreEntityServices.has(req.params.service)) throw Object.assign(new Error('Unsupported HyperCore entity service'), { status: 400 })
  return `/hypercore/entity/${encodeURIComponent(req.params.entity)}/${req.params.service}`
}, 'ARCOX_INTEL_PRICE_HYPERCORE_ENTITY', '0.03'))
router.get('/hypercore/token/:pricingId/positions', sendArkham(req => `/hypercore/token/${encodeURIComponent(req.params.pricingId)}/positions`, 'ARCOX_INTEL_PRICE_HYPERCORE_POSITIONS', '0.03'))
router.get('/hypercore/trades/aggregate', sendArkham(() => '/hypercore/trades/aggregate', 'ARCOX_INTEL_PRICE_HYPERCORE_TRADES', '0.03'))
router.get('/hypercore/trades', sendArkham(() => '/hypercore/trades', 'ARCOX_INTEL_PRICE_HYPERCORE_TRADES', '0.03'))

// Polymarket analytics are historical/market reads; no order or trade mutation is exposed.
router.get('/polymarket/events', sendArkham(() => '/polymarket/events', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/activity', sendArkham(() => '/polymarket/activity', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/leaderboard', sendArkham(() => '/polymarket/leaderboard', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/prices', sendArkham(() => '/polymarket/prices', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/stats', sendArkham(() => '/polymarket/stats', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.02'))
router.get('/polymarket/top-events', sendArkham(() => '/polymarket/top-events', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/events/:eventId', sendArkham(req => `/polymarket/events/${encodeURIComponent(req.params.eventId)}`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/event-positions/:conditionId', sendArkham(req => `/polymarket/event-positions/${encodeURIComponent(req.params.conditionId)}`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/order-book/:conditionId', sendArkham(req => `/polymarket/order-book/${encodeURIComponent(req.params.conditionId)}`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/positions/:addr', sendArkham(req => `/polymarket/positions/${encodeURIComponent(req.params.addr)}`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/top-holders/:conditionId', sendArkham(req => `/polymarket/top-holders/${encodeURIComponent(req.params.conditionId)}`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/top-events/:eventId/breakdown', sendArkham(req => `/polymarket/top-events/${encodeURIComponent(req.params.eventId)}/breakdown`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/wallet/:addr/event-history', sendArkham(req => `/polymarket/wallet/${encodeURIComponent(req.params.addr)}/event-history`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/wallet/:addr/prediction-history', sendArkham(req => `/polymarket/wallet/${encodeURIComponent(req.params.addr)}/prediction-history`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/wallet/:addr/summary/:metric', sendArkham(req => {
  const allowed = new Set(['balance', 'biggest-win', 'pnl', 'portfolio', 'rewards', 'stats'])
  if (!allowed.has(req.params.metric)) throw Object.assign(new Error('Unsupported Polymarket wallet summary'), { status: 400 })
  return `/polymarket/wallet/${encodeURIComponent(req.params.addr)}/summary/${req.params.metric}`
}, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))
router.get('/polymarket/wallet/:addr/tags', sendArkham(req => `/polymarket/wallet/${encodeURIComponent(req.params.addr)}/tags`, 'ARCOX_INTEL_PRICE_POLYMARKET', '0.02'))
router.get('/polymarket/pnl/chart', sendArkham(() => '/polymarket/pnl/chart', 'ARCOX_INTEL_PRICE_POLYMARKET', '0.03'))

// The following tag and token metadata endpoints only retrieve Arkham data.
router.get('/tag/:id/params', sendArkham(req => `/tag/${encodeURIComponent(req.params.id)}/params`, 'ARCOX_INTEL_PRICE_TAG', '0.02'))
router.get('/tag/:id/summary', sendArkham(req => `/tag/${encodeURIComponent(req.params.id)}/summary`, 'ARCOX_INTEL_PRICE_TAG', '0.02'))
router.get('/token/arkham-exchange-tokens', sendArkham(() => '/token/arkham_exchange_tokens', 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.01'))
router.get('/token/addresses/:id', sendArkham(req => `/token/addresses/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.01'))
router.get('/token/balance/:chain/:address', sendArkham(req => `/token/balance/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_TOKEN_BALANCE', '0.02'))
router.get('/token/balance/:id', sendArkham(req => `/token/balance/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_BALANCE', '0.02'))
router.get('/token/trending/:id', sendArkham(req => `/token/trending/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.01'))
router.get('/token/:chain/:address/price-history', sendArkham(req => `/token/price/history/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_TOKEN_HISTORY', '0.02'))
router.get('/token/:chain/:address/volume', sendArkham(req => `/token/volume/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_TOKEN_VOLUME', '0.03'))

// Solana subaccount balances are reads only and are kept separate from EVM balances.
router.get('/balances/solana/subaccounts/address/:addresses', sendArkham(req => `/balances/solana/subaccounts/address/${encodeURIComponent(req.params.addresses)}`, 'ARCOX_INTEL_PRICE_SOLANA_SUBACCOUNTS', '0.02'))
router.get('/balances/solana/subaccounts/entity/:entities', sendArkham(req => `/balances/solana/subaccounts/entity/${encodeURIComponent(req.params.entities)}`, 'ARCOX_INTEL_PRICE_SOLANA_SUBACCOUNTS', '0.03'))

router.get('/search', sendArkham(() => '/intelligence/search', 'ARCOX_INTEL_PRICE_ADDRESS', '0.005'))
router.get('/contract/:chain/:address', sendArkham(req => `/intelligence/contract/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_CONTRACT', '0.01'))
router.get('/entity/:entity', sendArkham(req => `/intelligence/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_ENTITY', '0.02'))
router.get('/entity/:entity/summary', sendArkham(req => `/intelligence/entity/${encodeURIComponent(req.params.entity)}/summary`, 'ARCOX_INTEL_PRICE_ENTITY', '0.02'))
router.get('/entity/:entity/balances', sendArkham(req => `/balances/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_ENTITY', '0.02'))
router.get('/entity/:entity/counterparties', sendArkham(req => `/counterparties/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_COUNTERPARTIES', '0.02', { limit: '100' }))
router.get('/entity/:entity/flows', sendArkham(req => `/flow/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_FLOWS', '0.02', { timeLast: '24h' }))
router.get('/entity/:entity/history', sendArkham(req => `/history/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_HISTORY', '0.02', { timeLast: '24h' }))
router.get('/entity/:entity/volume', sendArkham(req => `/volume/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_VOLUME', '0.02', { timeLast: '24h' }))
router.get('/entity/:entity/portfolio', sendArkham(req => `/portfolio/entity/${encodeURIComponent(req.params.entity)}`, 'ARCOX_INTEL_PRICE_BALANCES', '0.02', () => ({ time: String(Date.now()) })))
router.get('/token/trending', sendArkham(() => '/token/trending', 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.005'))
router.get('/token/top', sendArkham(() => '/token/top', 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.005', () => ({
  timeframe: '24h',
  ...last24hWindow(),
  orderByAgg: 'volume',
  orderByDesc: 'true',
  orderByPercent: 'false',
  size: '10',
})))
router.get('/token/:chain/:address/holders', sendArkham(req => `/token/holders/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_TOKEN_HOLDERS', '0.03'))
router.get('/token/:chain/:address/top-flow', sendArkham(req => `/token/top_flow/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_TOKEN_HOLDERS', '0.03', { timeLast: '24h' }))
// Keep token-id subresources before the generic chain/address route. Without
// this order, /token/bitcoin/market is captured as chain=bitcoin,address=market.
router.get('/token/:id/market', sendArkham(req => `/token/market/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.005'))
router.get('/token/:id/holders', sendArkham(req => `/token/holders/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_HOLDERS', '0.03'))
router.get('/token/:id/top-flow', sendArkham(req => `/token/top_flow/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_HOLDERS', '0.03', { timeLast: '24h' }))
router.get('/token/:id/price-history', sendArkham(req => `/token/price/history/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_HISTORY', '0.01'))
router.get('/token/:id/price-change', sendArkham(req => `/token/price_change/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_CHANGE', '0.005'))
router.get('/token/:id/volume', sendArkham(req => `/token/volume/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_VOLUME', '0.03'))
router.get('/token/:chain/:address', sendArkham(req => `/intelligence/token/${encodeURIComponent(req.params.chain)}/${encodeURIComponent(req.params.address)}`, 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.005'))
router.get('/token/:id', sendArkham(req => `/intelligence/token/${encodeURIComponent(req.params.id)}`, 'ARCOX_INTEL_PRICE_TOKEN_BASIC', '0.005'))

router.get('/report/address/:address', paid('ARCOX_INTEL_PRICE_REPORT_ADDRESS', '0.05', async (req, res) => {
  try {
    const payload = await arkham.reportAddress(req.params.address)
    res.json(withPaymentMeta(req, payload, {
      service: 'full_wallet_report',
      serviceLabel: 'Full Wallet Report',
      resource: req.originalUrl,
      providerPath: '/report/address',
      query: { address: req.params.address },
    }))
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message, disclaimer: 'Informational only. Not financial advice.' })
  }
}))

export default router
