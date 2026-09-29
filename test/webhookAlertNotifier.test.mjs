import assert from 'node:assert/strict'
import test from 'node:test'

async function load() {
  return import('../src/services/webhookAlertNotifier.mjs?notifier=' + Date.now() + '-' + Math.random())
}

const ALERT = {
  eventType: 'rampSession.kycRejected',
  family: 'rampSession',
  status: 'rejected',
  subjectId: 'session-1',
  walletAddress: '0x1111111111111111111111111111111111111111',
  createdAt: '2026-09-30T00:00:00.000Z',
}

test('targets are only built from configured environment', async () => {
  const { resolveWebhookAlertTargets } = await load()
  assert.deepEqual(resolveWebhookAlertTargets({}), [])
  // Token tanpa chat id belum cukup untuk mengirim.
  assert.deepEqual(resolveWebhookAlertTargets({ TELEGRAM_BOT_TOKEN: 'token' }), [])
  const telegram = resolveWebhookAlertTargets({ TELEGRAM_BOT_TOKEN: 'tok-123', TELEGRAM_CHAT_ID: '42' })
  assert.equal(telegram.length, 1)
  assert.equal(telegram[0].kind, 'telegram')
  assert.equal(telegram[0].url, 'https://api.telegram.org/bottok-123/sendMessage')
  assert.equal(telegram[0].chatId, '42')
  const generic = resolveWebhookAlertTargets({ WEBHOOK_ALERT_URL: 'https://hooks.example/alert' })
  assert.deepEqual(generic, [{ kind: 'webhook', url: 'https://hooks.example/alert' }])
})

test('message summarises the failed event', async () => {
  const { buildWebhookFailureMessage } = await load()
  const message = buildWebhookFailureMessage(ALERT)
  assert.match(message, /ARCOX webhook failure/)
  assert.match(message, /rampSession\.kycRejected/)
  assert.match(message, /rampSession/)
  assert.match(message, /session-1/)
  assert.match(message, /0x1111111111111111111111111111111111111111/)
  assert.match(buildWebhookFailureMessage({ ...ALERT, simulated: true }), /simulated event/)
})

test('notifier is a no-op when nothing is configured', async () => {
  const { notifyWebhookFailure, resetWebhookAlertThrottle } = await load()
  resetWebhookAlertThrottle()
  const result = await notifyWebhookFailure(ALERT, { env: {}, fetchImpl: () => { throw new Error('must not be called') } })
  assert.equal(result.sent, 0)
  assert.equal(result.skipped, 'not_configured')
})

test('notifier posts to Telegram and a generic webhook', async () => {
  const { notifyWebhookFailure, resetWebhookAlertThrottle } = await load()
  resetWebhookAlertThrottle()
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 200 }
  }
  const env = { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '7', WEBHOOK_ALERT_URL: 'https://hooks.example/alert' }
  const result = await notifyWebhookFailure(ALERT, { env, fetchImpl })
  assert.equal(result.sent, 2)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.chat_id, '7')
  assert.match(calls[0].body.text, /rampSession\.kycRejected/)
  assert.equal(calls[1].body.alert.eventType, 'rampSession.kycRejected')
})

test('repeat failures for the same subject are throttled', async () => {
  const { notifyWebhookFailure, resetWebhookAlertThrottle } = await load()
  resetWebhookAlertThrottle()
  const fetchImpl = async () => ({ ok: true, status: 200 })
  const env = { WEBHOOK_ALERT_URL: 'https://hooks.example/alert' }
  const now = 1_000_000
  const first = await notifyWebhookFailure(ALERT, { env, fetchImpl, now })
  const second = await notifyWebhookFailure(ALERT, { env, fetchImpl, now: now + 1000 })
  const later = await notifyWebhookFailure(ALERT, { env, fetchImpl, now: now + 11 * 60 * 1000 })
  assert.equal(first.sent, 1)
  assert.equal(second.skipped, 'throttled')
  assert.equal(later.sent, 1)
})

test('delivery failures never throw', async () => {
  const { notifyWebhookFailure, resetWebhookAlertThrottle } = await load()
  resetWebhookAlertThrottle()
  const env = { WEBHOOK_ALERT_URL: 'https://hooks.example/alert' }
  const throwing = await notifyWebhookFailure(ALERT, { env, fetchImpl: async () => { throw new Error('network down') } })
  assert.equal(throwing.sent, 0)
  assert.equal(throwing.skipped, 'delivery_failed')

  resetWebhookAlertThrottle()
  const rejected = await notifyWebhookFailure(ALERT, { env, fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(rejected.sent, 0)
  assert.equal(rejected.skipped, 'delivery_failed')
})
