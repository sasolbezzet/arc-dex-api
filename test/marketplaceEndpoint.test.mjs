import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Endpoint contract for the x402 marketplace mirror. Discovery and quoting are
// free on purpose (any agent must be able to see a price before paying), while
// buying is x402-invoiced and refuses to run without a configured outbound
// payment executor.
const OWNER = '0xe43007a7f4a01f020f9ee11cabcd880f0ea25aa9'
const AUTH_SECRET = 'test-marketplace-secret'
const RESOURCE = 'https://odds.example.com/markets'

function ownerToken(address) {
  const payload = Buffer.from(JSON.stringify({ address: address.toLowerCase(), exp: Date.now() + 60_000 })).toString('base64url')
  const signature = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function accept(network, chain, cliChain, amountBaseUnits, amountUsdc) {
  return {
    network, chain, cliChain, scheme: 'exact',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x6302D9e6DBB22fEC3c350551568Bb39B4b35Ad57',
    amountBaseUnits, amountUsdc, amount: Number(amountUsdc), maxTimeoutSeconds: 300,
  }
}

const CATALOG_ITEMS = [
  {
    id: 'mkt_aaaaaaaaaaaa',
    resource: RESOURCE,
    type: 'http',
    x402Version: 2,
    provider: 'Odds Co',
    providerWebsite: 'https://odds.example.com',
    providerDocsUrl: '',
    providerDescription: '',
    category: 'PREDICTION_MARKETS',
    tags: ['odds', 'markets'],
    description: 'Prediction market odds',
    method: 'GET',
    mimeType: 'application/json',
    path: '/markets',
    siwx: false,
    supportsVanillaX402: true,
    supportsCircleGateway: true,
    input: null,
    priceUsdc: '0.100000',
    price: 0.1,
    priceBaseUnits: '100000',
    accepts: [
      accept('eip155:5042', 'Arc', 'ARC', '100000', '0.100000'),
      accept('eip155:8453', 'Base', 'BASE', '200000', '0.200000'),
    ],
    chains: ['Arc', 'Base'],
    payableChains: ['ARC', 'BASE'],
    lastUpdated: '2026-09-30T00:00:00.000Z',
  },
  {
    id: 'mkt_bbbbbbbbbbbb',
    resource: 'https://api.example.com/insight',
    type: 'http',
    x402Version: 2,
    provider: 'Example',
    providerWebsite: '',
    providerDocsUrl: '',
    providerDescription: '',
    category: 'WEB_SEARCH_RESEARCH',
    tags: ['search'],
    description: 'Search the web for a query',
    method: 'POST',
    mimeType: 'application/json',
    path: '/insight',
    siwx: false,
    supportsVanillaX402: true,
    supportsCircleGateway: false,
    input: null,
    priceUsdc: '0.030000',
    price: 0.03,
    priceBaseUnits: '30000',
    accepts: [accept('eip155:146', 'Sonic', null, '30000', '0.030000')],
    chains: ['Sonic'],
    payableChains: [],
    lastUpdated: '2026-09-30T00:00:00.000Z',
  },
]

async function withHttp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-marketplace-http-'))
  const names = [
    'VERCEL', 'AUTH_SECRET', 'ARC_NETWORK', 'CIRCLE_API_KEY', 'CIRCLE_API_KEY_MAINNET',
    'CIRCLE_CLIENT_URL', 'CIRCLE_CLIENT_KEY', 'CIRCLE_CLIENT_KEY_LIVE',
    'CIRCLE_ENTITY_SECRET', 'CIRCLE_ENTITY_SECRET_MAINNET',
    'SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH', 'VAULT_ACTIVITY_PATH',
    'VAULT_SESSION_PATH', 'OAUTH_PATH', 'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH',
    'WALLET_DB', 'TX_HISTORY_DB', 'INVOICE_DB', 'WEBHOOK_DB', 'AUTO_MINT_DB',
    'SERVER_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PERSISTENCE_MODE',
    'X402_PLATFORM_FEE_BPS', 'X402_PLATFORM_FEE_FIXED_USDC', 'X402_PLATFORM_FEE_SERVICES_ENABLED',
    'X402_MARKETPLACE_DB', 'X402_MARKETPLACE_EXECUTOR', 'X402_MARKETPLACE_PAYER_ADDRESS',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.VERCEL = '1'
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ARC_NETWORK = 'mainnet'
  process.env.CIRCLE_CLIENT_URL = 'https://circle.test/v1/rpc/w3s/buidl'
  process.env.CIRCLE_CLIENT_KEY = 'test-circle-client-key'
  process.env.CIRCLE_CLIENT_KEY_LIVE = 'live-circle-client-key'
  process.env.CIRCLE_API_KEY = 'TEST_API_KEY:test:test'
  process.env.CIRCLE_API_KEY_MAINNET = 'LIVE_API_KEY:test:test'
  process.env.CIRCLE_ENTITY_SECRET = 'a'.repeat(64)
  process.env.CIRCLE_ENTITY_SECRET_MAINNET = 'b'.repeat(64)
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  process.env.OAUTH_PATH = join(dir, 'oauth-clients.json')
  process.env.OAUTH_TOKENS_PATH = join(dir, 'oauth-tokens.json')
  process.env.OAUTH_STATE_PATH = join(dir, 'oauth-state.json')
  process.env.WALLET_DB = join(dir, 'wallets.json')
  process.env.TX_HISTORY_DB = join(dir, 'tx-history.json')
  process.env.INVOICE_DB = join(dir, 'invoices.json')
  process.env.WEBHOOK_DB = join(dir, 'webhooks.json')
  process.env.AUTO_MINT_DB = join(dir, 'auto-mint.json')
  process.env.SERVER_URL = 'https://arcoxdex.vercel.app'
  process.env.SUPABASE_URL = ''
  process.env.SUPABASE_SERVICE_ROLE_KEY = ''
  process.env.SUPABASE_PERSISTENCE_MODE = 'off'
  process.env.X402_PLATFORM_FEE_BPS = '500'
  process.env.X402_PLATFORM_FEE_FIXED_USDC = '0'
  process.env.X402_PLATFORM_FEE_SERVICES_ENABLED = 'false'
  process.env.X402_MARKETPLACE_DB = join(dir, 'marketplace.json')
  process.env.X402_MARKETPLACE_EXECUTOR = 'disabled'
  delete process.env.X402_MARKETPLACE_PAYER_ADDRESS

  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {}, agentBindings: {} }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {} }))
  await writeFile(process.env.TX_HISTORY_DB, JSON.stringify({}))
  await writeFile(process.env.X402_MARKETPLACE_DB, JSON.stringify({
    syncedAt: new Date().toISOString(),
    source: 'https://api.circle.com/v2/x402/discovery/resources',
    total: CATALOG_ITEMS.length,
    items: CATALOG_ITEMS,
  }))

  const previousFetch = globalThis.fetch
  let localBase = ''
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(localBase)) return previousFetch(url, init)
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const { app } = await import('../server.mjs?marketplace-http-' + Date.now() + '-' + Math.random())
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      localBase = `http://127.0.0.1:${listener.address().port}`
      const call = async (path, { method = 'GET', headers = {}, body } = {}) => {
        const response = await previousFetch(`${localBase}${path}`, {
          method,
          headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        return { status: response.status, body: await response.json().catch(() => ({})) }
      }
      await fn({ call, get: path => call(path), post: (path, body, headers) => call(path, { method: 'POST', body, headers }), token: ownerToken(OWNER) })
    } finally {
      await new Promise(resolve => listener.close(resolve))
    }
  } finally {
    globalThis.fetch = previousFetch
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('the catalogue is free to search and shows provider prices', async () => {
  await withHttp(async ({ get }) => {
    const { status, body } = await get('/api/marketplace/catalog')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.catalogTotal, 2)
    assert.equal(body.platformFee.bps, 500)
    assert.equal(body.platformFee.chargedOn, 'top-of-price')
    // No query given: cheapest resource first, so the 0.03 USDC service leads.
    assert.deepEqual(body.items.map(item => item.provider), ['Example', 'Odds Co'])
    assert.equal(body.items[1].payableChains.length, 2, 'rantai yang bisa dibayar ikut terlihat')
    assert.equal(body.items[1].payableChains.includes('ARC'), true)
    assert.deepEqual(body.items[0].payableChains, [], 'rantai yang tidak bisa dibayar CLI tetap jujur dilaporkan')
  })
})

test('the catalogue filters by keyword, category, chain, and price', async () => {
  await withHttp(async ({ get }) => {
    const odds = await get('/api/marketplace/catalog?q=odds&category=PREDICTION_MARKETS&maxPriceUsdc=0.15')
    assert.equal(odds.body.total, 1)
    assert.equal(odds.body.items[0].id, 'mkt_aaaaaaaaaaaa')

    const arc = await get('/api/marketplace/catalog?network=ARC&payableOnly=true')
    assert.deepEqual(arc.body.items.map(item => item.id), ['mkt_aaaaaaaaaaaa'])

    const none = await get('/api/marketplace/catalog?q=no-such-service')
    assert.equal(none.body.total, 0)
  })
})

test('a quote shows the provider price, the platform fee, and the total', async () => {
  await withHttp(async ({ get }) => {
    const { status, body } = await get(`/api/marketplace/quote?resource=${encodeURIComponent(RESOURCE)}`)
    assert.equal(status, 200)
    assert.equal(body.quote.upstream.amountUsdc, '0.100000')
    assert.equal(body.quote.platformFee.bps, 500)
    assert.equal(body.quote.platformFee.amountUsdc, '0.005000')
    assert.equal(body.quote.totalUsdc, '0.105000')
    assert.equal(body.quote.chain, 'Arc')
    // The executor is off, so the quote is explicitly informational.
    assert.equal(body.quote.payable, false)
    assert.equal(body.executor.configured, false)
    assert.deepEqual(body.executor.problems, ['executor_disabled'])

    const base = await get(`/api/marketplace/quote?resource=mkt_aaaaaaaaaaaa&chain=BASE`)
    assert.equal(base.body.quote.upstream.amountUsdc, '0.200000')
    assert.equal(base.body.quote.totalUsdc, '0.210000')

    const missing = await get('/api/marketplace/quote?resource=mkt_000000000000')
    assert.equal(missing.status, 404)
  })
})

test('stats expose the mirror size, price bands, and executor state', async () => {
  await withHttp(async ({ get }) => {
    const { status, body } = await get('/api/marketplace/stats')
    assert.equal(status, 200)
    assert.equal(body.stats.totalResources, 2)
    assert.equal(body.stats.providers, 2)
    assert.equal(body.stats.gatewayCapable, 1)
    assert.equal(body.stats.payableWithCliWallet, 1)
    assert.equal(body.stats.priceBuckets['0.05_0.25'], 1)
    assert.equal(body.executor.mode, 'disabled')
  })
})

test('refreshing the mirror requires an authenticated owner session', async () => {
  await withHttp(async ({ post, token }) => {
    const anonymous = await post('/api/marketplace/sync', {})
    assert.equal(anonymous.status, 401)
    // A well-formed token still needs an active MSCA session, and this test
    // fixture has none, so the guard stays closed.
    const unauthenticated = await post('/api/marketplace/sync', {}, { Authorization: `Bearer ${token}` })
    assert.equal(unauthenticated.status, 401)
  })
})

test('buying through the marketplace is refused until a payment executor is configured', async () => {
  await withHttp(async ({ post, token }) => {
    const { status, body } = await post('/api/marketplace/call', { resource: 'mkt_aaaaaaaaaaaa' }, { Authorization: `Bearer ${token}`, 'X-Arcox-Owner': OWNER })
    assert.equal(status, 503)
    assert.equal(body.ok, false)
    assert.equal(body.executor.configured, false)
    assert.match(body.error, /executor is not configured/)
  })
})

test('the x402 config advertises the platform fee policy', async () => {
  await withHttp(async ({ get }) => {
    const { status, body } = await get('/api/x402/config')
    assert.equal(status, 200)
    assert.equal(body.config.platformFee.bps, 500)
    assert.equal(body.config.platformFee.percent, 5)
    assert.equal(body.config.platformFee.servicesEnabled, false)
    assert.equal(body.config.platformFee.marketplaceEnabled, true)
    assert.equal(body.config.platformFee.chargedOn, 'top-of-price')
  })
})

test('the OpenAPI document documents the marketplace surface and fee', async () => {
  await withHttp(async ({ get }) => {
    const { status, body } = await get('/api/x402/openapi.json')
    assert.equal(status, 200)
    assert.ok(body.paths['/api/marketplace/catalog'])
    assert.ok(body.paths['/api/marketplace/quote'])
    assert.ok(body.paths['/api/marketplace/call'])
    assert.equal(body['x-arcox-pricing'].platformFee.bps, 500)
  })
})
