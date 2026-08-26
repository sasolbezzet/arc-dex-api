import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT_A = 'arcox_dev_a|' + OWNER
const AGENT_B = 'arcox_dev_b|' + OWNER

async function withPaths(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-daily-gate-'))
  const previous = {
    session: process.env.SESSION_KEYS_PATH,
    encryption: process.env.SESSION_KEY_ENCRYPTION_KEY,
    vault: process.env.VAULT_PATH,
    activity: process.env.VAULT_ACTIVITY_PATH,
    sessions: process.env.VAULT_SESSION_PATH,
    spend: process.env.AGENT_SPEND_PATH,
  }
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'vault-activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  process.env.AGENT_SPEND_PATH = join(dir, 'agent-spend.json')
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [OWNER]: {
        walletAddress: OWNER,
        delegateAddress: '0x2222222222222222222222222222222222222222',
        active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    },
    aliases: {},
  }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({
    credentials: [], approvals: [], limits: {
      [OWNER]: { maxPerTx: 100, dailyLimit: 1, autoApprove: true, whitelist: [] },
    },
  }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  try {
    const service = await import('../src/services/sessionKeyService.mjs?daily-gate-' + Date.now() + '-' + Math.random())
    const ledger = await import('../src/services/agentSpendLedger.mjs?daily-gate-ledger-' + Date.now() + '-' + Math.random())
    return await fn({ service, ledger })
  } finally {
    for (const [key, value] of Object.entries({
      SESSION_KEYS_PATH: previous.session,
      SESSION_KEY_ENCRYPTION_KEY: previous.encryption,
      VAULT_PATH: previous.vault,
      VAULT_ACTIVITY_PATH: previous.activity,
      VAULT_SESSION_PATH: previous.sessions,
      AGENT_SPEND_PATH: previous.spend,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('canExecuteViaSession enforces daily spend per agent and isolates sibling agents', async () => {
  await withPaths(async ({ service, ledger }) => {
    const first = service.canExecuteViaSession(OWNER, '0.6', 'arc-testnet', { agentKey: AGENT_A, dailyLimit: 1 })
    assert.equal(first.ok, true)
    ledger.recordSpend(AGENT_A, '0.6')

    const over = service.canExecuteViaSession(OWNER, '0.5', 'arc-testnet', { agentKey: AGENT_A, dailyLimit: 1 })
    assert.equal(over.ok, false)
    assert.equal(over.reason, 'daily_limit_exceeded')

    const sibling = service.canExecuteViaSession(OWNER, '0.5', 'arc-testnet', { agentKey: AGENT_B, dailyLimit: 1 })
    assert.equal(sibling.ok, true, 'a sibling agent has its own daily bucket')
  })
})
