import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

// Alert gagal webhook harus bertahan di vault (bukan in-memory) supaya restart
// tidak menghapus tanda "wallet perlu tindakan", dan harus terikat ke owner.
async function withVault(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-webhook-alerts-'))
  const previous = {
    VAULT_PATH: process.env.VAULT_PATH,
    VAULT_ACTIVITY_PATH: process.env.VAULT_ACTIVITY_PATH,
    VAULT_SESSION_PATH: process.env.VAULT_SESSION_PATH,
    SUPABASE_PERSISTENCE_MODE: process.env.SUPABASE_PERSISTENCE_MODE,
  }
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'sessions.json')
  process.env.SUPABASE_PERSISTENCE_MODE = 'off'
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  try {
    const vault = await import('../src/services/vaultStore.mjs?alerts=' + Date.now() + '-' + Math.random())
    await fn(vault)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('records an owner-scoped alert and lists it newest first', async () => {
  await withVault(async (vault) => {
    assert.equal(vault.recordWebhookFailure('not-an-address', { family: 'challenges', eventType: 'challenges.setPin' }), null)

    const first = vault.recordWebhookFailure(OWNER, { family: 'challenges', eventType: 'challenges.setPin', status: 'failed', subjectId: 'c1' })
    assert.equal(first.duplicate, false)
    assert.equal(first.owner, OWNER)
    assert.equal(first.acknowledged, false)
    assert.equal(first.count, 1)

    const second = vault.recordWebhookFailure(OWNER, { family: 'rampSession', eventType: 'rampSession.kycRejected', subjectId: 's1' })
    assert.equal(second.duplicate, false)

    vault.recordWebhookFailure(OTHER, { family: 'rampSession', eventType: 'rampSession.failed', subjectId: 's2' })

    const alerts = vault.listWebhookFailures(OWNER)
    assert.equal(alerts.length, 2)
    assert.equal(alerts[0].eventType, 'rampSession.kycRejected')
    assert.equal(vault.listWebhookFailures(OTHER).length, 1)
    assert.deepEqual(vault.listWebhookFailures('bogus'), [])
  })
})

test('repeats inside the dedupe window bump the counter instead of flooding', async () => {
  await withVault(async (vault) => {
    const alert = { family: 'challenges', eventType: 'challenges.contractExecution', status: 'failed', subjectId: 'c9' }
    vault.recordWebhookFailure(OWNER, alert)
    const repeat = vault.recordWebhookFailure(OWNER, alert)
    assert.equal(repeat.duplicate, true)
    assert.equal(repeat.count, 2)

    const alerts = vault.listWebhookFailures(OWNER)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].count, 2)

    // Subjek berbeda tidak ikut ter-dedupe.
    vault.recordWebhookFailure(OWNER, { ...alert, subjectId: 'c10' })
    assert.equal(vault.listWebhookFailures(OWNER).length, 2)
  })
})

test('acknowledging an alert hides it until explicitly requested', async () => {
  await withVault(async (vault) => {
    const alert = vault.recordWebhookFailure(OWNER, { family: 'rampSession', eventType: 'rampSession.failed', subjectId: 's3' })

    assert.equal(vault.acknowledgeWebhookFailure(OWNER, 'missing-id'), null)
    assert.equal(vault.acknowledgeWebhookFailure(OTHER, alert.id), null)

    const acknowledged = vault.acknowledgeWebhookFailure(OWNER, alert.id)
    assert.equal(acknowledged.acknowledged, true)
    assert.deepEqual(vault.listWebhookFailures(OWNER), [])
    const withAcknowledged = vault.listWebhookFailures(OWNER, { includeAcknowledged: true })
    assert.equal(withAcknowledged.length, 1)
    assert.equal(withAcknowledged[0].id, alert.id)
  })
})
