import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { verifyCircleWebhookSignature } from '../src/middleware/x402Middleware.mjs'

test('verifies Circle ECDSA webhook signatures and rejects a modified body', async () => {
  const previousApiKey = process.env.CIRCLE_API_KEY
  const previousBaseUrl = process.env.CIRCLE_BASE_URL
  const previousFetch = globalThis.fetch
  const keyId = `test-key-${Date.now()}`
  const rawBody = JSON.stringify({ notificationId: 'notification-1', status: 'complete' })
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const signature = sign('sha256', Buffer.from(rawBody), privateKey).toString('base64')
  const encodedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

  process.env.CIRCLE_API_KEY = 'test_circle_api_key'
  process.env.CIRCLE_BASE_URL = 'https://circle.test'
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `https://circle.test/v2/notifications/publicKey/${keyId}`)
    assert.equal(options.headers.Authorization, 'Bearer test_circle_api_key')
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { id: keyId, algorithm: 'ECDSA_SHA_256', publicKey: encodedPublicKey } }),
    }
  }

  try {
    const req = { headers: { 'x-circle-key-id': keyId, 'x-circle-signature': signature } }
    assert.deepEqual(await verifyCircleWebhookSignature(req, rawBody), { ok: true })
    assert.deepEqual(await verifyCircleWebhookSignature(req, `${rawBody} `), { ok: false, error: 'Invalid Circle webhook signature' })
  } finally {
    if (previousApiKey === undefined) delete process.env.CIRCLE_API_KEY
    else process.env.CIRCLE_API_KEY = previousApiKey
    if (previousBaseUrl === undefined) delete process.env.CIRCLE_BASE_URL
    else process.env.CIRCLE_BASE_URL = previousBaseUrl
    globalThis.fetch = previousFetch
  }
})
