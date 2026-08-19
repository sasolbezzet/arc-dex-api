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
