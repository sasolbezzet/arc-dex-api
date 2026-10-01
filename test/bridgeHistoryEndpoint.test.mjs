import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Endpoint-level guard for the Agent Wallet (MSCA) bridge history: the rows are
// derived from owner-scoped bridge approvals and are merged into /api/tx-history
// so the web history panel and the MCP tools see the same data.
const OWNER = '0xe43007a7f4a01f020f9ee11cabcd880f0ea25aa9'
const MSCA = '0x08223b59f3Dc0135500Fbc62d5537A5c501cf017'
const OTHER_WALLET = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x9999999999999999999999999999999999999999'
const AUTH_SECRET = 'test-bridge-history-secret'
const BURN_ARC_TO_ARB = '0x' + 'a'.repeat(64)
const BURN_ARB_TO_ARC = '0x' + 'b'.repeat(64)
const BURN_OTHER_WALLET = '0x' + 'c'.repeat(64)
const MINT_BASE_TO_ARC = '0x' + 'd'.repeat(64)

function ownerToken(address) {
  const payload = Buffer.from(JSON.stringify({ address: address.toLowerCase(), exp: Date.now() + 60_000 })).toString('base64url')
  const signature = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function bridgeApproval({ id, owner = OWNER, amount, fromChain, toChain, sourceChainKey, destinationChainKey, burnTxHash, mintTxHash, walletAddress = MSCA, status = 'success', settlementStatus = 'success', settlementPhase = 'destination_minted', safeToRetry, agent = 'mcp-agent', createdAt }) {
  return {
    id,
    owner,
    agent,
    action: 'bridge',
    amount,
    token: 'USDC',
    source: 'session',
    to: '',
    status,
    createdAt,
    details: JSON.stringify({
      fromChain,
      toChain,
      amount,
      sourceChainKey,
      destinationChainKey,
      burnTxHash,
      ...(mintTxHash ? { mintTxHash } : {}),
      walletAddress,
      settlementStatus,
      settlementPhase,
      ...(safeToRetry === undefined ? {} : { safeToRetry }),
    }),
  }
}

async function withHttp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-bridge-history-'))
  const names = [
    'VERCEL', 'AUTH_SECRET', 'ARC_NETWORK', 'CIRCLE_API_KEY', 'CIRCLE_API_KEY_MAINNET',
    'CIRCLE_CLIENT_URL', 'CIRCLE_CLIENT_KEY', 'CIRCLE_CLIENT_KEY_LIVE',
    'CIRCLE_ENTITY_SECRET', 'CIRCLE_ENTITY_SECRET_MAINNET',
    'SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH', 'VAULT_ACTIVITY_PATH',
    'VAULT_SESSION_PATH', 'OAUTH_PATH', 'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH',
    'WALLET_DB', 'TX_HISTORY_DB', 'INVOICE_DB', 'WEBHOOK_DB', 'AUTO_MINT_DB',
    'SERVER_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PERSISTENCE_MODE',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.VERCEL = '1'
  process.env.AUTH_SECRET = AUTH_SECRET
  // Mainnet so the records must resolve to the mainnet chain labels/explorers.
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

  const approvalRows = [
    // Executed Arc → Arbitrum bridge of yesterday's verification run.
    bridgeApproval({ id: 'executed-arc-arb', amount: '0.02', fromChain: 'Arc', toChain: 'Arbitrum', sourceChainKey: 'arc-mainnet', destinationChainKey: 'arbitrum-mainnet', burnTxHash: BURN_ARC_TO_ARB, createdAt: 1_790_782_800_000 }),
    // Healed intent that points at the same burn: must collapse into one row.
    bridgeApproval({ id: 'healed-arc-arb', amount: '0.01', fromChain: 'Arc', toChain: 'Arbitrum', sourceChainKey: 'arc-mainnet', destinationChainKey: 'arbitrum-mainnet', burnTxHash: BURN_ARC_TO_ARB, status: 'error', settlementStatus: 'success', settlementPhase: 'destination_minted', agent: 'Grok', createdAt: 1_790_751_600_000 }),
    // In-flight Arbitrum → Arc burn whose destination mint is still unknown.
    bridgeApproval({ id: 'pending-arb-arc', amount: '0.015', fromChain: 'Arbitrum', toChain: 'Arc', sourceChainKey: 'arbitrum-mainnet', destinationChainKey: 'arc-mainnet', burnTxHash: BURN_ARB_TO_ARC, status: 'error', settlementStatus: 'pending', settlementPhase: 'submission_unknown', safeToRetry: false, createdAt: 1_790_782_900_000 }),
    // Another Agent Wallet of the same owner: only visible without a wallet filter.
    bridgeApproval({ id: 'other-wallet', amount: '0.004', fromChain: 'Base', toChain: 'Arc', sourceChainKey: 'base-mainnet', destinationChainKey: 'arc-mainnet', burnTxHash: BURN_OTHER_WALLET, walletAddress: OTHER_WALLET, mintTxHash: MINT_BASE_TO_ARC, createdAt: 1_790_782_950_000 }),
    // Foreign owner: never returned.
    bridgeApproval({ id: 'foreign-owner', owner: OTHER_OWNER, amount: '5', fromChain: 'Base', toChain: 'Arc', sourceChainKey: 'base-mainnet', destinationChainKey: 'arc-mainnet', burnTxHash: '0x' + 'e'.repeat(64), createdAt: 1_790_782_960_000 }),
    // Non-bridge approval: never returned.
    { id: 'swap-row', owner: OWNER, agent: 'mcp-agent', action: 'swap', amount: '1', token: 'USDC', source: 'session', to: '', status: 'success', createdAt: 1_790_782_970_000, details: JSON.stringify({ tokenIn: 'USDC', tokenOut: 'EURC' }) },
  ]

  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {}, agentBindings: {} }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: approvalRows }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {} }))
  await writeFile(process.env.TX_HISTORY_DB, JSON.stringify({
    [OWNER]: [{
      id: 'web-ui-bridge-row',
      ts: 1_790_782_700_000,
      action: 'bridge',
      source: 'web-ui',
      walletSource: 'eoa',
      from: 'Base',
      to: 'Arc',
      amount: '0.05',
      token: 'USDC',
      status: 'success',
      burnTx: '0x' + 'f'.repeat(64),
      owner: OWNER,
    }],
  }))

  const previousFetch = globalThis.fetch
  let localBase = ''
  // Outbound calls (Circle/Iris/Supabase) are stubbed; the local listener keeps
  // using the real fetch so the HTTP routes stay real.
  globalThis.fetch = async url => {
    if (String(url).startsWith(localBase)) return previousFetch(url)
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const { app } = await import('../server.mjs?bridge-history-http-' + Date.now() + '-' + Math.random())
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      localBase = `http://127.0.0.1:${listener.address().port}`
      const get = async (path, headers = {}) => {
        const response = await previousFetch(`${localBase}${path}`, { headers })
        return { status: response.status, body: await response.json().catch(() => ({})) }
      }
      await fn({ get, token: ownerToken(OWNER) })
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

test('GET /api/bridge-history requires authentication', async () => {
  await withHttp(async ({ get }) => {
    const response = await get('/api/bridge-history')
    assert.equal(response.status, 401)
  })
})

test('GET /api/bridge-history returns owner-scoped MSCA rows with mainnet links', async () => {
  await withHttp(async ({ get, token }) => {
    const { status, body } = await get(`/api/bridge-history?address=${MSCA}`, { Authorization: `Bearer ${token}` })
    assert.equal(status, 200)
    assert.equal(body.ownerScope, 'eoa-and-linked-msca')
    assert.deepEqual(body.bridges.map(row => row.from + '->' + row.to), ['Arbitrum->Arc', 'Arc->Arbitrum'])

    const [pending, executed] = body.bridges
    assert.equal(executed.amount, '0.02', 'dua approval dengan burn yang sama digabung, nominal eksekusi dipakai')
    assert.equal(executed.source, 'agent-mcp')
    assert.equal(executed.walletSource, 'circle')
    assert.equal(body.bridges.some(row => row.walletAddress === OTHER_WALLET), false, 'filter wallet MSCA tidak boleh membocorkan wallet lain')
    assert.equal(body.bridges.some(row => row.id === 'bridge-swap-row'), false, 'approval non-bridge tidak ikut')

    assert.match(executed.burnExplorerUrl, /^https:\/\/explorer\.arc\.io\/tx\/0x/)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.pendingMint, true)
    assert.match(pending.burnExplorerUrl, /^https:\/\/arbiscan\.io\/tx\/0x/)
    assert.equal(pending.owner, undefined, 'baris MSCA tidak memakai field owner agar merge browser tidak menjatuhkannya')
    assert.equal(pending.ownerAddress, OWNER)
  })
})

test('without a wallet filter every Agent Wallet of the owner is included', async () => {
  await withHttp(async ({ get, token }) => {
    const { status, body } = await get('/api/bridge-history', { Authorization: `Bearer ${token}` })
    assert.equal(status, 200)
    assert.equal(body.count, 3)
    const other = body.bridges.find(row => row.walletAddress === OTHER_WALLET)
    assert.ok(other, 'wallet Agent Wallet lain milik owner yang sama tetap terlihat')
    assert.equal(other.from, 'Base')
    assert.equal(other.mintTx.length, 66)
    assert.match(other.mintExplorerUrl, /^https:\/\/explorer\.arc\.io\/tx\/0x/)
  })
})

test('GET /api/tx-history merges agent bridge rows into the browser history', async () => {
  await withHttp(async ({ get, token }) => {
    const { status, body } = await get(`/api/tx-history?address=${MSCA}`, { Authorization: `Bearer ${token}` })
    assert.equal(status, 200)
    assert.equal(body.bridgeCount, 2, 'filter wallet hanya menyertakan baris Agent Wallet yang diminta')
    assert.equal(body.history.length, 3, 'satu baris web-ui + dua baris bridge agent MSCA')

    const local = body.history.find(row => row.id === 'web-ui-bridge-row')
    assert.equal(local.source, 'web-ui', 'baris lokal tidak tertimpa baris bridge')
    assert.equal(local.status, 'success')

    const agentRows = body.history.filter(row => row.source === 'agent-mcp')
    assert.equal(agentRows.length, 2)
    for (const row of agentRows) {
      assert.equal(row.action, 'bridge')
      assert.equal(row.ts > 0, true)
      assert.equal(typeof row.burnTx, 'string')
    }
    assert.deepEqual(body.history.map(row => row.ts), [...body.history.map(row => row.ts)].sort((a, b) => b - a), 'urut terbaru dulu')

    // Tanpa filter wallet, seluruh Agent Wallet milik owner ikut (termasuk yang
    // menuju wallet lain), sehingga agent bisa menjelaskan saldo semua chain.
    const all = await get('/api/tx-history', { Authorization: `Bearer ${token}` })
    assert.equal(all.body.bridgeCount, 3)
    assert.equal(all.body.history.length, 4)
  })
})
