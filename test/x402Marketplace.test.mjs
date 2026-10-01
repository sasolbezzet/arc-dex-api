import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The marketplace mirror is the buyer-facing price list: every resource keeps
// the provider's per-chain price in base units and the ARCOX platform fee is
// quoted on top, so these tests pin the normalisation and search contract.
const dir = await mkdtemp(join(tmpdir(), 'arcox-marketplace-'))
const DB = join(dir, 'marketplace.json')
process.env.X402_MARKETPLACE_DB = DB
process.env.X402_PLATFORM_FEE_BPS = '500'
process.env.X402_PLATFORM_FEE_FIXED_USDC = '0'
process.env.X402_MARKETPLACE_MAX_AGE_MS = String(24 * 60 * 60 * 1000)

const mod = await import('../src/services/x402Marketplace.mjs?marketplace-test-' + Date.now())
const {
  marketplaceId, normalizeMarketplaceItem, chainInfo, selectMarketplaceAccept,
  marketplaceQuote, marketplaceCatalogStats, searchMarketplaceCatalog,
  getMarketplaceEntry, syncMarketplaceCatalog, loadMarketplaceCatalog, marketplaceFeeConfig,
} = mod

const BASE_ACCEPT = { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x1111111111111111111111111111111111111111', amount: '200000', maxTimeoutSeconds: 300 }
const ARC_ACCEPT = { ...BASE_ACCEPT, network: 'eip155:5042', amount: '100000', payTo: '0x2222222222222222222222222222222222222222' }
const SOLANA_ACCEPT = { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: '9246XrsAEKH6hAyEQe5PvdpUL1p5Ktj9c7ySnwQn6ois', amount: '250000' }

function discoveryItem(overrides = {}) {
  return {
    resource: 'https://api.example.com/insight',
    type: 'http',
    x402Version: 2,
    lastUpdated: '2026-09-30T00:00:00.000Z',
    accepts: [BASE_ACCEPT, ARC_ACCEPT, SOLANA_ACCEPT],
    metadata: {
      provider: { name: 'Example', website: 'https://example.com', description: 'Example paid API', category: 'WEB_SEARCH_RESEARCH', tags: ['search', 'web'] },
      path: '/insight',
      method: 'POST',
      description: 'Search the web for a query',
      supportsVanillax402: true,
      supportsCircleGateway: true,
      input: { body: { type: 'object', properties: { q: { type: 'string' } } } },
    },
    ...overrides,
  }
}

test('a discovery record normalises into a priced catalogue row', () => {
  const entry = normalizeMarketplaceItem(discoveryItem())
  assert.match(entry.id, /^mkt_[0-9a-f]{12}$/)
  assert.equal(entry.id, marketplaceId('https://api.example.com/insight'))
  assert.equal(entry.provider, 'Example')
  // Cheapest accept wins the headline price; each rail keeps its own price.
  assert.equal(entry.priceUsdc, '0.100000')
  assert.deepEqual(entry.chains, ['Arc', 'Base', 'Solana'])
  assert.deepEqual(entry.payableChains, ['ARC', 'BASE', 'SOL'])
  assert.equal(entry.supportsCircleGateway, true)
  assert.equal(entry.method, 'POST')
  const arc = entry.accepts.find(accept => accept.chain === 'Arc')
  assert.equal(arc.amountBaseUnits, '100000')
  assert.equal(arc.amountUsdc, '0.100000')
  assert.equal(arc.cliChain, 'ARC')
  assert.equal(entry.input.body.properties.q.type, 'string')
})

test('a chain the CLI cannot pay from stays visible but unpayable', () => {
  assert.deepEqual(chainInfo('eip155:146'), { label: 'Sonic', cliChain: null, evmChainId: 146 })
  assert.equal(chainInfo('eip155:9999').cliChain, null)
  assert.equal(chainInfo('eip155:5042').cliChain, 'ARC')
  const entry = normalizeMarketplaceItem(discoveryItem({ accepts: [{ ...BASE_ACCEPT, network: 'eip155:146' }] }))
  assert.equal(entry.priceUsdc, '0.200000')
  assert.deepEqual(entry.payableChains, [])
  assert.equal(selectMarketplaceAccept(entry).cliChain, null)
})

test('quotes add the platform fee on top of the provider price', () => {
  const entry = normalizeMarketplaceItem(discoveryItem())
  const quote = marketplaceQuote(entry, { chain: 'ARC' })
  assert.equal(quote.chain, 'Arc')
  assert.equal(quote.cliChain, 'ARC')
  assert.equal(quote.upstream.amountUsdc, '0.100000')
  assert.equal(quote.platformFee.bps, 500)
  assert.equal(quote.platformFee.amountUsdc, '0.005000')
  assert.equal(quote.totalUsdc, '0.105000')
  assert.equal(quote.payable, true)
  assert.equal(quote.gateway, true)

  const base = marketplaceQuote(entry, { chain: 'BASE' })
  assert.equal(base.upstream.amountUsdc, '0.200000')
  assert.equal(base.totalUsdc, '0.210000')

  // No chain requested: cheapest payable rail, not the cheapest overall.
  const cheapestPayable = marketplaceQuote(entry)
  assert.equal(cheapestPayable.chain, 'Arc')

  // A disabled executor downgrades the quote to information only.
  const informational = marketplaceQuote(entry, { chain: 'ARC', executor: { configured: false } })
  assert.equal(informational.payable, false)
  assert.equal(informational.totalUsdc, '0.105000')
})

test('the fee rate is configurable per quote and reflected in the public policy', () => {
  const entry = normalizeMarketplaceItem(discoveryItem())
  const quote = marketplaceQuote(entry, { chain: 'ARC', bps: 1000, fixedUsdc: '0.001' })
  assert.equal(quote.platformFee.bps, 1000)
  assert.equal(quote.platformFee.amountUsdc, '0.011000')
  assert.equal(quote.totalUsdc, '0.111000')
  const policy = marketplaceFeeConfig()
  assert.equal(policy.bps, 500)
  assert.equal(policy.chargedOn, 'top-of-price')
  assert.equal(policy.marketplaceEnabled, true)
})

async function writeCatalog(items, syncedAt = new Date().toISOString()) {
  await writeFile(DB, JSON.stringify({ syncedAt, source: 'test', total: items.length, items }))
}

test('search filters by keyword, category, price cap, chain, and rail', async () => {
  const search = normalizeMarketplaceItem(discoveryItem())
  const prediction = normalizeMarketplaceItem(discoveryItem({
    resource: 'https://odds.example.com/markets',
    accepts: [{ ...BASE_ACCEPT, amount: '30000' }],
    metadata: { provider: { name: 'Odds', category: 'PREDICTION_MARKETS', tags: ['odds'] }, description: 'Prediction market odds', method: 'GET', supportsCircleGateway: false, supportsVanillax402: true },
  }))
  const archive = normalizeMarketplaceItem(discoveryItem({
    resource: 'https://archive.example.com/papers',
    accepts: [{ ...ARC_ACCEPT, amount: '5000000' }],
    metadata: { provider: { name: 'Archive', category: 'WEB_SEARCH_RESEARCH', tags: ['papers'] }, description: 'Academic papers search', method: 'GET' },
  }))
  await writeCatalog([search, prediction, archive])

  // "web" appears in one description and in another resource's category, so
  // the description match has to outrank the incidental category hit.
  const byKeyword = searchMarketplaceCatalog({ query: 'web' })
  assert.equal(byKeyword.total, 2)
  assert.equal(byKeyword.items[0].provider, 'Example')
  // A keyword only one resource mentions must not drag in the rest.
  const papers = searchMarketplaceCatalog({ query: 'papers' })
  assert.equal(papers.total, 1)
  assert.equal(papers.items[0].provider, 'Archive')

  const byCategory = searchMarketplaceCatalog({ category: 'prediction_markets' })
  assert.equal(byCategory.total, 1)
  assert.equal(byCategory.items[0].provider, 'Odds')

  const byPrice = searchMarketplaceCatalog({ maxPriceUsdc: 0.05 })
  assert.deepEqual(byPrice.items.map(item => item.provider), ['Odds'])

  const byChain = searchMarketplaceCatalog({ network: 'ARC' })
  assert.deepEqual(byChain.items.map(item => item.provider).sort(), ['Archive', 'Example'])

  const gatewayOnly = searchMarketplaceCatalog({ gatewayOnly: true })
  assert.ok(gatewayOnly.items.every(item => item.supportsCircleGateway))
  assert.ok(!gatewayOnly.items.some(item => item.provider === 'Odds'))

  const paged = searchMarketplaceCatalog({ limit: 1, offset: 1 })
  assert.equal(paged.items.length, 1)
  assert.equal(paged.total, 3)

  const empty = searchMarketplaceCatalog({ query: 'nothing-matches-this' })
  assert.equal(empty.total, 0)
  assert.equal(empty.catalogTotal, 3)
})

test('a stale mirror is reported as stale instead of pretending to be current', async () => {
  await writeCatalog([normalizeMarketplaceItem(discoveryItem())], new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
  const catalog = loadMarketplaceCatalog({ maxAgeMs: 60 * 60 * 1000 })
  assert.equal(catalog.stale, true)
  assert.equal(catalog.items.length, 1)
  await writeCatalog([normalizeMarketplaceItem(discoveryItem())])
  assert.equal(loadMarketplaceCatalog({ maxAgeMs: 60 * 60 * 1000 }).stale, false)
})

test('lookups resolve by id, exact URL, and unique fragment — ambiguous fragments do not', async () => {
  const example = normalizeMarketplaceItem(discoveryItem())
  const other = normalizeMarketplaceItem(discoveryItem({ resource: 'https://api.example.com/insight/premium' }))
  await writeCatalog([example, other])
  assert.equal(getMarketplaceEntry(example.id).resource, example.resource)
  assert.equal(getMarketplaceEntry('https://api.example.com/insight').id, example.id)
  assert.equal(getMarketplaceEntry('/premium').resource, other.resource)
  assert.equal(getMarketplaceEntry('/insight'), null)
  assert.equal(getMarketplaceEntry('mkt_000000000000'), null)
})

test('stats describe the mirror by provider, category, chain, and price band', async () => {
  await writeCatalog([
    normalizeMarketplaceItem(discoveryItem()),
    normalizeMarketplaceItem(discoveryItem({ resource: 'https://odds.example.com/markets', accepts: [{ ...BASE_ACCEPT, amount: '30000' }] })),
    normalizeMarketplaceItem(discoveryItem({ resource: 'https://archive.example.com/papers', accepts: [{ ...ARC_ACCEPT, amount: '5000000' }], metadata: { provider: { name: 'Archive', category: 'WEB_SEARCH_RESEARCH', tags: [] }, description: 'papers', method: 'GET' } })),
  ])
  const stats = marketplaceCatalogStats()
  assert.equal(stats.totalResources, 3)
  assert.equal(stats.providers, 2)
  assert.equal(stats.gatewayCapable, 2)
  assert.equal(stats.vanillaOnly, 1)
  assert.equal(stats.priceBuckets['under_0.01'], 0)
  assert.equal(stats.priceBuckets['0.01_0.05'], 1)
  assert.equal(stats.priceBuckets['0.05_0.25'], 1)
  assert.equal(stats.priceBuckets.over_1, 1)
  assert.equal(stats.categories.WEB_SEARCH_RESEARCH, 3)
  assert.equal(stats.networks['eip155:8453'], 2)
  assert.equal(stats.networks['eip155:5042'], 2)
  assert.equal(stats.stale, false)
})

test('sync pages through discovery and writes a compact mirror', async () => {
  const pages = [
    { pagination: { total: 3, limit: 2, offset: 0 }, items: [discoveryItem(), discoveryItem({ resource: 'https://api.example.com/two' })] },
    { pagination: { total: 3, limit: 2, offset: 2 }, items: [discoveryItem({ resource: 'https://api.example.com/three' })] },
  ]
  const requested = []
  const fetchImpl = async url => {
    requested.push(String(url))
    const page = pages.shift() || { items: [] }
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const summary = await syncMarketplaceCatalog({ fetchImpl, pageSize: 2 })
  assert.match(requested[0], /limit=2&offset=0&siwx=false/)
  assert.match(requested[1], /limit=2&offset=2&siwx=false/)
  assert.equal(summary.ok, true)
  assert.equal(summary.items, 3)
  assert.equal(summary.total, 3)
  assert.equal(summary.pages, 2)
  assert.equal(requested.length, 2)
  const stored = JSON.parse(await readFile(DB, 'utf8'))
  assert.equal(stored.items.length, 3)
  assert.equal(stored.total, 3)
  assert.ok(Date.parse(stored.syncedAt))
  assert.equal(stored.items[0].payableChains.includes('ARC'), true)
})

test('a broken discovery API leaves the previous mirror in place', async () => {
  await writeCatalog([normalizeMarketplaceItem(discoveryItem())])
  const failing = await syncMarketplaceCatalog({ fetchImpl: async () => new Response('nope', { status: 503 }) })
  assert.equal(failing.ok, false)
  assert.match(failing.error, /discovery_http_503/)
  const thrown = await syncMarketplaceCatalog({ fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /discovery_unreachable/)
  assert.equal(getMarketplaceEntry('https://api.example.com/insight').provider, 'Example')
})
