import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const names = [
  'VERCEL', 'KIT_KEY', 'PORT', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_PERSISTENCE_MODE', 'SERVER_URL', 'WALLET_DB', 'TX_HISTORY_DB',
  'INVOICE_DB', 'WEBHOOK_DB', 'AUTO_MINT_DB', 'SESSION_KEYS_PATH',
  'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH', 'VAULT_ACTIVITY_PATH',
  'VAULT_SESSION_PATH', 'OAUTH_PATH', 'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH',
]

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-public-config-'))
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.VERCEL = '1'
  process.env.KIT_KEY = 'server-secret-kit-key'
  process.env.SUPABASE_URL = ''
  process.env.SUPABASE_SERVICE_ROLE_KEY = ''
  process.env.SUPABASE_PERSISTENCE_MODE = 'off'
  process.env.SERVER_URL = 'https://arcoxdex.vercel.app'
  process.env.WALLET_DB = join(dir, 'wallets.json')
  process.env.TX_HISTORY_DB = join(dir, 'tx-history.json')
  process.env.INVOICE_DB = join(dir, 'invoices.json')
  process.env.WEBHOOK_DB = join(dir, 'webhooks.json')
  process.env.AUTO_MINT_DB = join(dir, 'auto-mint.json')
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  process.env.OAUTH_PATH = join(dir, 'oauth-clients.json')
  process.env.OAUTH_TOKENS_PATH = join(dir, 'oauth-tokens.json')
  process.env.OAUTH_STATE_PATH = join(dir, 'oauth-state.json')
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {}, agentBindings: {} }))
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [], agentCardLinks: {} }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {} }))

  try {
    const { app } = await import('../server.mjs?public-config-' + Date.now() + '-' + Math.random())
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      await fn(`http://127.0.0.1:${listener.address().port}`)
    } finally {
      await new Promise(resolve => listener.close(resolve))
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(dir, { recursive: true, force: true })
  }
}

test('public config reports App Kit availability without exposing KIT_KEY', async () => {
  await withServer(async base => {
    const configResponse = await fetch(`${base}/api/config`)
    const config = await configResponse.json()
    assert.equal(configResponse.status, 200)
    assert.deepEqual(config, { appKitConfigured: true })
    assert.equal(JSON.stringify(config).includes('server-secret-kit-key'), false)

    const healthResponse = await fetch(`${base}/health`)
    const health = await healthResponse.json()
    assert.equal(healthResponse.status, 200)
    assert.equal(health.ok, true)
    assert.equal(health.version, '2.0.0')
  })
})
