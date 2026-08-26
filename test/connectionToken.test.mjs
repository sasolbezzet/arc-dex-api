import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// L0: connection tokens (Fase 4B).
//  - issueConnectionToken returns a long-lived bearer bound to the MSCA.
//  - validateAccessToken accepts it for the MCP resource.
//  - revokeTokensForClient kills it so /mcp rejects afterwards.

const EOA = '0x1111111111111111111111111111111111111111'
const W1 = '0x3333333333333333333333333333333333333333'

async function withEnvPaths(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-conn-token-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousVaultPath = process.env.VAULT_PATH
  const previousActivityPath = process.env.VAULT_ACTIVITY_PATH
  const previousSessionPath = process.env.VAULT_SESSION_PATH
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'vault-activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {} }), 'utf8')
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }), 'utf8')
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]', 'utf8')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }), 'utf8')
  try {
    return await fn()
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousVaultPath === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = previousVaultPath
    if (previousActivityPath === undefined) delete process.env.VAULT_ACTIVITY_PATH
    else process.env.VAULT_ACTIVITY_PATH = previousActivityPath
    if (previousSessionPath === undefined) delete process.env.VAULT_SESSION_PATH
    else process.env.VAULT_SESSION_PATH = previousSessionPath
    await rm(dir, { recursive: true, force: true })
  }
}

test('connection token is issued, validates at MCP, and is revoked per agent', async () => {
  await withEnvPaths(async () => {
    const mcp = await import('../src/services/mcpServer.mjs?conn-' + Date.now())

    const issued = mcp.issueConnectionToken({ agentKey: 'agent_a|' + EOA, clientName: 'Hermes Agent', userId: EOA, mscaWalletAddress: W1, ttlDays: 90 })
    assert.match(issued.token, /^arx_at_[0-9a-f]{32}$/, 'token format')
    assert.ok(issued.expiresAt > new Date().toISOString(), 'long-lived expiry')

    const auth = mcp.validateAccessToken(issued.token)
    assert.ok(auth, 'token validates at MCP')
    assert.match(auth.clientId, /^arcox_conn_/, 'dedicated connection client minted')
    assert.equal(auth.mscaWalletAddress?.toLowerCase(), W1.toLowerCase(), 'MSCA locked at issuance')
    assert.equal(auth.resource, 'https://arcoxdex.vercel.app/mcp', 'resource pinned to MCP')

    // Revoking the agent (its connection client) kills the token.
    const removed = mcp.revokeTokensForClient(issued.clientId)
    assert.ok(removed >= 1, 'token removed')
    assert.equal(mcp.validateAccessToken(issued.token), null, 'token dead after revoke')
  })
})

test('issuing a new connection token rotates the previous token for that agent', async () => {
  await withEnvPaths(async () => {
    const mcp = await import('../src/services/mcpServer.mjs?conn-rotate-' + Date.now())
    const first = mcp.issueConnectionToken({ agentKey: 'agent_rotate|' + EOA, clientName: 'Hermes', userId: EOA, mscaWalletAddress: W1, ttlDays: 30 })
    assert.ok(mcp.validateAccessToken(first.token), 'first token initially valid')

    const second = mcp.issueConnectionToken({ agentKey: first.clientId + '|' + EOA, clientName: 'Hermes', userId: EOA, mscaWalletAddress: W1, ttlDays: 30 })
    assert.equal(mcp.validateAccessToken(first.token), null, 'old connection token is rotated out')
    assert.ok(mcp.validateAccessToken(second.token), 'new connection token is valid')
  })
})

test('connection token for a second agent survives revoke of the first', async () => {
  await withEnvPaths(async () => {
    const mcp = await import('../src/services/mcpServer.mjs?conn2-' + Date.now())
    const a = mcp.issueConnectionToken({ agentKey: 'agent_a|' + EOA, clientName: 'Hermes', userId: W1, mscaWalletAddress: W1, ttlDays: 30 })
    const b = mcp.issueConnectionToken({ agentKey: 'agent_b|' + EOA, clientName: 'Claude', userId: W1, mscaWalletAddress: W1, ttlDays: 30 })
    mcp.revokeTokensForClient(a.clientId)
    assert.equal(mcp.validateAccessToken(a.token), null)
    assert.ok(mcp.validateAccessToken(b.token), 'agent B unaffected')
  })
})

const WOO = '0x4444444444444444444444444444444444444444'