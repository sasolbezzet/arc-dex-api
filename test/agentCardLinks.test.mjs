import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const AGENT = `client-a|${OWNER}`
const CARD = 'acard_test_1'

async function withVault(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-agent-card-links-'))
  const previous = {
    vault: process.env.VAULT_PATH,
    activity: process.env.VAULT_ACTIVITY_PATH,
  }
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], approvals: [], agentCardLinks: {} }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  try {
    const vault = await import('../src/services/vaultStore.mjs?agent-card-links-' + Date.now() + '-' + Math.random())
    return await fn(vault)
  } finally {
    if (previous.vault === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = previous.vault
    if (previous.activity === undefined) delete process.env.VAULT_ACTIVITY_PATH
    else process.env.VAULT_ACTIVITY_PATH = previous.activity
    await rm(dir, { recursive: true, force: true })
  }
}

test('agent card links upsert limits and removes only the selected agent link', async () => {
  await withVault(async ({ upsertAgentCardLink, listAgentCardLinks, removeAgentCardLink }) => {
    const first = upsertAgentCardLink(AGENT, { cardId: CARD, maxPerTx: '5', daily: '20' })
    assert.deepEqual(first, { cardId: CARD, maxPerTx: '5', daily: '20', linkedAt: first.linkedAt })
    assert.equal(listAgentCardLinks(AGENT).length, 1)

    const updated = upsertAgentCardLink(AGENT, { cardId: CARD, maxPerTx: '3', daily: '10' })
    assert.equal(updated.linkedAt, first.linkedAt)
    assert.equal(updated.maxPerTx, '3')
    assert.equal(listAgentCardLinks(AGENT).length, 1)

    upsertAgentCardLink(`client-b|${OTHER}`, { cardId: CARD, maxPerTx: '8', daily: '30' })
    assert.equal(removeAgentCardLink(AGENT, CARD), true)
    assert.equal(listAgentCardLinks(AGENT).length, 0)
    assert.equal(listAgentCardLinks(`client-b|${OTHER}`).length, 1)
    assert.equal(removeAgentCardLink(AGENT, CARD), false)
  })
})

test('legacy vault shape without limits still gets safe per-owner defaults', async () => {
  await withVault(async ({ getLimits, setLimits }) => {
    assert.deepEqual(getLimits(OWNER), { maxPerTx: 100, dailyLimit: 500, autoApprove: true, whitelist: [] })
    assert.equal(setLimits(OWNER, { dailyLimit: 25 }).dailyLimit, 25)
    assert.equal(getLimits(OWNER).maxPerTx, 100)
  })
})

test('agent card links persist only masked relationship metadata', async () => {
  await withVault(async ({ upsertAgentCardLink }) => {
    upsertAgentCardLink(AGENT, { cardId: CARD, maxPerTx: 5, daily: 20 })
    const raw = JSON.parse(await readFile(process.env.VAULT_PATH, 'utf8'))
    assert.deepEqual(raw.agentCardLinks[AGENT], [{
      cardId: CARD,
      maxPerTx: '5',
      daily: '20',
      linkedAt: raw.agentCardLinks[AGENT][0].linkedAt,
    }])
    assert.equal(JSON.stringify(raw).includes('pan'), false)
    assert.equal(JSON.stringify(raw).includes('cvv'), false)
  })
})
