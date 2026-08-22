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

    assert.equal(requested.length, 12)
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
