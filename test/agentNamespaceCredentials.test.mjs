// Passkey namespace resolution — Login Passkey must stay scoped to one agent.
//
// The browser only knows a logical namespace for some agents: the OAuth
// approval card sends `oauth:<clientId>` and a provider placeholder sends its
// bare slug, while the durable binding row is `<clientId>|<owner>`. If the
// backend cannot resolve that namespace it answers with no allowCredentials and
// WebAuthn runs discoverable — offering every passkey on the device, which can
// authenticate a different Agent Wallet (wrong-wallet errors, long stuck popup).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER_OWNER = '0x2222222222222222222222222222222222222222'
const WALLET = '0x3333333333333333333333333333333333333333'
const OTHER_WALLET = '0x4444444444444444444444444444444444444444'

async function withSessionStore(initialStore, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-namespace-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey || 'test-only-session-encryption-key'
  await writeFile(
    process.env.SESSION_KEYS_PATH,
    JSON.stringify({ users: {}, aliases: {}, agentBindings: {}, ...initialStore }),
    'utf8',
  )
  try {
    const service = await import('../src/services/sessionKeyService.mjs?namespace-' + Date.now() + '-' + Math.random())
    return await fn(service)
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    await rm(dir, { recursive: true, force: true })
  }
}

test('resolves `oauth:<clientId>` to the durable `<clientId>|<owner>` credential', async () => {
  await withSessionStore({}, async ({ bindAgent, bindAgentCredential, listAgentBindingsForNamespace }) => {
    bindAgent(`arcox_test_1|${OWNER}`, OWNER, WALLET)
    bindAgentCredential(`arcox_test_1|${OWNER}`, 'cred-durable', WALLET)

    const rows = listAgentBindingsForNamespace('oauth:arcox_test_1')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].agentKey, `arcox_test_1|${OWNER}`)
    assert.deepEqual(rows[0].credentialIds, ['cred-durable'])
  })
})

test('keeps revoked rows so Relogin after revoke still offers its own passkey', async () => {
  await withSessionStore({}, async ({ bindAgent, bindAgentCredential, revokeAgentBinding, listAgentBindingsForNamespace }) => {
    bindAgent(`arcox_test_revoked|${OWNER}`, OWNER, WALLET)
    bindAgentCredential(`arcox_test_revoked|${OWNER}`, 'cred-revoked', WALLET)
    assert.equal(revokeAgentBinding(`arcox_test_revoked|${OWNER}`), true)

    const rows = listAgentBindingsForNamespace('oauth:arcox_test_revoked')
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].credentialIds, ['cred-revoked'])
    assert.equal(rows[0].active, false)
  })
})

test('resolves a bare provider slug to every install of that provider', async () => {
  await withSessionStore({}, async ({ bindAgent, bindAgentCredential, listAgentBindingsForNamespace }) => {
    bindAgent(`grok|${OWNER}`, OWNER, WALLET)
    bindAgentCredential(`grok|${OWNER}`, 'cred-grok-owner', WALLET)
    bindAgent(`grok|${OTHER_OWNER}`, OTHER_OWNER, OTHER_WALLET)
    bindAgentCredential(`grok|${OTHER_OWNER}`, 'cred-grok-other', OTHER_WALLET)

    for (const namespace of ['grok', 'oauth:grok']) {
      const rows = listAgentBindingsForNamespace(namespace)
      assert.deepEqual(rows.map(row => row.agentKey).sort(), [`grok|${OWNER}`, `grok|${OTHER_OWNER}`].sort())
    }
  })
})

test('never crosses into another agent namespace', async () => {
  await withSessionStore({}, async ({ bindAgent, bindAgentCredential, listAgentBindingsForNamespace }) => {
    bindAgent(`claude|${OWNER}`, OWNER, WALLET)
    bindAgentCredential(`claude|${OWNER}`, 'cred-claude', WALLET)

    assert.deepEqual(listAgentBindingsForNamespace('oauth:chatgpt'), [])
    assert.deepEqual(listAgentBindingsForNamespace(`hermes-mcp|${OWNER}`), [])
  })
})

test('canonical key lookup prefers the exact row and lists legacy namespace once', async () => {
  await withSessionStore({}, async ({ bindAgent, listAgentBindingsForNamespace }) => {
    bindAgent(`oauth:arcox_test_dup`, OWNER, WALLET)
    bindAgent(`arcox_test_dup|${OWNER}`, OWNER, WALLET)

    const rows = listAgentBindingsForNamespace(`arcox_test_dup|${OWNER}`)
    assert.deepEqual(rows.map(row => row.agentKey), ['oauth:arcox_test_dup'])
  })
})
