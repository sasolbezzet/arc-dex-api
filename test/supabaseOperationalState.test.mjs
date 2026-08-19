import assert from 'node:assert/strict'
import test from 'node:test'

process.env.SUPABASE_PERSISTENCE_MODE = 'off'

const {
  claimWebhookEvent,
  claimAutoMintLease,
  releaseAutoMintLease,
  supabaseOperationalStatus,
} = await import('../src/services/supabaseOperationalState.mjs')

test('operational persistence falls back safely when Supabase is disabled', async () => {
  const event = {
    provider: 'circle-wallets',
    notificationId: 'local-test-event',
    eventType: 'webhooks.test',
  }
  const webhook = await claimWebhookEvent(event, 'local-webhook-lease')
  assert.equal(webhook.enabled, false)
  assert.equal(webhook.claimed, true)
  assert.equal(webhook.duplicate, false)

  const job = {
    jobId: '0x' + '1'.repeat(64),
    burnTx: '0x' + '2'.repeat(64),
    owner: '0x1111111111111111111111111111111111111111',
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
  }
  const lease = await claimAutoMintLease(job, 'local-auto-mint-lease')
  assert.equal(lease.enabled, false)
  assert.equal(lease.claimed, true)
  assert.equal(lease.conflict, false)
  assert.equal((await releaseAutoMintLease(job.jobId, lease.leaseToken)).released, false)
  assert.equal(supabaseOperationalStatus().webhookPrimary, false)
  assert.equal(supabaseOperationalStatus().autoMintPrimary, false)
})
