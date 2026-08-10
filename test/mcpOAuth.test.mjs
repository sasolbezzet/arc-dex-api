import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createAuthCode, exchangeCodeForToken, findExistingAuthCode, registerOAuthClient } from '../src/services/mcpServer.mjs'

test('repeated SIWE verification reuses the same pending authorization code', () => {
  const redirectUri = 'https://client.example/callback'
  const challenge = createHash('sha256').update('retry-verifier-1234567890').digest('base64url')
  const client = registerOAuthClient({ clientName: 'mcp-oauth-retry-test', redirectUris: [redirectUri] })
  const options = { redirectUri, codeChallenge: challenge, state: 'retry-state' }
  const first = createAuthCode(client.clientId, '0x2222222222222222222222222222222222222222', options)
  assert.equal(findExistingAuthCode(client.clientId, '0x2222222222222222222222222222222222222222', options), first)
  assert.equal(findExistingAuthCode(client.clientId, '0x3333333333333333333333333333333333333333', options), null)
})

test('persisted authorization request survives a fresh worker before SIWE challenge', () => {
  const directory = mkdtempSync(`${tmpdir()}/arcox-oauth-`)
  const env = {
    ...process.env,
    OAUTH_PATH: `${directory}/clients.json`,
    OAUTH_TOKENS_PATH: `${directory}/tokens.json`,
    OAUTH_STATE_PATH: `${directory}/state.json`,
  }
  const moduleUrl = new URL('../src/services/mcpServer.mjs', import.meta.url).href
  const phaseOne = `
    import { registerOAuthClient, oauthAuthorizeHandler } from ${JSON.stringify(moduleUrl)}
    const client = registerOAuthClient({ clientName: 'cross-worker-test', redirectUris: ['https://client.example/callback'] })
    const capture = {}
    const response = { status(n) { capture.status = n; return this }, redirect(n, location) { capture.status = n; capture.location = location }, json(body) { capture.status ??= 200; capture.body = body; return this } }
    oauthAuthorizeHandler({ query: { response_type: 'code', client_id: client.clientId, redirect_uri: 'https://client.example/callback', state: 'state', code_challenge: 'challenge', code_challenge_method: 'S256' } }, response)
    console.log(JSON.stringify({ clientId: client.clientId, requestId: new URL(capture.location).searchParams.get('request_id') }))
  `
  const phaseTwo = `
    import { siweMessageHandler } from ${JSON.stringify(moduleUrl)}
    const capture = {}
    const response = { status(n) { capture.status = n; return this }, json(body) { capture.status ??= 200; capture.body = body; return this } }
    siweMessageHandler({ headers: { host: 'worker.internal' }, query: { address: '0x1111111111111111111111111111111111111111', client_id: process.env.TEST_CLIENT_ID, request_id: process.env.TEST_REQUEST_ID } }, response)
    console.log(JSON.stringify({ status: capture.status, error: capture.body?.error || null, canonical: /^arcoxdex\\.vercel\\.app wants/.test(capture.body?.message || '') }))
  `
  try {
    const created = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', phaseOne], { env, encoding: 'utf8' }))
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', phaseTwo], {
      env: { ...env, TEST_CLIENT_ID: created.clientId, TEST_REQUEST_ID: created.requestId },
      encoding: 'utf8',
    }))
    assert.deepEqual(result, { status: 200, error: null, canonical: true })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('persisted authorization token is visible to a fresh worker', () => {
  const directory = mkdtempSync(`${tmpdir()}/arcox-token-`)
  const env = {
    ...process.env,
    OAUTH_PATH: `${directory}/clients.json`,
    OAUTH_TOKENS_PATH: `${directory}/tokens.json`,
    OAUTH_STATE_PATH: `${directory}/state.json`,
  }
  const moduleUrl = new URL('../src/services/mcpServer.mjs', import.meta.url).href
  const script = `
    import { validateAccessToken } from ${JSON.stringify(moduleUrl)}
    console.log(JSON.stringify(validateAccessToken(process.env.TEST_TOKEN)))
  `
  try {
    const token = 'arx_at_cross_worker_test'
    const tokenFile = `${directory}/tokens.json`
    execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import { atomicWriteJsonFile } from ${JSON.stringify(new URL('../src/services/jsonFileStore.mjs', import.meta.url).href)}
      atomicWriteJsonFile(${JSON.stringify(tokenFile)}, { tokens: { ${JSON.stringify(token)}: { userId: '0x1111111111111111111111111111111111111111', clientId: 'client', expires: Date.now() + 600000 } } })
    `], { env, encoding: 'utf8' })
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { env: { ...env, TEST_TOKEN: token }, encoding: 'utf8' }))
    assert.deepEqual(result, { userId: '0x1111111111111111111111111111111111111111', clientId: 'client', expires: result.expires })
    assert.ok(result.expires > Date.now())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('OAuth authorization code requires matching PKCE verifier and redirect URI', () => {
  const redirectUri = 'https://client.example/callback'
  const verifier = 'mcp-pkce-verifier-1234567890'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const client = registerOAuthClient({ clientName: 'mcp-oauth-test', redirectUris: [redirectUri] })
  const code = createAuthCode(client.clientId, '0x1111111111111111111111111111111111111111', { redirectUri, codeChallenge: challenge })

  assert.equal(exchangeCodeForToken(code, client.clientId, '', redirectUri, 'wrong').error, 'invalid_grant')
  assert.equal(exchangeCodeForToken(code, client.clientId, '', 'https://attacker.example/callback', verifier).error, 'invalid_grant')

  const token = exchangeCodeForToken(code, client.clientId, '', redirectUri, verifier)
  assert.match(token.access_token, /^arx_at_/)
  assert.equal(token.token_type, 'Bearer')
})
