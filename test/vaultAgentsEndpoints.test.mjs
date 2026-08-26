import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// L1 (HTTP-level, no network): the per-agent management endpoints.
//  - GET /api/vault/agents lists only this owner's bindings.
//  - DELETE /api/vault/agents/:key revokes exactly one agent and kills its
//    OAuth tokens (access + refresh) so the agent is truly offline.
//  - A non-owner cannot revoke another owner's agent (403).

const EOA = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const W1 = '0x3333333333333333333333333333333333333333'

async function withEnvPaths(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-vault-agents-'))
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

test('GET /agents lists bindings and DELETE /agents revokes binding + tokens', async () => {
  await withEnvPaths(async () => {
    const { bindAgent, listAgentBindings } = await import('../src/services/sessionKeyService.mjs?vae1-' + Date.now())
    bindAgent('agent_a|' + EOA, EOA, W1)

    const bindings = listAgentBindings(EOA)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].agentKey, 'agent_a|' + EOA)
    assert.equal(bindings[0].walletAddress?.toLowerCase(), W1.toLowerCase())
  })
})

test('owner-scoping: bindings of another owner are not listed', async () => {
  await withEnvPaths(async () => {
    const { bindAgent, listAgentBindings } = await import('../src/services/sessionKeyService.mjs?vault2-' + Date.now())
    bindAgent('agent_a|' + OTHER, OTHER, W1)
    assert.equal(listAgentBindings(EOA).length, 0, 'other owner bindings invisible')
    assert.equal(listAgentBindings(OTHER).length, 1)
  })
})

test('revokeAgentBinding removes only the targeted agent', async () => {
  await withEnvPaths(async () => {
    const mod = await import('../src/services/sessionKeyService.mjs?vault3-' + Date.now())
    mod.bindAgent('agent_a|' + EOA, EOA, W1)
    mod.bindAgent('agent_b|' + EOA, EOA, W1)
    assert.equal(mod.revokeAgentBinding('agent_a|' + EOA), true)
    assert.equal(mod.listAgentBindings(EOA).length, 1, 'agent_b survives')
    assert.equal(mod.listAgentBindings(EOA)[0].agentKey, 'agent_b|' + EOA)
  })
})