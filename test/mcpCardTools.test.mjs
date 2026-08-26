import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'mcp-card-tools-'))
const dbFile = join(tempDir, 'cards.json')
writeFileSync(dbFile, JSON.stringify({ cards: [], transactions: [], ledger: {}, onchain: {} }))
const activityFile = join(tempDir, 'activity.json')
writeFileSync(activityFile, '[]')
process.env.AGENT_CARDS_DB = dbFile
process.env.VAULT_ACTIVITY_PATH = activityFile
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
process.env.CARDS_SYNC_ONCHAIN = 'false'
process.env.SUPABASE_PERSISTENCE_MODE = 'off'

const { createCard } = await import('../src/services/cardSimulator.mjs')
const { registerCardTools } = await import('../src/services/mcp/cardTools.mjs')
const { upsertAgentCardLink } = await import('../src/services/vaultStore.mjs')

const MSCA = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

function fakeZod() {
  const schema = {
    optional() { return this },
    describe() { return this },
  }
  return {
    string: () => schema,
    boolean: () => schema,
    array: () => schema,
  }
}

const AGENT_A = `client-a|${'0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}`
const AGENT_B = `client-b|${'0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}`

function toolsFor(resolveMsca = async () => ({ walletAddress: MSCA }), agentKey = AGENT_A) {
  const tools = {}
  registerCardTools({
    registerTool(name, _description, _schema, handler) { tools[name] = { handler } },
    z: fakeZod(),
    jsonText: value => JSON.stringify(value),
    mscaRequiredResult: () => ({ rejected: true, reason: 'no_session' }),
    apiGet: async () => ({ ok: true }),
    apiPost: async () => ({ ok: true }),
    resolveMsca,
    userId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    agentKey,
  })
  return tools
}

function resultOf(response) {
  return JSON.parse(response.content[0].text)
}

beforeEach(() => {
  writeFileSync(dbFile, JSON.stringify({ cards: [], transactions: [], ledger: {}, onchain: {} }))
  writeFileSync(activityFile, '[]')
})

after(() => rmSync(tempDir, { recursive: true, force: true }))

test('MCP card list is bound to the active MSCA, agent link, and masks credentials', async () => {
  const card = createCard(MSCA, { label: 'MCP Card' })
  upsertAgentCardLink(AGENT_A, { cardId: card.cardId, maxPerTx: '10', daily: '20' })
  const result = resultOf(await toolsFor().arcox_card_list.handler({}))
  assert.equal(result.walletAddress, MSCA)
  assert.equal(result.walletType, 'MSCA')
  assert.equal(result.cards.length, 1)
  assert.equal(result.cards[0].cardId, card.cardId)
  assert.notEqual(result.cards[0].pan, card.pan)
  assert.equal(result.cards[0].cvv, undefined)
})

test('MCP card spend requires explicit confirmation then settles for the active MSCA', async () => {
  const card = createCard(MSCA, { label: 'Spend Card', perTxLimit: '10' })
  upsertAgentCardLink(AGENT_A, { cardId: card.cardId, maxPerTx: '10', daily: '20' })
  const tool = toolsFor().arcox_card_spend

  const preview = resultOf(await tool.handler({ cardId: card.cardId, merchantId: 'm_coffee', amount: '3' }))
  assert.equal(preview.status, 'confirmation_required')

  const result = resultOf(await tool.handler({
    cardId: card.cardId,
    merchantId: 'm_coffee',
    amount: '3',
    description: 'MCP test purchase',
    confirmed: true,
    confirmationText: 'yes',
  }))
  assert.equal(result.ok, true)
  assert.equal(result.approved, true)
  assert.equal(result.status, 'settled')
  assert.equal(result.walletAddress, MSCA)
  assert.equal(result.walletType, 'MSCA')
  assert.equal(result.source, 'mcp-session')
  assert.ok(result.txId)
})

test('MCP card spend cannot use a card owned by another MSCA', async () => {
  const card = createCard(OTHER, { label: 'Other Card' })
  upsertAgentCardLink(AGENT_A, { cardId: card.cardId, maxPerTx: '10', daily: '20' })
  const result = resultOf(await toolsFor().arcox_card_spend.handler({
    cardId: card.cardId,
    merchantId: 'm_coffee',
    amount: '1',
    confirmed: true,
    confirmationText: 'ya',
  }))
  assert.equal(result.ok, false)
  assert.equal(result.approved, false)
  assert.equal(result.declineReason, 'card_not_found')
})

test('MCP card list hides unlinked cards and owner mutations stay owner-only', async () => {
  const card = createCard(MSCA, { label: 'Unlinked Card' })
  const tools = toolsFor()
  const listed = resultOf(await tools.arcox_card_list.handler({}))
  assert.equal(listed.cards.length, 0)
  assert.equal(resultOf(await tools.arcox_card_create.handler({})).reason, 'owner_authentication_required')
  assert.equal(resultOf(await tools.arcox_card_fund.handler({ amount: '1' })).reason, 'owner_authentication_required')
  assert.ok(card.cardId)
})

test('MCP card spend is blocked when the card is not linked and per-agent caps are isolated', async () => {
  const card = createCard(MSCA, { label: 'Linked Card', perTxLimit: '20', dailyLimit: '20' })
  const unlinked = resultOf(await toolsFor().arcox_card_spend.handler({
    cardId: card.cardId, merchantId: 'm_coffee', amount: '1', confirmed: true, confirmationText: 'yes',
  }))
  assert.equal(unlinked.declineReason, 'card_not_linked_to_agent')

  upsertAgentCardLink(AGENT_A, { cardId: card.cardId, maxPerTx: '2', daily: '2' })
  const agentA = toolsFor().arcox_card_spend
  const first = resultOf(await agentA.handler({
    cardId: card.cardId, merchantId: 'm_coffee', amount: '2', confirmed: true, confirmationText: 'yes',
  }))
  assert.equal(first.approved, true)
  const overA = resultOf(await agentA.handler({
    cardId: card.cardId, merchantId: 'm_coffee', amount: '1', confirmed: true, confirmationText: 'yes',
  }))
  assert.equal(overA.declineReason, 'card_agent_limit_exceeded')

  upsertAgentCardLink(AGENT_B, { cardId: card.cardId, maxPerTx: '3', daily: '3' })
  const agentB = toolsFor(async () => ({ walletAddress: MSCA }), AGENT_B).arcox_card_spend
  const bResult = resultOf(await agentB.handler({
    cardId: card.cardId, merchantId: 'm_coffee', amount: '3', confirmed: true, confirmationText: 'yes',
  }))
  assert.equal(bResult.approved, true)
})
