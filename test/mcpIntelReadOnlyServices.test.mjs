import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EOA = '0x1111111111111111111111111111111111111111'
const MSCA = '0x2222222222222222222222222222222222222222'
const DELEGATE = '0x3333333333333333333333333333333333333333'

function responseFor(url) {
  return new Response(JSON.stringify({ ok: true, readOnly: true, requestedUrl: String(url) }), { status: 200 })
}

function resultJson(response) {
  return JSON.parse(response.content[0].text)
}

test('MCP Intel tools route read-only services and forward filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-intel-services-'))
  const previousSessionPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousBackend = process.env.ARCOX_BACKEND_URL
  const previousFetch = globalThis.fetch
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.ARCOX_BACKEND_URL = 'http://intel.test'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA, delegateAddress: DELEGATE, active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    },
    aliases: { [EOA.toLowerCase()]: MSCA },
  }), 'utf8')

  const requested = []
  globalThis.fetch = async url => {
    requested.push(String(url))
    return responseFor(url)
  }

  try {
    const { createMcpServer } = await import('../src/services/mcpServer.mjs?intel-services-' + Date.now() + '-' + Math.random())
    const server = createMcpServer(EOA)
    const tools = server._registeredTools

    const address = resultJson(await tools.arcox_intel_get_address.handler({
      address: EOA, service: 'flows', chains: 'ethereum,base', timeLast: '7d', limit: 5,
    }))
    assert.match(address.requestedUrl, /\/api\/intel\/address\/0x1111111111111111111111111111111111111111\/flows\?/)
    assert.match(address.requestedUrl, /chains=ethereum%2Cbase/)
    assert.match(address.requestedUrl, /timeLast=7d/)
    assert.match(address.requestedUrl, /limit=5/)

    const entity = resultJson(await tools.arcox_intel_get_entity.handler({ entity: 'circle', service: 'summary' }))
    assert.match(entity.requestedUrl, /\/api\/intel\/entity\/circle\/summary$/)

    const token = resultJson(await tools.arcox_intel_get_token.handler({ id: 'BTC', service: 'market' }))
    assert.match(token.requestedUrl, /\/api\/intel\/token\/bitcoin\/market$/)

    const holders = resultJson(await tools.arcox_intel_get_token.handler({ id: 'USDC', service: 'holders', groupByEntity: true, limit: 10 }))
    assert.match(holders.requestedUrl, /\/api\/intel\/token\/usd-coin\/holders\?/)
    assert.match(holders.requestedUrl, /groupByEntity=true/)
    assert.match(holders.requestedUrl, /limit=10/)

    const balances = resultJson(await tools.arcox_intel_get_balances.handler({ target: 'address', address: EOA, chains: 'ethereum' }))
    assert.match(balances.requestedUrl, /\/api\/intel\/address\/0x1111111111111111111111111111111111111111\/balances\?chains=ethereum$/)

    const portfolio = resultJson(await tools.arcox_intel_get_portfolio.handler({ address: EOA, time: '1704067200000' }))
    assert.match(portfolio.requestedUrl, /\/api\/intel\/address\/0x1111111111111111111111111111111111111111\/portfolio\?time=1704067200000$/)

    const search = resultJson(await tools.arcox_intel_search.handler({ query: 'circle', arkhamEntities: 2, tokens: 3 }))
    assert.match(search.requestedUrl, /\/api\/intel\/search\?/)
    assert.match(search.requestedUrl, /query=circle/)
    assert.match(search.requestedUrl, /arkhamEntities=2/)
    assert.match(search.requestedUrl, /tokens=3/)

    const flows = resultJson(await tools.arcox_intel_get_flows.handler({ address: EOA, timeLast: '24h', limit: 25 }))
    assert.match(flows.requestedUrl, /\/api\/intel\/address\/0x1111111111111111111111111111111111111111\/flows\?/)
    assert.match(flows.requestedUrl, /timeLast=24h/)
    assert.match(flows.requestedUrl, /limit=25/)

    const history = resultJson(await tools.arcox_intel_get_history.handler({ address: EOA, target: 'address', chains: 'base' }))
    assert.match(history.requestedUrl, /\/api\/intel\/address\/0x1111111111111111111111111111111111111111\/history\?chains=base$/)

    const volume = resultJson(await tools.arcox_intel_get_volume.handler({ entity: 'circle', target: 'entity', timeLast: '7d' }))
    assert.match(volume.requestedUrl, /\/api\/intel\/entity\/circle\/volume\?timeLast=7d$/)

    const counterparties = resultJson(await tools.arcox_intel_get_counterparties.handler({ address: EOA, limit: 10 }))
    assert.match(counterparties.requestedUrl, /\/api\/intel\/address\/0x1111111111111111111111111111111111111111\/counterparties\?limit=10$/)

    const transfers = resultJson(await tools.arcox_intel_get_transfers.handler({ hash: '0x' + 'a'.repeat(64), chain: 'ethereum', transferType: 'token' }))
    assert.match(transfers.requestedUrl, /\/api\/intel\/tx\/0x[a]{64}\/transfers\?/)
    assert.match(transfers.requestedUrl, /chain=ethereum/)
    assert.match(transfers.requestedUrl, /transferType=token/)

    const priceHistory = resultJson(await tools.arcox_intel_get_token.handler({ id: 'BTC', service: 'price-history', daily: true }))
    assert.match(priceHistory.requestedUrl, /\/api\/intel\/token\/bitcoin\/price-history\?daily=true$/)

    const priceChange = resultJson(await tools.arcox_intel_get_token.handler({ id: 'ETH', service: 'price-change', pastTime: '2025-01-01T00:00:00Z' }))
    assert.match(priceChange.requestedUrl, /\/api\/intel\/token\/ethereum\/price-change\?pastTime=/)

    const tokenVolume = resultJson(await tools.arcox_intel_get_token.handler({ id: 'USDC', service: 'volume', granularity: '1h', timeLast: '24h' }))
    assert.match(tokenVolume.requestedUrl, /\/api\/intel\/token\/usd-coin\/volume\?/)
    assert.match(tokenVolume.requestedUrl, /granularity=1h/)
    assert.match(tokenVolume.requestedUrl, /timeLast=24h/)

    const risk = resultJson(await tools.arcox_intel_get_risk.handler({ address: EOA }))
    assert.match(risk.requestedUrl, /\/api\/intel\/risk\/address\/0x1111111111111111111111111111111111111111$/)

    const riskPaths = resultJson(await tools.arcox_intel_get_risk.handler({ address: EOA, service: 'paths' }))
    assert.match(riskPaths.requestedUrl, /\/api\/intel\/risk\/address\/0x1111111111111111111111111111111111111111\/paths$/)

    const loans = resultJson(await tools.arcox_intel_get_loans.handler({ address: EOA, chains: 'ethereum,arbitrum_one' }))
    assert.match(loans.requestedUrl, /\/api\/intel\/loans\/address\/0x1111111111111111111111111111111111111111\?chains=ethereum%2Carbitrum_one$/)

    const network = resultJson(await tools.arcox_intel_get_network.handler({ service: 'status' }))
    assert.match(network.requestedUrl, /\/api\/intel\/networks\/status$/)

    const chains = resultJson(await tools.arcox_intel_get_network.handler({ service: 'chains' }))
    assert.match(chains.requestedUrl, /\/api\/intel\/chains$/)

    assert.equal(requested.length, 20)
  } finally {
    globalThis.fetch = previousFetch
    if (previousSessionPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousSessionPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousBackend === undefined) delete process.env.ARCOX_BACKEND_URL
    else process.env.ARCOX_BACKEND_URL = previousBackend
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP Intel P2 tools expose remaining Arkham read-only datasets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-intel-p2-'))
  const previousSessionPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousBackend = process.env.ARCOX_BACKEND_URL
  const previousFetch = globalThis.fetch
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.ARCOX_BACKEND_URL = 'http://intel.test'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA, delegateAddress: DELEGATE, active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    },
    aliases: { [EOA.toLowerCase()]: MSCA },
  }), 'utf8')

  const requested = []
  globalThis.fetch = async url => {
    requested.push(String(url))
    return responseFor(url)
  }

  try {
    const { createMcpServer } = await import('../src/services/mcpServer.mjs?intel-p2-' + Date.now() + '-' + Math.random())
    const tools = createMcpServer(EOA)._registeredTools

    const tokenAddresses = resultJson(await tools.arcox_intel_get_token.handler({ id: 'USDC', service: 'addresses' }))
    assert.match(tokenAddresses.requestedUrl, /\/api\/intel\/token\/addresses\/usd-coin$/)
    const tokenBalance = resultJson(await tools.arcox_intel_get_token.handler({ id: 'USDC', service: 'balance', address: EOA }))
    assert.match(tokenBalance.requestedUrl, /\/api\/intel\/token\/balance\/usd-coin\?address=0x1111111111111111111111111111111111111111$/)
    const contractHistory = resultJson(await tools.arcox_intel_get_token.handler({ service: 'price-history-contract', chain: 'ethereum', address: EOA, daily: true }))
    assert.match(contractHistory.requestedUrl, /\/api\/intel\/token\/ethereum\/0x1111111111111111111111111111111111111111\/price-history\?daily=true$/)
    const contractVolume = resultJson(await tools.arcox_intel_get_token.handler({ service: 'volume-contract', chain: 'ethereum', address: EOA, granularity: '1h', timeLast: '24h' }))
    assert.match(contractVolume.requestedUrl, /\/api\/intel\/token\/ethereum\/0x1111111111111111111111111111111111111111\/volume\?granularity=1h&timeLast=24h$/)

    const entityPredictions = resultJson(await tools.arcox_intel_get_entity.handler({ entity: 'circle', service: 'predictions' }))
    assert.match(entityPredictions.requestedUrl, /\/api\/intel\/intelligence\/entity\/circle\/predictions$/)
    const entityRisk = resultJson(await tools.arcox_intel_get_risk.handler({ entity: 'circle', service: 'entity' }))
    assert.match(entityRisk.requestedUrl, /\/api\/intel\/risk\/entity\/circle$/)
    const entityLoans = resultJson(await tools.arcox_intel_get_loans.handler({ target: 'entity', entity: 'circle', chains: 'ethereum' }))
    assert.match(entityLoans.requestedUrl, /\/api\/intel\/loans\/entity\/circle\?chains=ethereum$/)

    const globalTransfers = resultJson(await tools.arcox_intel_get_global_transfers.handler({ service: 'transfers', base: EOA, chains: 'ethereum', limit: 10 }))
    assert.match(globalTransfers.requestedUrl, /\/api\/intel\/transfers\?/)
    assert.match(globalTransfers.requestedUrl, /base=0x1111111111111111111111111111111111111111/)
    const histogram = resultJson(await tools.arcox_intel_get_global_transfers.handler({ service: 'histogram', base: EOA, granularity: '1h' }))
    assert.match(histogram.requestedUrl, /\/api\/intel\/transfers\/histogram\?/)
    const swaps = resultJson(await tools.arcox_intel_get_swaps.handler({ base: EOA, chains: 'ethereum', limit: 5 }))
    assert.match(swaps.requestedUrl, /\/api\/intel\/swaps\?/)

    const series = resultJson(await tools.arcox_intel_get_portfolio_series.handler({ address: EOA, pricingId: 'ethereum', chains: 'ethereum' }))
    assert.match(series.requestedUrl, /\/api\/intel\/portfolio\/time-series\/address\/0x1111111111111111111111111111111111111111\?pricingId=ethereum&chains=ethereum$/)
    const market = resultJson(await tools.arcox_intel_get_market.handler({ service: 'network-history', chain: 'ethereum' }))
    assert.match(market.requestedUrl, /\/api\/intel\/networks\/history\/ethereum$/)
    const cluster = resultJson(await tools.arcox_intel_get_market.handler({ service: 'cluster-summary', id: 'cluster-1' }))
    assert.match(cluster.requestedUrl, /\/api\/intel\/cluster\/cluster-1\/summary$/)
    const solana = resultJson(await tools.arcox_intel_get_solana_subaccounts.handler({ addresses: 'SolanaAddress', pricingID: 'usd-coin' }))
    assert.match(solana.requestedUrl, /\/api\/intel\/balances\/solana\/subaccounts\/address\/SolanaAddress\?pricingID=usd-coin$/)

    const hyperMarkets = resultJson(await tools.arcox_intel_get_hypercore.handler({ service: 'markets' }))
    assert.match(hyperMarkets.requestedUrl, /\/api\/intel\/hypercore\/markets$/)
    const hyperAccount = resultJson(await tools.arcox_intel_get_hypercore.handler({ service: 'account', accountService: 'summary', address: EOA }))
    assert.match(hyperAccount.requestedUrl, /\/api\/intel\/hypercore\/account\/0x1111111111111111111111111111111111111111\/summary$/)
    const hyperToken = resultJson(await tools.arcox_intel_get_hypercore.handler({ service: 'token-positions', pricingId: 'bitcoin', limit: 10 }))
    assert.match(hyperToken.requestedUrl, /\/api\/intel\/hypercore\/token\/bitcoin\/positions\?limit=10$/)
    const hyperTrades = resultJson(await tools.arcox_intel_get_hypercore.handler({ service: 'trades-aggregate', product: 'perp', interval: '1h' }))
    assert.match(hyperTrades.requestedUrl, /\/api\/intel\/hypercore\/trades\/aggregate\?product=perp&interval=1h$/)

    const polyEvents = resultJson(await tools.arcox_intel_get_polymarket.handler({ service: 'events', active: true, limit: 10 }))
    assert.match(polyEvents.requestedUrl, /\/api\/intel\/polymarket\/events\?active=true&limit=10$/)
    const polyPositions = resultJson(await tools.arcox_intel_get_polymarket.handler({ service: 'positions', address: EOA, limit: 5 }))
    assert.match(polyPositions.requestedUrl, /\/api\/intel\/polymarket\/positions\/0x1111111111111111111111111111111111111111\?limit=5$/)
    const polySummary = resultJson(await tools.arcox_intel_get_polymarket.handler({ service: 'wallet-summary', address: EOA, metric: 'pnl' }))
    assert.match(polySummary.requestedUrl, /\/api\/intel\/polymarket\/wallet\/0x1111111111111111111111111111111111111111\/summary\/pnl$/)
    assert.equal(requested.length, 21)
  } finally {
    globalThis.fetch = previousFetch
    if (previousSessionPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousSessionPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousBackend === undefined) delete process.env.ARCOX_BACKEND_URL
    else process.env.ARCOX_BACKEND_URL = previousBackend
    await rm(dir, { recursive: true, force: true })
  }
})

test('Intel read-only module does not invoke transaction execution', () => {
  const source = readFileSync(new URL('../src/services/mcp/intelTools.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /executeViaSession/)
  assert.doesNotMatch(source, /functionName:\s*['"](?:swap|bridge|send|approve)['"]/)
})
