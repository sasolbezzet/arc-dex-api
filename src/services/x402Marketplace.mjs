// ARCOX x402 marketplace mirror.
//
// The Circle CLI (`circle services search/inspect/pay`) reads a public x402
// discovery directory at https://api.circle.com/v2/x402/discovery/resources
// (x402Version 2, ~2.6k paid HTTP resources from ~40 providers, USD prices in
// USDC base units per accepted chain). This module mirrors that directory into
// a local catalogue so the agent can search every listed endpoint and price
// without shelling out per query, then quote the same resource with the ARCOX
// platform fee on top.
//
// Read-only by design: mirroring a resource never grants ARCOX the right to
// call it, and no outbound payment happens here (see x402MarketplacePayment).
import { createHash } from 'crypto'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { applyPlatformFee, publicPlatformFee } from './platformFee.mjs'

// Both the source and the mirror path are resolved per call: a worker can be
// pointed at a different catalogue (tests, staging) without reimporting, and a
// long-lived process never caches a path that has since changed.
export function marketplaceDiscoveryUrl() {
  return process.env.X402_MARKETPLACE_DISCOVERY_URL || 'https://api.circle.com/v2/x402/discovery/resources'
}

export function marketplaceDbPath() {
  return process.env.X402_MARKETPLACE_DB || './x402-marketplace-db.json'
}

const MAX_AGE_MS = Number(process.env.X402_MARKETPLACE_MAX_AGE_MS || 6 * 60 * 60 * 1000)
const PAGE_SIZE = 100

// CAIP-2 network → chain label + the blockchain key the Circle CLI accepts for
// `circle services pay --chain`. Only chains the CLI can actually pay from are
// given a key; everything else stays discoverable but not payable.
const CHAINS = {
  'eip155:1': { label: 'Ethereum', cliChain: 'ETH', evmChainId: 1 },
  'eip155:10': { label: 'Optimism', cliChain: 'OP', evmChainId: 10 },
  'eip155:130': { label: 'Unichain', cliChain: 'UNI', evmChainId: 130 },
  'eip155:137': { label: 'Polygon', cliChain: 'MATIC', evmChainId: 137 },
  'eip155:143': { label: 'Monad', cliChain: 'MONAD', evmChainId: 143 },
  'eip155:146': { label: 'Sonic', cliChain: null, evmChainId: 146 },
  'eip155:196': { label: 'X Layer', cliChain: null, evmChainId: 196 },
  'eip155:480': { label: 'World Chain', cliChain: null, evmChainId: 480 },
  'eip155:999': { label: 'HyperEVM', cliChain: null, evmChainId: 999 },
  'eip155:1329': { label: 'Sei', cliChain: null, evmChainId: 1329 },
  'eip155:42161': { label: 'Arbitrum One', cliChain: 'ARB', evmChainId: 42161 },
  'eip155:43114': { label: 'Avalanche', cliChain: 'AVAX', evmChainId: 43114 },
  'eip155:8453': { label: 'Base', cliChain: 'BASE', evmChainId: 8453 },
  'eip155:5042': { label: 'Arc', cliChain: 'ARC', evmChainId: 5042 },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { label: 'Solana', cliChain: 'SOL', evmChainId: null },
}

export function chainInfo(network) {
  const known = CHAINS[String(network || '')]
  if (known) return known
  const raw = String(network || '')
  if (!raw) return { label: 'unknown', cliChain: null, evmChainId: null }
  // Unknown CAIP-2 network: keep the raw id so nothing is silently dropped.
  return { label: raw.split(':')[0] === 'solana' ? raw : `chain ${raw}`, cliChain: null, evmChainId: null }
}

/** Stable id for a resource URL. Survives listing churn and re-syncs. */
export function marketplaceId(resource) {
  return `mkt_${createHash('sha1').update(String(resource || '')).digest('hex').slice(0, 12)}`
}

function usdc(amount) {
  const units = BigInt(String(amount || '0'))
  return `${units / 1_000_000n}.${String(units % 1_000_000n).padStart(6, '0')}`
}

function priceUsdcValue(amount) {
  return Number(BigInt(String(amount || '0'))) / 1e6
}

/**
 * Which settlement rail an accept uses. Circle Gateway advertises itself as the
 * EIP-712 domain name ("GatewayWalletBatched"), vanilla USDC uses "USD Coin",
 * Permit2 is flagged in extra, and Solana uses a sponsored fee payer.
 */
export function acceptRail(accept) {
  const extra = accept?.extra || {}
  if (extra.assetTransferMethod === 'permit2') return 'permit2'
  if (String(extra.name || '') === 'GatewayWalletBatched' || extra.gateway) return 'gateway'
  if (String(accept?.network || '').startsWith('solana:')) return 'solana'
  return 'vanilla'
}

/**
 * Normalise one discovery record into the catalogue row ARCOX serves, quotes,
 * and mirrors into MCP results. Prices per accepted chain are kept as strings
 * (base units + USDC) so no float rounding reaches an invoice.
 */
export function normalizeMarketplaceItem(item) {
  const resource = String(item?.resource || '')
  const metadata = item?.metadata || {}
  const provider = metadata.provider || {}
  const accepts = (Array.isArray(item?.accepts) ? item.accepts : [])
    .filter(accept => accept && accept.amount !== undefined && accept.network)
    .map(accept => {
      const chain = chainInfo(accept.network)
      return {
        network: String(accept.network),
        chain: chain.label,
        cliChain: chain.cliChain,
        scheme: String(accept.scheme || 'exact'),
        asset: String(accept.asset || ''),
        payTo: String(accept.payTo || ''),
        amountBaseUnits: String(accept.amount),
        amountUsdc: usdc(accept.amount),
        amount: priceUsdcValue(accept.amount),
        maxTimeoutSeconds: Number(accept.maxTimeoutSeconds || 0) || null,
        rail: acceptRail(accept),
        // Kept verbatim: the EIP-712 domain (name/version) and the Gateway asset
        // list are what a payer needs to sign or batch a payment.
        extra: accept.extra || null,
      }
    })
    .sort((a, b) => a.amount - b.amount)
  const cheapest = accepts[0] || null
  const payableAccepts = accepts.filter(accept => accept.cliChain)
  const tagList = Array.isArray(provider.tags) ? provider.tags.map(tag => String(tag)) : []
  return {
    id: marketplaceId(resource),
    resource,
    type: String(item?.type || 'http'),
    x402Version: Number(item?.x402Version || 2),
    provider: String(provider.name || 'unknown'),
    providerWebsite: String(provider.website || ''),
    providerDocsUrl: String(provider.docsUrl || ''),
    providerDescription: String(provider.description || ''),
    category: String(provider.category || 'UNKNOWN'),
    tags: tagList,
    description: String(metadata.description || ''),
    method: String(metadata.method || 'GET').toUpperCase(),
    mimeType: String(metadata.mimeType || 'application/json'),
    path: String(metadata.path || ''),
    siwx: Boolean(metadata.siwx),
    supportsVanillaX402: metadata.supportsVanillax402 !== false,
    supportsCircleGateway: Boolean(metadata.supportsCircleGateway),
    input: metadata.input || null,
    priceUsdc: cheapest ? cheapest.amountUsdc : '0.000000',
    price: cheapest ? cheapest.amount : 0,
    priceBaseUnits: cheapest ? cheapest.amountBaseUnits : '0',
    accepts,
    chains: [...new Set(accepts.map(accept => accept.chain))],
    payableChains: [...new Set(payableAccepts.map(accept => accept.cliChain))],
    lastUpdated: String(item?.lastUpdated || ''),
  }
}

/** Buyers filter on payment rails, so expose the two flags as one summary. */
export function marketplaceRails(entry) {
  return entry?.supportsCircleGateway
    ? (entry.supportsVanillaX402 ? ['gateway', 'vanilla'] : ['gateway'])
    : ['vanilla']
}

function searchText(entry) {
  return [
    entry.description, entry.provider, entry.category, entry.path,
    entry.resource, entry.tags.join(' '), entry.providerDescription,
  ].join(' ').toLowerCase()
}

function searchScore(entry, terms) {
  const haystack = searchText(entry)
  let score = 0
  for (const term of terms) {
    if (entry.resource.toLowerCase().includes(term)) score += 6
    if (entry.provider.toLowerCase().includes(term)) score += 4
    if (entry.description.toLowerCase().includes(term)) score += 3
    if (entry.tags.some(tag => tag.toLowerCase() === term)) score += 4
    else if (entry.tags.some(tag => tag.toLowerCase().includes(term))) score += 2
    if (haystack.includes(term)) score += 1
  }
  if (!score) return 0
  // Cheaper resources first among equally relevant matches, then richest
  // accept list — a resource payable on more chains is easier to actually buy.
  return score * 1000 - Math.round(entry.price * 10) + Math.min(entry.accepts.length, 10) / 100
}

export function marketplaceStore() {
  const store = readJsonFile(marketplaceDbPath(), { syncedAt: '', source: marketplaceDiscoveryUrl(), items: [], total: 0 })
  const items = Array.isArray(store?.items) ? store.items : []
  return { syncedAt: String(store?.syncedAt || ''), source: String(store?.source || marketplaceDiscoveryUrl()), total: Number(store?.total || items.length), items }
}

export function loadMarketplaceCatalog({ maxAgeMs = MAX_AGE_MS } = {}) {
  const store = marketplaceStore()
  const syncedAtMs = Date.parse(store.syncedAt || '')
  const stale = !syncedAtMs || (Date.now() - syncedAtMs > maxAgeMs)
  return { ...store, stale }
}

/**
 * Pull every page of the discovery directory and write the mirror. Returns a
 * summary instead of the items so an operator (or the MCP tool) never gets a
 * multi-megabyte payload back.
 */
export async function syncMarketplaceCatalog({
  fetchImpl = globalThis.fetch,
  maxPages = Number(process.env.X402_MARKETPLACE_MAX_PAGES || 40),
  pageSize = Number(process.env.X402_MARKETPLACE_PAGE_SIZE || PAGE_SIZE),
  timeoutMs = Number(process.env.X402_MARKETPLACE_FETCH_TIMEOUT_MS || 20_000),
  url = marketplaceDiscoveryUrl(),
} = {}) {
  if (String(process.env.X402_MARKETPLACE_SYNC_DISABLED || '').toLowerCase() === 'true') {
    return { ok: false, error: 'marketplace_sync_disabled', items: 0 }
  }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable', items: 0 }
  const size = Math.max(1, Math.min(Math.floor(pageSize) || PAGE_SIZE, PAGE_SIZE))
  const items = []
  let reported = 0
  let pages = 0
  for (let page = 0; page < maxPages; page += 1) {
    const target = `${url}?limit=${size}&offset=${page * size}&siwx=false`
    let payload
    try {
      const response = await fetchImpl(target, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return { ok: false, error: `discovery_http_${response.status}`, items: items.length, pages }
      payload = await response.json()
    } catch (error) {
      return { ok: false, error: `discovery_unreachable: ${String(error?.message || error).slice(0, 160)}`, items: items.length, pages }
    }
    const page$ = Array.isArray(payload?.items) ? payload.items : []
    reported = Number(payload?.pagination?.total || reported) || reported
    for (const item of page$) items.push(normalizeMarketplaceItem(item))
    pages += 1
    if (page$.length < size) break
    if (reported && items.length >= reported) break
  }
  const syncedAt = new Date().toISOString()
  atomicWriteJsonFile(marketplaceDbPath(), { syncedAt, source: url, total: reported || items.length, items })
  return { ok: true, syncedAt, items: items.length, total: reported || items.length, pages }
}

export function searchMarketplaceCatalog({
  query = '',
  category = '',
  provider = '',
  network = '',
  maxPriceUsdc = null,
  maxPrice = null,
  gatewayOnly = false,
  payableOnly = false,
  limit = 20,
  offset = 0,
} = {}) {
  const catalog = loadMarketplaceCatalog()
  const terms = String(query || '').toLowerCase().split(/\W+/).filter(term => term.length > 1)
  const categoryFilter = String(category || '').toUpperCase()
  const providerFilter = String(provider || '').toLowerCase()
  const networkFilter = String(network || '').toLowerCase()
  const priceCap = Number(maxPriceUsdc ?? maxPrice ?? NaN)
  const cap = Number.isFinite(priceCap) ? priceCap : Infinity
  const matched = []
  for (const entry of catalog.items) {
    if (categoryFilter && entry.category !== categoryFilter) continue
    if (providerFilter && !entry.provider.toLowerCase().includes(providerFilter)) continue
    if (networkFilter && !entry.accepts.some(accept => accept.network.toLowerCase() === networkFilter
      || accept.chain.toLowerCase() === networkFilter
      || String(accept.cliChain || '').toLowerCase() === networkFilter)) continue
    if (entry.price > cap) continue
    if (gatewayOnly && !entry.supportsCircleGateway) continue
    if (payableOnly && !entry.payableChains.length) continue
    const score = terms.length ? searchScore(entry, terms) : 1
    if (!score) continue
    matched.push({ entry, score })
  }
  matched.sort((a, b) => b.score - a.score || a.entry.price - b.entry.price || a.entry.id.localeCompare(b.entry.id))
  const start = Math.max(0, Number(offset) || 0)
  const size = Math.max(1, Math.min(Number(limit) || 20, 100))
  return {
    syncedAt: catalog.syncedAt,
    total: matched.length,
    catalogTotal: catalog.items.length,
    offset: start,
    limit: size,
    items: matched.slice(start, start + size).map(row => row.entry),
  }
}

/** Resolve a resource by id, exact URL, or unique URL substring. */
export function getMarketplaceEntry(ref) {
  const raw = String(ref || '').trim()
  if (!raw) return null
  const catalog = marketplaceStore()
  if (/^mkt_[0-9a-f]{12}$/.test(raw)) return catalog.items.find(entry => entry.id === raw) || null
  const exact = catalog.items.find(entry => entry.resource === raw)
  if (exact) return exact
  const needle = raw.toLowerCase()
  const matches = catalog.items.filter(entry => entry.resource.toLowerCase().includes(needle))
  return matches.length === 1 ? matches[0] : null
}

export function marketplaceCatalogStats() {
  const catalog = loadMarketplaceCatalog()
  const categories = {}
  const providers = {}
  const networks = {}
  const buckets = { 'under_0.01': 0, '0.01_0.05': 0, '0.05_0.25': 0, '0.25_1': 0, 'over_1': 0 }
  let gateway = 0
  let vanilla = 0
  let payable = 0
  let priceSum = 0
  for (const entry of catalog.items) {
    categories[entry.category] = (categories[entry.category] || 0) + 1
    providers[entry.provider] = (providers[entry.provider] || 0) + 1
    for (const accept of entry.accepts) networks[accept.network] = (networks[accept.network] || 0) + 1
    if (entry.supportsCircleGateway) gateway += 1
    if (entry.supportsVanillaX402) vanilla += 1
    if (entry.payableChains.length) payable += 1
    priceSum += entry.price
    if (entry.price < 0.01) buckets['under_0.01'] += 1
    else if (entry.price < 0.05) buckets['0.01_0.05'] += 1
    else if (entry.price < 0.25) buckets['0.05_0.25'] += 1
    else if (entry.price < 1) buckets['0.25_1'] += 1
    else buckets.over_1 += 1
  }
  const sortEntries = object => Object.fromEntries(Object.entries(object).sort((a, b) => b[1] - a[1]))
  const count = catalog.items.length
  return {
    syncedAt: catalog.syncedAt,
    stale: catalog.stale,
    totalResources: count,
    providers: Object.keys(providers).length,
    gatewayCapable: gateway,
    vanillaOnly: count - gateway,
    payableWithCliWallet: payable,
    averagePriceUsdc: count ? Number((priceSum / count).toFixed(6)) : 0,
    priceBuckets: buckets,
    categories: sortEntries(categories),
    topProviders: Object.fromEntries(Object.entries(sortEntries(providers)).slice(0, 15)),
    networks: sortEntries(networks),
    source: catalog.source,
  }
}

/**
 * Pick the accept ARCOX would actually pay: an explicit chain wins, otherwise
 * the cheapest chain the Circle CLI can pay from. Falls back to the cheapest
 * accept overall so the buyer still sees the provider's real price.
 */
export function selectMarketplaceAccept(entry, { chain = '', network = '', rail = '' } = {}) {
  const accepts = Array.isArray(entry?.accepts) ? entry.accepts : []
  if (!accepts.length) return null
  const wantedRail = String(rail || '').toLowerCase()
  const pool = wantedRail ? accepts.filter(accept => acceptRail(accept) === wantedRail) : accepts
  const candidates = pool.length ? pool : accepts
  const wantedChain = String(chain || '').toUpperCase()
  const wantedNetwork = String(network || '').toLowerCase()
  if (wantedChain) {
    const match = candidates.find(accept => String(accept.cliChain || '').toUpperCase() === wantedChain)
      || candidates.find(accept => accept.chain.toUpperCase() === wantedChain)
    if (match) return match
  }
  if (wantedNetwork) {
    const match = candidates.find(accept => accept.network.toLowerCase() === wantedNetwork || accept.chain.toLowerCase() === wantedNetwork)
    if (match) return match
  }
  return candidates.find(accept => accept.cliChain) || candidates[0]
}

/**
 * Quote: the provider's price for the chosen rail, the ARCOX platform fee on
 * top, and what the buyer pays. `fee.bps`/`fee.amountUsdc` come from the same
 * policy module the invoice uses, so a quote can never disagree with a charge.
 */
export function marketplaceQuote(entry, { chain = '', network = '', bps, fixedUsdc, executor } = {}) {
  if (!entry) return null
  const accept = selectMarketplaceAccept(entry, { chain, network })
  const fee = applyPlatformFee(accept ? accept.amountUsdc : entry.priceUsdc, { bps, fixedUsdc })
  return {
    id: entry.id,
    resource: entry.resource,
    provider: entry.provider,
    category: entry.category,
    description: entry.description,
    method: entry.method,
    chain: accept ? accept.chain : '',
    network: accept ? accept.network : '',
    cliChain: accept ? accept.cliChain : null,
    rail: accept ? acceptRail(accept) : '',
    payable: allowPayable(accept, executor),
    gateway: Boolean(entry.supportsCircleGateway),
    payTo: accept ? accept.payTo : '',
    upstream: {
      amountUsdc: fee.netAmount,
      amountBaseUnits: fee.netBaseUnits,
    },
    platformFee: {
      bps: fee.bps,
      fixedUsdc: fee.fixedUsdc,
      amountUsdc: fee.feeAmount,
      asset: 'USDC',
      chargedOn: 'top-of-price',
    },
    totalUsdc: fee.totalAmount,
    totalAmountBaseUnits: fee.totalBaseUnits,
    quotedAt: new Date().toISOString(),
  }
}

function allowPayable(accept, executor) {
  if (!accept || !accept.cliChain) return false
  if (executor === undefined) return true
  return Boolean(executor?.configured)
}

export function marketplaceFeeConfig() {
  return publicPlatformFee({ exampleAmount: '0.10' })
}

export const MARKETPLACE_CHAIN_MAP = CHAINS
