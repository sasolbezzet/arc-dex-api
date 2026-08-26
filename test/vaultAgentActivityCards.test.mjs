import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const WALLET = '0x3333333333333333333333333333333333333333'
const OTHER_WALLET = '0x4444444444444444444444444444444444444444'
const AGENT = `client-a|${OWNER}`

async function withHttp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-agent-http-'))
  const names = ['SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH', 'VAULT_ACTIVITY_PATH', 'VAULT_SESSION_PATH', 'AGENT_CARDS_DB', 'OAUTH_PATH', 'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH', 'SERVER_URL', 'SUPABASE_PERSISTENCE_MODE', 'CARDS_SYNC_ONCHAIN']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'sessions.json')
  process.env.AGENT_CARDS_DB = join(dir, 'cards.json')
  process.env.OAUTH_PATH = join(dir, 'oauth-clients.json')
  process.env.OAUTH_TOKENS_PATH = join(dir, 'oauth-tokens.json')
  process.env.OAUTH_STATE_PATH = join(dir, 'oauth-state.json')
  process.env.SERVER_URL = 'http://127.0.0.1:0'
  process.env.SUPABASE_PERSISTENCE_MODE = 'off'
  process.env.CARDS_SYNC_ONCHAIN = 'false'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {}, agentBindings: {} }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [], agentCardLinks: {} }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.AGENT_CARDS_DB, JSON.stringify({ cards: [], transactions: [], ledger: {}, onchain: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {}, deviceGrants: {} }))
  try {
    const vault = await import('../src/services/vaultStore.mjs')
    const session = await import('../src/services/sessionKeyService.mjs')
    const cards = await import('../src/services/cardSimulator.mjs')
    const { default: router } = await import('../src/routes/vaultRoutes.mjs?agent-http-' + Date.now() + '-' + Math.random())
    const app = express()
    app.use(express.json())
    app.use('/api/vault', router)
    const server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
      listener.on('error', reject)
    })
    try {
      const base = `http://127.0.0.1:${server.address().port}`
      await fn({ vault, session, cards, base })
    } finally {
      await new Promise(resolve => server.close(resolve))
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  return { response, body: await response.json() }
}

test('agent activity and card links are owner-scoped over HTTP', async () => {
  await withHttp(async ({ vault, session, cards, base }) => {
    session.bindAgent(AGENT, OWNER, WALLET)
    const ownerToken = vault.createSession(OWNER)
    const otherToken = vault.createSession(OTHER)
    const card = cards.createCard(WALLET, { label: 'Agent card', perTxLimit: '5', dailyLimit: '20' })
    const otherCard = cards.createCard(OTHER_WALLET, { label: 'Other card' })
    vault.logActivity(OWNER, 'send_success', { agentClientId: 'client-a', action: 'send', amount: '2' })
    vault.logActivity(OWNER, 'other_agent_event', { agentClientId: 'client-b', action: 'send', amount: '9' })

    const activity = await request(base, `/api/vault/agents/${encodeURIComponent(AGENT)}/activity`, ownerToken)
    assert.equal(activity.response.status, 200)
    assert.ok(activity.body.activity.some(item => item.type === 'send_success' && item.amount === '2'))
    assert.equal(activity.body.activity.some(item => item.type === 'other_agent_event'), false)

    const ownerCards = await request(base, '/api/vault/cards', ownerToken)
    assert.equal(ownerCards.response.status, 200)
    assert.deepEqual(ownerCards.body.cards.map(item => item.cardId), [card.cardId])

    const wrongLink = await request(base, `/api/vault/agents/${encodeURIComponent(AGENT)}/cards`, ownerToken, {
      method: 'POST', body: JSON.stringify({ cardId: otherCard.cardId, maxPerTx: '1', daily: '2' }),
    })
    assert.equal(wrongLink.response.status, 404)
    assert.equal(wrongLink.body.error, 'card_not_found')

    const linked = await request(base, `/api/vault/agents/${encodeURIComponent(AGENT)}/cards`, ownerToken, {
      method: 'POST', body: JSON.stringify({ cardId: card.cardId, maxPerTx: '3', daily: '10' }),
    })
    assert.equal(linked.response.status, 200)
    assert.equal(linked.body.card.maxPerTx, '3')

    const linkedCards = await request(base, `/api/vault/agents/${encodeURIComponent(AGENT)}/cards`, ownerToken)
    assert.equal(linkedCards.body.cards.length, 1)
    assert.equal(linkedCards.body.cards[0].daily, '10')

    const forbidden = await request(base, `/api/vault/agents/${encodeURIComponent(AGENT)}/cards`, otherToken)
    assert.equal(forbidden.response.status, 403)

    const unlinked = await request(base, `/api/vault/cards/${encodeURIComponent(card.cardId)}/agent-link`, ownerToken, { method: 'DELETE' })
    assert.equal(unlinked.response.status, 200)
    assert.equal(unlinked.body.removed, 1)

    const { issueConnectionToken } = await import('../src/services/mcpServer.mjs')
    const agentToken = issueConnectionToken({ agentKey: AGENT, clientName: 'Hermes', userId: OWNER, mscaWalletAddress: WALLET, ttlDays: 1 }).token
    const agentDenied = await request(base, '/api/vault/cards', agentToken)
    assert.equal(agentDenied.response.status, 403)
    assert.equal(agentDenied.body.error, 'owner_authentication_required')
  })
})
