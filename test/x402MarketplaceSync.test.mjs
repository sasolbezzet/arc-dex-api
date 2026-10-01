import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The mirror is refreshed in the background; a bug here would either hammer the
// discovery API or leave prices stale forever, so both directions are pinned.
const dir = await mkdtemp(join(tmpdir(), 'arcox-marketplace-sync-'))
process.env.X402_MARKETPLACE_DB = join(dir, 'marketplace.json')
process.env.X402_MARKETPLACE_MAX_AGE_MS = String(60 * 60 * 1000)
process.env.X402_MARKETPLACE_SYNC_ENABLED = 'true'

const { syncMarketplaceIfStale, marketplaceSyncIntervalMs, marketplaceSyncEnabled } = await import('../src/services/x402MarketplaceSyncWorker.mjs?sync-test-' + Date.now())

function entry(resource = 'https://api.example.com/x') {
  return {
    id: 'mkt_aaaaaaaaaaaa', resource, provider: 'Example', category: 'WEB_SEARCH_RESEARCH',
    description: 'x', method: 'GET', tags: [], price: 0.01, priceUsdc: '0.010000',
    accepts: [{ network: 'eip155:5042', chain: 'Arc', cliChain: 'ARC', amountUsdc: '0.010000', amount: 0.01 }],
    chains: ['Arc'], payableChains: ['ARC'], supportsCircleGateway: true, supportsVanillaX402: true,
  }
}

test('a fresh mirror is left alone', async () => {
  await writeFile(process.env.X402_MARKETPLACE_DB, JSON.stringify({ syncedAt: new Date().toISOString(), source: 'test', total: 1, items: [entry()] }))
  let fetched = 0
  globalThis.fetch = async () => { fetched += 1; return new Response('{}', { status: 200 }) }
  const result = await syncMarketplaceIfStale({ fetchImpl: globalThis.fetch })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, 'fresh')
  assert.equal(fetched, 0)
})

test('a stale or empty mirror triggers a refresh', async () => {
  await writeFile(process.env.X402_MARKETPLACE_DB, JSON.stringify({ syncedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), source: 'test', total: 0, items: [] }))
  const fetchImpl = async () => new Response(JSON.stringify({ pagination: { total: 0 }, items: [] }), { status: 200 })
  const result = await syncMarketplaceIfStale({ fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, undefined)
  assert.equal(result.items, 0)
})

test('the switch and interval come from the environment', async () => {
  assert.equal(marketplaceSyncEnabled(), true)
  process.env.X402_MARKETPLACE_SYNC_ENABLED = 'false'
  assert.equal(marketplaceSyncEnabled(), false)
  const skipped = await syncMarketplaceIfStale()
  assert.equal(skipped.skipped, 'disabled')
  // An explicit force still refreshes when the automatic path is off.
  const forced = await syncMarketplaceIfStale({ force: true, fetchImpl: async () => new Response(JSON.stringify({ pagination: { total: 0 }, items: [] }), { status: 200 }) })
  assert.equal(forced.ok, true)
  process.env.X402_MARKETPLACE_SYNC_ENABLED = 'true'

  process.env.X402_MARKETPLACE_SYNC_INTERVAL_MS = '60000'
  assert.equal(marketplaceSyncIntervalMs(), 60_000)
  process.env.X402_MARKETPLACE_SYNC_INTERVAL_MS = 'nonsense'
  assert.equal(marketplaceSyncIntervalMs(), 6 * 60 * 60 * 1000)
})
