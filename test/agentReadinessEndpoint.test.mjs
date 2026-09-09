import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const WALLET = '0x2222222222222222222222222222222222222222'
const DELEGATE = '0x3333333333333333333333333333333333333333'
const AGENT = `arcox_conn_readiness|${OWNER}`

async function withHttp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-readiness-http-'))
  const names = [
    'SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH',
    'VAULT_ACTIVITY_PATH', 'VAULT_SESSION_PATH', 'OAUTH_PATH',
    'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH', 'SERVER_URL',
    'SUPABASE_PERSISTENCE_MODE',
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
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [WALLET]: {
        walletAddress: WALLET,
        delegateAddress: DELEGATE,
        active: true,
        authorizationUserOpHash: `0x${'11'.repeat(32)}`,
        authorizationUserOpHashes: { 'arc-testnet': `0x${'11'.repeat(32)}` },
      },
    },
    aliases: { [OWNER]: WALLET },
    agentBindings: {
      [AGENT]: { ownerAddress: OWNER, walletAddress: WALLET, active: true },
    },
  }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {} }))
  try {
    const vault = await import('../src/services/vaultStore.mjs')
    const session = await import('../src/services/sessionKeyService.mjs')
    const mcp = await import('../src/services/mcpServer.mjs')
    const { default: router } = await import('../src/routes/vaultRoutes.mjs')
    const ownerToken = vault.createSession(OWNER)
    const issued = mcp.issueConnectionToken({ agentKey: AGENT, clientName: 'Hermes Agent', userId: OWNER, mscaWalletAddress: WALLET, ttlDays: 1 })
    vault.registerMcpSession(OWNER, issued.clientId, 'hermes-mcp', true)
    assert.equal(session.getAgentBinding(AGENT)?.walletAddress, WALLET)
    const app = express()
    app.use(express.json())
    app.use('/api/vault', router)
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/vault/agents/${encodeURIComponent(AGENT)}/readiness`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      })
      const body = await response.json()
      assert.equal(response.status, 200)
      assert.equal(body.readiness.agentType, 'hermes')
      assert.equal(body.readiness.mcp.connected, true)
      assert.equal(body.readiness.mcp.tokenActive, true)
      assert.equal(body.readiness.execution.ready, false)
      assert.equal(body.readiness.execution.reason, 'destination_session_not_authorized')
      assert.equal(body.readiness.execution.destinations['base-sepolia'], false)
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

test('readiness endpoint is owner-scoped and separates Hermes MCP from execution', async () => {
  await withHttp(async () => {})
})
