import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('vault session metadata stays active after a long idle period', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-session-meta-'))
  const sessionPath = join(dir, 'session-keys.json')
  const vaultPath = join(dir, 'vault.json')
  const msca = '0xd6116ac3e3669618a28f713d662d9ad17ebd5bc5'
  const stale = Date.now() - (24 * 60 * 60 * 1000)
  await writeFile(sessionPath, JSON.stringify({ users: {
    [msca]: {
      walletAddress: msca,
      delegateAddress: msca,
      chain: 'arbitrum-sepolia',
      active: true,
      lastUsedAt: stale,
      authorizationUserOpHash: '0x' + '99'.repeat(32),
    },
  }, aliases: {} }))
  await writeFile(vaultPath, JSON.stringify({ credentials: [], limits: {}, approvals: [], sessionKeys: {} }))
  const oldSessionPath = process.env.SESSION_KEYS_PATH
  const oldVaultPath = process.env.VAULT_PATH
  process.env.SESSION_KEYS_PATH = sessionPath
  process.env.VAULT_PATH = vaultPath
  try {
    const { getSessionKeyInfo } = await import('../src/services/vaultStore.mjs?session-meta-' + Date.now())
    const info = await getSessionKeyInfo(msca)
    assert.equal(info?.active, true)
  } finally {
    if (oldSessionPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = oldSessionPath
    if (oldVaultPath === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = oldVaultPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('session status stays active on a read after a long idle period', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-session-status-read-'))
  const sessionPath = join(dir, 'session-keys.json')
  const wallet = '0x' + '12'.repeat(20)
  const stale = Date.now() - (24 * 60 * 60 * 1000)
  await writeFile(sessionPath, JSON.stringify({ users: { [wallet]: { walletAddress: wallet, delegateAddress: wallet, chain: 'arc-testnet', active: true, lastUsedAt: stale, authorizationUserOpHash: '0x' + 'aa'.repeat(32) } }, aliases: {} }))
  const oldSessionPath = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = sessionPath
  try {
    const { getSessionKey } = await import('../src/services/sessionKeyService.mjs?status-read-' + Date.now())
    const info = getSessionKey(wallet, { sweep: false })
    assert.equal(info?.active, true)
    const saved = JSON.parse(await (await import('node:fs/promises')).readFile(sessionPath, 'utf8'))
    assert.equal(saved.users[wallet].active, true)
  } finally {
    if (oldSessionPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = oldSessionPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('MCP connection stays active after 24 hours without an agent request', async () => {
  const { registerMcpSession, listMcpSessions } = await import('../src/services/vaultStore.mjs?mcp-connection-inactivity-' + Date.now())
  const userId = '0x' + 'ab'.repeat(20)
  const clientId = 'test-client-' + Date.now()
  registerMcpSession(userId, clientId, 'claude-mcp')
  const sessions = listMcpSessions(userId)
  assert.equal(sessions[0].active, true)
  sessions[0].lastActivity = Date.now() - (24 * 60 * 60 * 1000)
  assert.equal(listMcpSessions(userId)[0].active, true)
})
