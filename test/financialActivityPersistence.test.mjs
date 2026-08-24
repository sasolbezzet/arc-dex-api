import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'arcox-activity-'))
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
process.env.VAULT_ACTIVITY_PATH = join(tempDir, 'activity.json')
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))

const { logActivity, listActivity } = await import('../src/services/vaultStore.mjs?activity-test-' + Date.now())
const { readAgentActivity, readAgentApprovals, readCardRecords, readCardTransactions, supabasePersistenceStatus } = await import('../src/services/supabasePersistence.mjs?financial-test-' + Date.now())

const OWNER = '0x1111111111111111111111111111111111111111'

after(() => rmSync(tempDir, { recursive: true, force: true }))

test('Agent Activity returns newest five entries only', async () => {
  for (let i = 0; i < 8; i += 1) logActivity(OWNER, `tx_${i}`, { amount: String(i) })
  const local = listActivity(OWNER, 5)
  assert.equal(local.length, 5)
  assert.equal(local[0].type, 'tx_7')

  const read = await readAgentActivity(OWNER, local, 20)
  assert.equal(read.activity.length, 5)
  assert.equal(read.activity[0].type, 'tx_7')
  assert.equal(read.source, 'json')
})

test('approval reads and financial card reads fall back safely when Supabase is disabled', async () => {
  const approvals = [{ id: 'approval_1', owner: OWNER, action: 'send', amount: '1', status: 'pending' }]
  const approvalRead = await readAgentApprovals(OWNER, approvals)
  assert.deepEqual(approvalRead.approvals, approvals)
  assert.equal(approvalRead.source, 'json')

  
  const cards = [{ cardId: 'card_1', owner: OWNER, last4: '1234', pan: '••••••••••••1234' }]
  const transactions = [{ id: 'tx_1', cardId: 'card_1', owner: OWNER, amount: '1', status: 'settled' }]
  const cardRead = await readCardRecords(OWNER, cards, 100)
  const txRead = await readCardTransactions(OWNER, transactions, null, 100)
  assert.deepEqual(cardRead.cards, cards)
  assert.deepEqual(txRead.transactions, transactions)
  assert.equal(supabasePersistenceStatus().financialSyncEnabled, false)
})
