import { Router } from 'express'
import { ArkhamService } from '../services/arkhamService.mjs'
import { priceFromEnv, withArcoxX402 } from '../middleware/x402Middleware.mjs'
import { buildIntelPresentation } from '../services/intelPresentation.mjs'

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
router.get('/chains', sendArkham(() => '/chains', 'ARCOX_INTEL_PRICE_NETWORK', '0.005'))
router.get('/networks/status', sendArkham(() => '/networks/status', 'ARCOX_INTEL_PRICE_NETWORK', '0.005'))
router.get('/tx/:hash', sendArkham(req => `/tx/${encodeURIComponent(req.params.hash)}`, 'ARCOX_INTEL_PRICE_TX', '0.005'))
router.get('/tx/:hash/transfers', sendArkham(req => `/transfers/tx/${encodeURIComponent(req.params.hash)}`, 'ARCOX_INTEL_PRICE_TX', '0.005', { chain: 'ethereum' }))
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
