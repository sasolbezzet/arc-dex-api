import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Endpoint-level guard for the Circle Wallets/Contracts webhook. The catalog and
// normalizer have unit tests; this file proves the actual HTTP route verifies the
// signature, accepts every family ARCOX subscribes to, persists the event, and
// rejects types it cannot route.
const TX = '0x' + 'a'.repeat(64)
const MSCA = '0x1111111111111111111111111111111111111111'
const CONTRACT = '0x4abcffb90897fe7ce86ed689d1178076544a021b'
const AUTH_SECRET = 'test-circle-webhook-secret'

// Token owner sama bentuknya dengan createAuthToken di server.mjs.
function ownerToken(address) {
  const payload = Buffer.from(JSON.stringify({ address: address.toLowerCase(), exp: Date.now() + 60_000 })).toString('base64url')
  const signature = createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

// server.mjs memuat `.env` lewat dotenv, jadi environment test harus eksplisit —
// kalau tidak, hasilnya bergantung pada .env mesin yang menjalankan test.
async function withHttp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-circle-webhook-'))
  const names = [
    'VERCEL', 'AUTH_SECRET', 'ARC_NETWORK', 'CIRCLE_API_KEY', 'CIRCLE_API_KEY_MAINNET',
    'CIRCLE_CLIENT_URL', 'CIRCLE_CLIENT_KEY', 'CIRCLE_CLIENT_KEY_LIVE',
    'CIRCLE_ENTITY_SECRET', 'CIRCLE_ENTITY_SECRET_MAINNET', 'CIRCLE_WEBHOOK_API_BASE_URL',
    'SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH', 'VAULT_ACTIVITY_PATH',
    'VAULT_SESSION_PATH', 'OAUTH_PATH', 'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH',
    'WALLET_DB', 'TX_HISTORY_DB', 'INVOICE_DB', 'WEBHOOK_DB', 'AUTO_MINT_DB',
    'SERVER_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PERSISTENCE_MODE',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.VERCEL = '1'
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.ARC_NETWORK = 'testnet'
  process.env.CIRCLE_CLIENT_URL = 'https://circle.test/v1/rpc/w3s/buidl'
  process.env.CIRCLE_CLIENT_KEY = 'test-circle-client-key'
  process.env.CIRCLE_CLIENT_KEY_LIVE = 'live-circle-client-key'
  process.env.CIRCLE_API_KEY = 'TEST_API_KEY:test:test'
  process.env.CIRCLE_API_KEY_MAINNET = 'LIVE_API_KEY:test:test'
  // Developer-controlled wallet adapter (>= 1.8.0) memvalidasi entity secret
  // saat konstruksi, jadi test memberi nilai yang valid untuk kedua environment.
  process.env.CIRCLE_ENTITY_SECRET = 'a'.repeat(64)
  process.env.CIRCLE_ENTITY_SECRET_MAINNET = 'b'.repeat(64)
  process.env.CIRCLE_WEBHOOK_API_BASE_URL = 'https://circle.test'
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  process.env.OAUTH_PATH = join(dir, 'oauth-clients.json')
  process.env.OAUTH_TOKENS_PATH = join(dir, 'oauth-tokens.json')
  process.env.OAUTH_STATE_PATH = join(dir, 'oauth-state.json')
  process.env.WALLET_DB = join(dir, 'wallets.json')
  process.env.TX_HISTORY_DB = join(dir, 'tx-history.json')
  process.env.INVOICE_DB = join(dir, 'invoices.json')
  process.env.WEBHOOK_DB = join(dir, 'webhooks.json')
  process.env.AUTO_MINT_DB = join(dir, 'auto-mint.json')
  process.env.SERVER_URL = 'https://arcoxdex.vercel.app'
  process.env.SUPABASE_URL = ''
  process.env.SUPABASE_SERVICE_ROLE_KEY = ''
  process.env.SUPABASE_PERSISTENCE_MODE = 'off'

  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {}, agentBindings: {} }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {} }))

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const encodedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  // Key ID unik per skenario: cache public key di x402Middleware bertahan antar
  // import modul, jadi key ID yang sama akan memakai kunci lama dan menolak
  // signature skenario berikutnya.
  const keyId = `test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const previousFetch = globalThis.fetch
  let localBase = ''
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(localBase)) return previousFetch(url, options)
    if (String(url).includes('/v2/notifications/publicKey/')) {
      return new Response(JSON.stringify({ data: { algorithm: 'ECDSA_SHA_256', publicKey: encodedPublicKey } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const { app } = await import('../server.mjs?circle-webhook-http-' + Date.now() + '-' + Math.random())
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      localBase = `http://127.0.0.1:${listener.address().port}`
      const deliver = async (payload, { signed = true } = {}) => {
        const rawBody = JSON.stringify(payload)
        const headers = { 'Content-Type': 'application/json' }
        if (signed) {
          headers['X-Circle-Key-Id'] = keyId
          headers['X-Circle-Signature'] = sign('sha256', Buffer.from(rawBody), privateKey).toString('base64')
        }
        const response = await previousFetch(`${localBase}/api/webhooks/circle-wallet`, { method: 'POST', headers, body: rawBody })
        return { status: response.status, body: await response.json() }
      }
      const get = async (path, headers = {}) => {
        const response = await previousFetch(`${localBase}${path}`, { headers })
        return { status: response.status, body: await response.json() }
      }
      await fn({ deliver, get })
    } finally {
      await new Promise(resolve => listener.close(resolve))
    }
  } finally {
    globalThis.fetch = previousFetch
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('GET advertises the notification types the endpoint can route', async () => {
  await withHttp(async ({ get }) => {
    const result = await get('/api/webhooks/circle-wallet')
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(result.body.product, 'wallets')
    assert.deepEqual(result.body.notificationTypes, [
      'transactions.*', 'challenges.*', 'contracts.*', 'modularWallet.*', 'travelRule.*', 'rampSession.*',
    ])
    assert.deepEqual(result.body.catalog.rampSession, [
      'rampSession.completed', 'rampSession.depositReceived', 'rampSession.expired',
      'rampSession.failed', 'rampSession.kycApproved', 'rampSession.kycRejected', 'rampSession.kycSubmitted',
    ])
  })
})

test('webhook verifies the signature and routes every subscribed family', async () => {
  await withHttp(async ({ deliver }) => {
    const unsigned = await deliver({ notificationId: 'n-0', notificationType: 'transactions.inbound', notification: {} }, { signed: false })
    assert.equal(unsigned.status, 401)
    assert.equal(unsigned.body.ok, false)

    const cases = [
      ['transactions.inbound', { notification: { state: 'CONFIRMED', txHash: TX, walletAddress: MSCA, blockchain: 'ARC-TESTNET' } }, 'transactions', 'confirmed'],
      ['transactions.outbound', { notification: { state: 'COMPLETE', txHash: TX, walletAddress: MSCA } }, 'transactions', 'complete'],
      ['challenges.createWallet', { notification: { id: 'challenge-1', status: 'COMPLETE', walletId: 'wallet-1' } }, 'challenges', 'complete'],
      ['challenges.setPin', { notification: { id: 'challenge-2', status: 'PENDING' } }, 'challenges', 'pending'],
      ['contracts.eventLog', { notification: { contractAddress: CONTRACT, blockchain: 'ARC-TESTNET', txHash: TX, eventSignature: 'Transfer(address,address,uint256)' } }, 'contracts', null],
      ['modularWallet.userOperation', { notification: { walletAddress: MSCA, userOpHash: TX, status: 'COMPLETE' } }, 'modularWallet', 'complete'],
      ['modularWallet.inboundTransfer', { notification: { walletAddress: MSCA, txHash: TX, state: 'COMPLETE' } }, 'modularWallet', 'complete'],
      ['rampSession.kycApproved', { notification: { id: 'session-1', kycStatus: 'APPROVED' } }, 'rampSession', null],
      ['rampSession.completed', { notification: { id: 'session-2', status: 'COMPLETED' } }, 'rampSession', 'completed'],
      ['webhooks.test', { notification: {} }, 'test', null],
    ]

    let index = 0
    for (const [notificationType, rest, family, status] of cases) {
      index += 1
      const result = await deliver({ notificationId: `n-${index}`, notificationType, subscriptionId: 'sub-1', ...rest })
      assert.equal(result.status, 200, `${notificationType}: ${JSON.stringify(result.body)}`)
      assert.equal(result.body.ok, true)
      assert.equal(result.body.eventType, notificationType)
      assert.equal(result.body.family, family, notificationType)
      if (status) assert.equal(result.body.status, status, notificationType)
    }
  })
})

test('webhook rejects a type outside the catalog and lists what it supports', async () => {
  await withHttp(async ({ deliver }) => {
    const result = await deliver({ notificationId: 'n-bad', notificationType: 'gateway.mint.finalized', notification: {} })
    assert.equal(result.status, 400)
    assert.equal(result.body.ok, false)
    assert.match(result.body.error, /Unsupported/)
    assert.ok(result.body.supportedNotificationTypes.includes('transactions.*'))
    assert.ok(result.body.supportedNotificationTypes.includes('contracts.*'))
    assert.ok(result.body.supportedNotificationTypes.includes('rampSession.*'))
    assert.equal(result.body.supportedNotificationTypes.includes('webhooks.test'), false)
  })
})

test('inbox lists stored events for an authenticated owner without leaking payloads', async () => {
  await withHttp(async ({ deliver, get }) => {
    await deliver({ notificationId: 'inbox-1', notificationType: 'challenges.createWallet', notification: { id: 'challenge-7', status: 'COMPLETE', walletAddress: MSCA } })
    await deliver({ notificationId: 'inbox-2', notificationType: 'rampSession.kycApproved', notification: { id: 'session-7', kycStatus: 'APPROVED' } })
    await deliver({ notificationId: 'inbox-3', notificationType: 'transactions.inbound', notification: { state: 'CONFIRMED', txHash: TX, walletAddress: MSCA } })

    const unauthorized = await get('/api/webhooks/events')
    assert.equal(unauthorized.status, 401)

    const inbox = await get('/api/webhooks/events?limit=10', { Authorization: `Bearer ${ownerToken(MSCA)}` })
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body))
    assert.equal(inbox.body.ok, true)
    assert.equal(inbox.body.total, 3)
    assert.equal(inbox.body.families.challenges, 1)
    assert.equal(inbox.body.families.rampSession, 1)
    assert.equal(inbox.body.families.transactions, 1)
    // Terbaru lebih dulu.
    assert.deepEqual(inbox.body.events.map(event => event.eventType), ['transactions.inbound', 'rampSession.kycApproved', 'challenges.createWallet'])
    const challenge = inbox.body.events.find(event => event.family === 'challenges')
    assert.equal(challenge.reference.challengeId, 'challenge-7')
    const ramp = inbox.body.events.find(event => event.family === 'rampSession')
    assert.equal(ramp.reference.sessionId, 'session-7')
    // Payload mentah dan alamat wallet tidak pernah ikut terkirim.
    const serialized = JSON.stringify(inbox.body)
    assert.equal(serialized.includes('rawPayload'), false)
    assert.equal(serialized.includes(MSCA), false)

    const filtered = await get('/api/webhooks/events?family=rampSession', { Authorization: `Bearer ${ownerToken(MSCA)}` })
    assert.equal(filtered.body.total, 1)
    assert.equal(filtered.body.events[0].eventType, 'rampSession.kycApproved')

    // Ringkasan status tetap dihitung dari seluruh event, bukan hasil filter.
    assert.equal(inbox.body.state.challenges.length, 1)
    assert.equal(inbox.body.state.challenges[0].challengeId, 'challenge-7')
    assert.equal(inbox.body.state.challenges[0].succeeded, true)
    assert.equal(inbox.body.state.rampSessions.length, 1)
    assert.equal(inbox.body.state.rampSessions[0].sessionId, 'session-7')
    assert.deepEqual(inbox.body.state.failures, [])
    assert.equal(filtered.body.state.rampSessions.length, 1)
  })
})

test('inbox surfaces failed challenges and ramp sessions', async () => {
  await withHttp(async ({ deliver, get }) => {
    await deliver({ notificationId: 'fail-1', notificationType: 'challenges.setPin', notification: { id: 'challenge-fail', status: 'FAILED' } })
    await deliver({ notificationId: 'fail-2', notificationType: 'rampSession.kycRejected', notification: { id: 'session-fail', kycStatus: 'REJECTED' } })

    const inbox = await get('/api/webhooks/events', { Authorization: `Bearer ${ownerToken(MSCA)}` })
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body))
    const challenge = inbox.body.state.challenges.find(item => item.challengeId === 'challenge-fail')
    assert.equal(challenge.failed, true)
    assert.equal(challenge.status, 'failed')
    const session = inbox.body.state.rampSessions.find(item => item.sessionId === 'session-fail')
    assert.equal(session.failed, true)
    assert.equal(session.kycStatus, 'REJECTED')
    assert.deepEqual(inbox.body.state.failures.map(failure => failure.eventType), ['rampSession.kycRejected', 'challenges.setPin'])
  })
})

test('webhook deduplicates by notificationId and requires one', async () => {
  await withHttp(async ({ deliver }) => {
    const payload = { notificationId: 'dup-1', notificationType: 'challenges.initialize', notification: { id: 'challenge-9', status: 'COMPLETE' } }
    const first = await deliver(payload)
    assert.equal(first.status, 200)
    assert.equal(first.body.duplicate, false)
    const second = await deliver(payload)
    assert.equal(second.status, 200)
    assert.equal(second.body.duplicate, true)

    const missing = await deliver({ notificationType: 'challenges.initialize', notification: {} })
    assert.equal(missing.status, 400)
    assert.match(missing.body.error, /notificationId/)
  })
})
