import assert from 'node:assert/strict'
import test from 'node:test'

process.env.SUPABASE_PERSISTENCE_MODE = 'off'

const { shadowReadWebhookEvent, supabasePersistenceStatus } = await import('../src/services/supabasePersistence.mjs')

test('webhook shadow-read stays JSON-only when Supabase persistence is disabled', async () => {
  const local = {
    id: 'wh_test',
    provider: 'circle-wallets',
    notificationId: 'notification_test',
    eventType: 'webhooks.test',
    processed: true,
    matched: false,
  }

  const result = await shadowReadWebhookEvent(local.provider, local.notificationId, local)

  assert.equal(result.source, 'json')
  assert.equal(result.compared, false)
  assert.equal(result.event, local)
  assert.equal(supabasePersistenceStatus().webhookReadPrimary, false)
})
