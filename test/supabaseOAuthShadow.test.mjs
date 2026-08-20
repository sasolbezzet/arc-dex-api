import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_PERSISTENCE_MODE = 'off'

const {
  buildOAuthShadowRow,
  supabaseOAuthShadowStatus,
} = await import('../src/services/supabaseOAuthShadow.mjs?oauth-shadow-' + Date.now())

test('OAuth shadow row stores only hashed metadata and no bearer secrets', () => {
  const row = buildOAuthShadowRow({
    stateKey: 'raw-authorization-code',
    stateType: 'authorization_code',
    expiresAt: Date.now() + 60_000,
    payload: {
      clientId: 'client-id',
      userId: '0x1111111111111111111111111111111111111111',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'pkce-challenge',
      state: 'csrf-state',
      requestId: 'request-id',
      challengeNonce: 'raw-nonce',
      resource: 'https://arcoxdex.vercel.app/mcp',
      mscaWalletAddress: '0x2222222222222222222222222222222222222222',
      code: 'raw-code',
      message: 'raw SIWE message',
      signature: 'raw signature',
    },
  })

  assert.ok(row)
  assert.notEqual(row.state_key, 'raw-authorization-code')
  assert.equal(row.payload.clientId, undefined)
  assert.equal(row.payload.userId, undefined)
  assert.equal(row.payload.redirectUri, undefined)
  assert.equal(row.payload.code, undefined)
  assert.equal(row.payload.message, undefined)
  assert.equal(row.payload.signature, undefined)
  assert.equal(row.payload.hasPkceChallenge, true)
  assert.equal(row.payload.hasMscaWalletAddress, true)
})

test('OAuth shadow is non-primary and disabled in test mode', () => {
  const status = supabaseOAuthShadowStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.primary, false)
})
