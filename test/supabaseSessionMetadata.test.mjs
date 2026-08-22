import test from 'node:test'
import assert from 'node:assert/strict'

// This suite runs with the repository's test environment, where persistence is
// disabled. It verifies the serialization contract without touching Supabase.
test('session metadata snapshot excludes encrypted delegate keys and raw operation data', async () => {
  const { buildSessionMetadataPayloads } = await import('../src/services/supabasePersistence.mjs?session-metadata-shape-' + Date.now())
  const rows = buildSessionMetadataPayloads({
    aliases: {
      '0x1111111111111111111111111111111111111111': '0x2222222222222222222222222222222222222222',
    },
    users: {
      '0x2222222222222222222222222222222222222222': {
        walletAddress: '0x2222222222222222222222222222222222222222',
        delegateAddress: '0x3333333333333333333333333333333333333333',
        delegatePrivateKey: 'encrypted-secret-must-not-escape',
        active: true,
        pendingAuthorization: false,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
        authorizationUserOpHashes: { 'arc-testnet': '0x' + 'a'.repeat(64) },
        chain: 'arc-testnet',
        createdAt: Date.now(),
      },
    },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].wallet_address, '0x2222222222222222222222222222222222222222')
  assert.deepEqual(rows[0].owner_addresses, ['0x1111111111111111111111111111111111111111'])
  assert.equal(Object.hasOwn(rows[0], 'delegate_private_key'), false)
  assert.equal(Object.hasOwn(rows[0], 'signed_user_operation'), false)
  assert.equal(Object.hasOwn(rows[0], 'calldata'), false)
})

test('session metadata shadow read falls back to the local metadata when disabled', async () => {
  const { shadowReadSessionMetadata } = await import('../src/services/supabasePersistence.mjs?session-metadata-fallback-' + Date.now())
  const fallback = { walletAddress: '0x2222222222222222222222222222222222222222', active: true }
  const result = await shadowReadSessionMetadata(fallback.walletAddress, fallback)
  assert.equal(result.source, 'json')
  assert.equal(result.compared, false)
  assert.deepEqual(result.metadata, fallback)
})

test('mergeSessionMetadata: local activation state always wins over remote', async () => {
  const { mergeSessionMetadata } = await import('../src/services/supabasePersistence.mjs?session-merge-1-' + Date.now())
  const remote = {
    walletAddress: '0x2222222222222222222222222222222222222222',
    delegateAddress: '0x9999999999999999999999999999999999999999',
    active: true,
    chain: 'base-sepolia',
    ownerAddresses: ['0x1111111111111111111111111111111111111111'],
  }
  const local = {
    walletAddress: '0x2222222222222222222222222222222222222222',
    delegateAddress: '0x3333333333333333333333333333333333333333',
    active: false,
    chain: 'arc-testnet',
    revokeReason: 'manual',
    ownerAddresses: [],
  }
  const merged = mergeSessionMetadata(remote, local)
  assert.equal(merged.active, false, 'local inactive must win over remote active')
  assert.equal(merged.delegateAddress, local.delegateAddress, 'local signer wins')
  assert.equal(merged.chain, local.chain, 'local chain wins')
  assert.equal(merged.revokeReason, 'manual', 'local reason kept')
  assert.deepEqual(merged.ownerAddresses, ['0x1111111111111111111111111111111111111111'], 'owner addresses union')
})

test('mergeSessionMetadata: remote-only record is a recovery view, never active', async () => {
  const { mergeSessionMetadata } = await import('../src/services/supabasePersistence.mjs?session-merge-2-' + Date.now())
  const remote = {
    walletAddress: '0x2222222222222222222222222222222222222222',
    delegateAddress: '0x3333333333333333333333333333333333333333',
    active: true,
  }
  const merged = mergeSessionMetadata(remote, null)
  assert.equal(merged.active, false, 'remote-only must never surface as active')
  assert.equal(merged.stale, true)
  assert.equal(merged.recovery, true)
  assert.equal(merged.delegateAddress, '0x3333333333333333333333333333333333333333', 'display fields still available')
})

// These two suites need Supabase disabled at import time (the shell can carry
// live SUPABASE_URL + service-role key; module state reads env on load).
function withSupabaseDisabled(fn) {
  return async () => {
    const previousUrl = process.env.SUPABASE_URL
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    process.env.SUPABASE_URL = ''
    process.env.SUPABASE_SERVICE_ROLE_KEY = ''
    try {
      await fn()
    } finally {
      if (previousUrl === undefined) delete process.env.SUPABASE_URL
      else process.env.SUPABASE_URL = previousUrl
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey
    }
  }
}

test('readSessionMetadata falls back to local when Supabase is disabled', withSupabaseDisabled(async () => {
  const { readSessionMetadata } = await import('../src/services/supabasePersistence.mjs?session-read-1-' + Date.now())
  const local = { walletAddress: '0x2222222222222222222222222222222222222222', active: true }
  const result = await readSessionMetadata(local.walletAddress, local)
  assert.equal(result.source, 'json')
  assert.equal(result.metadata, local)
}))

test('readRefundAuditLog falls back to the in-memory log when Supabase is disabled', withSupabaseDisabled(async () => {
  const { readRefundAuditLog } = await import('../src/services/supabasePersistence.mjs?refund-audit-1-' + Date.now())
  const local = [
    { invoiceId: 'inv-1', action: 'refund_approved', at: '2026-08-22T00:00:00.000Z', amount: '0.03' },
    { invoiceId: 'inv-2', action: 'refund_executed', at: '2026-08-22T00:01:00.000Z', amount: '0.01' },
  ]
  const result = await readRefundAuditLog({ limit: 10 }, local)
  assert.equal(result.source, 'json')
  assert.equal(result.entries.length, 2)
  const filtered = await readRefundAuditLog({ invoiceId: 'inv-1', limit: 10 }, local)
  assert.equal(filtered.entries.length, 1)
  assert.equal(filtered.entries[0].invoiceId, 'inv-1')
}))
