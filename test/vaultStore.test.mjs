import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withVault(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-vault-test-'))
  const previousVault = process.env.VAULT_PATH
  const previousActivity = process.env.VAULT_ACTIVITY_PATH
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }), 'utf8')
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]', 'utf8')
  try {
    const store = await import('../src/services/vaultStore.mjs?vault-test-' + Date.now() + '-' + Math.random())
    return await fn(store)
  } finally {
    if (previousVault === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = previousVault
    if (previousActivity === undefined) delete process.env.VAULT_ACTIVITY_PATH
    else process.env.VAULT_ACTIVITY_PATH = previousActivity
    await rm(dir, { recursive: true, force: true })
  }
}

test('vault credential registration is idempotent and legacy duplicates can be cleaned', async () => {
  await withVault(async ({ addCredential, listCredentials, deduplicateCredentials }) => {
    const owner = '0xABC'
    const first = addCredential(owner, { type: 'eoa', label: 'MetaMask EOA', value: '0xsecret' })
    const second = addCredential(owner, { type: 'eoa', label: 'MetaMask EOA', value: '0xsecret' })
    assert.equal(first.deduplicated, false)
    assert.equal(second.deduplicated, true)
    assert.equal(listCredentials(owner).length, 1)

    // Simulate old bloat directly in the isolated store and verify cleanup.
    const fs = await import('node:fs/promises')
    const raw = JSON.parse(await fs.readFile(process.env.VAULT_PATH, 'utf8'))
    raw.credentials.push({ id: 'legacy-duplicate', owner, type: 'eoa', label: 'old', value: '0xsecret', createdAt: 1 })
    await fs.writeFile(process.env.VAULT_PATH, JSON.stringify(raw), 'utf8')
    const result = deduplicateCredentials(owner)
    assert.equal(result.removed, 1)
    assert.equal(result.credentials.length, 1)
  })
})

test('auto-approved approvals expose approval and completion timestamps', async () => {
  await withVault(async ({ createApproval, listApprovals, updateApprovalStatus }) => {
    const approval = createApproval('0xowner', {
      agent: 'claude-mcp', action: 'send', amount: '1', token: 'USDC', source: 'session', forcePending: false,
    })
    assert.equal(approval.status, 'auto_approved')
    assert.equal(typeof approval.approvedAt, 'number')
    assert.equal(approval.completedAt, undefined)
    assert.ok(approval.approvedAt >= approval.createdAt)

    const updated = updateApprovalStatus('0xowner', approval.id, 'success', { txHash: '0xabc' })
    assert.equal(typeof updated.completedAt, 'number')
    assert.ok(updated.completedAt >= approval.createdAt)
    assert.equal(listApprovals('0xowner')[0].completedAt, updated.completedAt)
    assert.equal(updated.status, 'success')
  })
})
