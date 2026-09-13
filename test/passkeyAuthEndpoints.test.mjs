import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT_KEY = 'oauth:arcox_http_test'
const TEST_AUTH_SECRET = 'test-passkey-auth-secret'

function ownerToken(secret) {
  const payload = Buffer.from(JSON.stringify({
    address: OWNER.toLowerCase(),
    exp: Date.now() + 10 * 60 * 1000,
  })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

async function withHttp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-passkey-http-'))
  const secret = TEST_AUTH_SECRET
  const names = [
    'VERCEL', 'AUTH_SECRET', 'CIRCLE_CLIENT_URL', 'CIRCLE_CLIENT_KEY',
    'SESSION_KEYS_PATH', 'SESSION_KEY_ENCRYPTION_KEY', 'VAULT_PATH',
    'VAULT_ACTIVITY_PATH', 'VAULT_SESSION_PATH', 'OAUTH_PATH',
    'OAUTH_TOKENS_PATH', 'OAUTH_STATE_PATH', 'WALLET_DB', 'TX_HISTORY_DB',
    'INVOICE_DB', 'WEBHOOK_DB', 'AUTO_MINT_DB', 'SERVER_URL',
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PERSISTENCE_MODE',
  ]
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.VERCEL = '1'
  process.env.AUTH_SECRET = secret
  process.env.CIRCLE_CLIENT_URL = 'https://circle.test/v1/rpc/w3s/buidl'
  process.env.CIRCLE_CLIENT_KEY = 'test-circle-client-key'
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
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [], agentCardLinks: {} }))
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
  await writeFile(process.env.OAUTH_PATH, JSON.stringify({ clients: {} }))
  await writeFile(process.env.OAUTH_TOKENS_PATH, JSON.stringify({ tokens: {}, refresh: {} }))
  await writeFile(process.env.OAUTH_STATE_PATH, JSON.stringify({ codes: {}, requests: {}, challenges: {} }))

  const previousFetch = globalThis.fetch
  const circleRequests = []
  let localBase = ''
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(localBase)) return previousFetch(url, options)
    circleRequests.push({ url: String(url), options })
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 'circle-test',
      result: {
        challenge: 'AQ',
        rpId: 'arcoxdex.vercel.app',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  try {
    const { app } = await import('../server.mjs?passkey-http-' + Date.now() + '-' + Math.random())
    const listener = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server))
      server.on('error', reject)
    })
    try {
      localBase = `http://127.0.0.1:${listener.address().port}`
      await fn({ base: localBase, token: ownerToken(secret), circleRequests })
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

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, body: await response.json() }
}

test('Passkey options are issued before SIWE, while registration verification still requires owner proof', async () => {
  await withHttp(async ({ base, circleRequests }) => {
    const loginOptions = await post(base, '/api/auth/passkey-options', {
      mode: 'Login',
      agentKey: AGENT_KEY,
    })
    assert.equal(loginOptions.response.status, 200, JSON.stringify(loginOptions.body))
    assert.equal(loginOptions.body.success, true)
    assert.equal(loginOptions.body.options.challenge, 'AQ')

    const registerOptions = await post(base, '/api/auth/passkey-options', {
      mode: 'Register',
      agentKey: AGENT_KEY,
      username: 'test-agent-registration',
    })
    assert.equal(registerOptions.response.status, 200, JSON.stringify(registerOptions.body))
    assert.equal(registerOptions.body.success, true)
    assert.ok(registerOptions.body.flowId)
    assert.equal(circleRequests.length, 2)
  })
})

test('Plugin passkey-options forwards a valid owner proof to Circle', async () => {
  await withHttp(async ({ base, token, circleRequests }) => {
    const result = await post(base, '/api/auth/passkey-options', {
      mode: 'Login',
      agentKey: AGENT_KEY,
      ownerAddress: OWNER,
      ownerSessionToken: token,
    })
    assert.equal(result.response.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.success, true, JSON.stringify(result.body))
    assert.ok(result.body.flowId)
    assert.equal(result.body.options.challenge, 'AQ')
    assert.equal(circleRequests.length, 1)
    assert.equal(circleRequests[0].url, 'https://circle.test/v1/rpc/w3s/buidl')
    assert.equal(circleRequests[0].options.headers.Authorization, 'Bearer test-circle-client-key')
    const request = JSON.parse(circleRequests[0].options.body)
    assert.equal(request.method, 'rp_getLoginOptions')
  })
})
