import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const WALLET = '0x3333333333333333333333333333333333333333'
const DELEGATE = '0x5555555555555555555555555555555555555555'

async function withHttp(fn, { active = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-bootstrap-token-'))
  const names = [
    'SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH',
    'VAULT_ACTIVITY_PATH', 'VAULT_SESSION_PATH', 'OAUTH_PATH',
    'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH', 'SERVER_URL',
    'SUPABASE_PERSISTENCE_MODE', 'CARDS_SYNC_ONCHAIN',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  process.env.OAUTH_PATH = join(dir, 'oauth-clients.json')
  process.env.OAUTH_TOKENS_PATH = join(dir, 'oauth-tokens.json')
  process.env.OAUTH_STATE_PATH = join(dir, 'oauth-state.json')
  process.env.SERVER_URL = 'https://arcoxdex.vercel.app'
  process.env.SUPABASE_PERSISTENCE_MODE = 'off'
  process.env.CARDS_SYNC_ONCHAIN = 'false'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [WALLET.toLowerCase()]: {
        walletAddress: WALLET,
        delegateAddress: DELEGATE,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
        authorizationUserOpHashes: { 'arc-testnet': '0x' + 'a'.repeat(64) },
        active,
      },
    },
    aliases: { [OWNER.toLowerCase()]: WALLET },
    agentBindings: {},
  }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [], agentCardLinks: {} }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {}, deviceGrants: {} }))
  try {
    const vault = await import('../src/services/vaultStore.mjs')
    const session = await import('../src/services/sessionKeyService.mjs')
    const { default: router } = await import('../src/routes/vaultRoutes.mjs')
    const { validateAccessToken } = await import('../src/services/mcpServer.mjs')
    const app = express()
    app.use(express.json())
    app.use('/api/vault', router)
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      const base = `http://127.0.0.1:${listener.address().port}`
      await fn({ vault, session, validateAccessToken, base })
    } finally {
      await new Promise(resolve => listener.close(resolve))
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

async function request(base, path, token, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  })
  return { response, body: await response.json() }
}

test('bootstrap connection token creates an owner binding and valid MCP access token', async () => {
  await withHttp(async ({ vault, session, validateAccessToken, base }) => {
    const ownerToken = vault.createSession(OWNER)
    const result = await request(base, '/api/vault/agents/bootstrap-connection-token', ownerToken, {
      method: 'POST',
      body: JSON.stringify({ clientName: 'Hermes Bootstrap', ttlDays: 1, walletAddress: WALLET }),
    })
    assert.equal(result.response.status, 200)
    assert.match(result.body.agentKey, new RegExp(`^arcox_conn_[^|]+\\|${OWNER}$`))
    assert.equal(result.body.walletAddress.toLowerCase(), WALLET.toLowerCase())
    assert.ok(result.body.token.startsWith('arx_at_'))
    assert.equal(session.getAgentBinding(result.body.agentKey)?.walletAddress, WALLET.toLowerCase())
    assert.equal(validateAccessToken(result.body.token)?.mscaWalletAddress, WALLET.toLowerCase())

    const revoked = await request(base, `/api/vault/agents/${encodeURIComponent(result.body.agentKey)}`, ownerToken, { method: 'DELETE' })
    assert.equal(revoked.response.status, 200)
    assert.equal(session.getAgentBinding(result.body.agentKey)?.active, false)
    assert.equal(validateAccessToken(result.body.token), null)
  })
})

test('bootstrap connection token rejects an owner without an active Agent Wallet session', async () => {
  await withHttp(async ({ vault, session, base }) => {
    const ownerToken = vault.createSession(OWNER)
    const result = await request(base, '/api/vault/agents/bootstrap-connection-token', ownerToken, {
      method: 'POST',
      body: JSON.stringify({ clientName: 'Hermes Bootstrap' }),
    })
    assert.equal(result.response.status, 400)
    assert.equal(result.body.error, 'wallet_address_required')
    assert.equal(session.listAgentBindings(OWNER).length, 0)
  })
})

test('bootstrap connection token rejects an owner without an active Agent Wallet session', async () => {
  await withHttp(async ({ vault, session, base }) => {
    const ownerToken = vault.createSession(OWNER)
    const result = await request(base, '/api/vault/agents/bootstrap-connection-token', ownerToken, {
      method: 'POST',
      body: JSON.stringify({ clientName: 'Hermes Bootstrap', walletAddress: WALLET }),
    })
    assert.equal(result.response.status, 409)
    assert.equal(result.body.error, 'agent_wallet_session_required')
    assert.equal(session.listAgentBindings(OWNER).length, 0)
  }, { active: false })
})
