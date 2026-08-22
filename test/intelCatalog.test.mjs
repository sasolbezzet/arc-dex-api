import test from 'node:test'
import assert from 'node:assert/strict'
import { getIntelCatalog, cacheTtlForPath, getCacheTtlMap } from '../src/services/intelCatalog.mjs'

test('Intel catalog returns structured service list with prices and cache tiers', () => {
  const catalog = getIntelCatalog()
  assert.ok(catalog.length > 30, 'catalog should have many entries')
  for (const entry of catalog) {
    assert.ok(entry.route, 'each entry has a route')
    assert.ok(entry.service, 'each entry has a service name')
    assert.ok(entry.price, 'each entry has a price')
    assert.ok(entry.cacheTier, 'each entry has a cache tier')
    assert.equal(entry.readOnly, true, 'all entries are read-only')
    assert.ok(Array.isArray(entry.required), 'each entry has required params')
  }
})

test('cacheTtlForPath returns correct TTL for known paths', () => {
  assert.equal(cacheTtlForPath('/chains'), 3600, 'chains should be static tier (1h)')
  assert.equal(cacheTtlForPath('/arkm/circulating'), 3600, 'arkm circulating should be static tier (1h)')
  assert.equal(cacheTtlForPath('/networks/status'), 1800, 'network status should be slow tier (30m)')
  assert.equal(cacheTtlForPath('/risk/address/0x123'), 1800, 'risk should be slow tier (30m)')
  assert.equal(cacheTtlForPath('/flow/address/0x123'), 120, 'flows should be dynamic tier (2m)')
  assert.equal(cacheTtlForPath('/transfers'), 120, 'transfers should be dynamic tier (2m)')
  assert.equal(cacheTtlForPath('/swaps'), 120, 'swaps should be dynamic tier (2m)')
  assert.equal(cacheTtlForPath('/balances/address/0x123'), 600, 'balances should be default tier (10m)')
})

test('cacheTtlForPath falls back to default for unknown paths', () => {
  assert.equal(cacheTtlForPath('/unknown/path'), 600, 'unknown paths default to 10m')
  assert.equal(cacheTtlForPath(''), 600, 'empty path defaults to 10m')
  assert.equal(cacheTtlForPath(null), 600, 'null path defaults to 10m')
})

test('getCacheTtlMap returns a lookup object', () => {
  const map = getCacheTtlMap()
  assert.ok(typeof map === 'object')
  assert.ok(Object.keys(map).length > 0)
  assert.equal(map['/chains'], 3600)
  assert.equal(map['/transfers'], 120)
})

test('catalog includes all major service categories', () => {
  const catalog = getIntelCatalog()
  const services = catalog.map(e => e.service).join(' ')
  assert.match(services, /Address Intelligence/)
  assert.match(services, /Risk Score/)
  assert.match(services, /HyperCore/)
  assert.match(services, /Polymarket/)
  assert.match(services, /Global Transfers/)
  assert.match(services, /Historical Swaps/)
  assert.match(services, /Portfolio Time Series/)
  assert.match(services, /Solana Subaccounts/)
  assert.match(services, /ARKM Circulating/)
})
