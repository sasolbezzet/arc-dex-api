import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createAuthCode, exchangeCodeForToken, findExistingAuthCode, isValidRedirectUri, oauthRegisterHandler, oauthTokenHandler, refreshAccessTokenGrant, registerOAuthClient, validateAccessToken } from '../src/services/mcpServer.mjs'

test('refresh token grant issues a new access token and rotates the refresh token', () => {
  const redirectUri = 'https://client.example/callback'
  const challenge = createHash('sha256').update('refresh-verifier-1234567890').digest('base64url')
  const client = registerOAuthClient({ clientName: 'mcp-oauth-refresh-test', redirectUris: [redirectUri] })
  const code = createAuthCode(client.clientId, '0x2222222222222222222222222222222222222222', { redirectUri, codeChallenge: challenge, state: 's' })
  const issued = exchangeCodeForToken(code, client.clientId, client.clientSecret, redirectUri, 'refresh-verifier-1234567890', undefined)
  assert.ok(issued.access_token?.startsWith('arx_at_'))
  assert.ok(issued.refresh_token?.startsWith('arx_rt_'))
  assert.ok(validateAccessToken(issued.access_token))

  // Refresh with the exact client secret → new pair, old refresh single-use.
  const refreshed = refreshAccessTokenGrant(issued.refresh_token, client.clientId, client.clientSecret, undefined)
  assert.ok(refreshed.access_token?.startsWith('arx_at_'), JSON.stringify(refreshed))
  assert.ok(refreshed.refresh_token && refreshed.refresh_token !== issued.refresh_token)
  assert.ok(validateAccessToken(refreshed.access_token))
  assert.equal(refreshAccessTokenGrant(issued.refresh_token, client.clientId, client.clientSecret, undefined).error, 'invalid_grant')
  assert.equal(refreshAccessTokenGrant(refreshed.refresh_token, client.clientId, client.clientSecret, undefined).access_token.startsWith('arx_at_'), true)
})

test('refresh token grant rejects wrong client or unknown token', () => {
  const redirectUri = 'https://client.example/callback'
  const challenge = createHash('sha256').update('refresh-verifier-abcdef1234').digest('base64url')
  const client = registerOAuthClient({ clientName: 'mcp-oauth-refresh-bad-test', redirectUris: [redirectUri] })
  const other = registerOAuthClient({ clientName: 'mcp-oauth-refresh-bad-other', redirectUris: [redirectUri] })
  const code = createAuthCode(client.clientId, '0x2222222222222222222222222222222222222222', { redirectUri, codeChallenge: challenge, state: 's' })
  const issued = exchangeCodeForToken(code, client.clientId, client.clientSecret, redirectUri, 'refresh-verifier-abcdef1234', undefined)
  assert.equal(refreshAccessTokenGrant(issued.refresh_token, other.clientId, other.clientSecret, undefined).error, 'invalid_grant')
  assert.equal(refreshAccessTokenGrant('arx_rt_unknown', client.clientId, client.clientSecret, undefined).error, 'invalid_grant')
})

test('dynamic client registration rejects non-https / non-localhost redirect URIs', () => {
  assert.equal(isValidRedirectUri('https://chatgpt.com/auth/callback/arcox'), true)
  assert.equal(isValidRedirectUri('https://claude.ai/callback'), true)
  assert.equal(isValidRedirectUri('http://127.0.0.1:47562/callback'), true)
  assert.equal(isValidRedirectUri('http://localhost:3000/callback'), true)
  assert.equal(isValidRedirectUri('http://evil.example/callback'), false)
  assert.equal(isValidRedirectUri('javascript:alert(1)'), false)
  assert.equal(isValidRedirectUri('not-a-url'), false)
  assert.throws(() => registerOAuthClient({ clientName: 'bad', redirectUris: ['http://evil.example/cb'] }), /redirect_uris must be https/i)
  const ok = registerOAuthClient({ clientName: 'good', redirectUris: ['http://127.0.0.1:47562/callback'] })
  assert.ok(ok.clientId.startsWith('arcox_'))
})

test('token endpoint accepts refresh_token from the request body', async () => {
  const redirectUri = 'https://client.example/callback'
  const challenge = createHash('sha256').update('handler-verifier-1234567890').digest('base64url')
  const client = registerOAuthClient({ clientName: 'mcp-oauth-handler-test', redirectUris: [redirectUri] })
  const code = createAuthCode(client.clientId, '0x2222222222222222222222222222222222222222', { redirectUri, codeChallenge: challenge, state: 's' })
  const issued = exchangeCodeForToken(code, client.clientId, client.clientSecret, redirectUri, 'handler-verifier-1234567890', undefined)
  let statusCode = 0
  let body = null
  const res = {
    status(n) { statusCode = n; return this },
    json(b) { body = b; return this },
  }
  await oauthTokenHandler({ body: { grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: client.clientId } }, res)
  // Success path calls res.json() directly (Express defaults to 200); a 400
  // here would mean the handler rejected the grant.
  assert.notEqual(statusCode, 400)
  assert.ok(body.access_token?.startsWith('arx_at_'))
  assert.ok(body.refresh_token && body.refresh_token !== issued.refresh_token)
})

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
  assert.equal(token.scope, 'mcp:tools')
})

test('OAuth resource indicator is bound to the authorization code and token', () => {
  const redirectUri = 'https://client.example/callback'
  const verifier = 'mcp-resource-verifier-1234567890'
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const resource = 'https://arcoxdex.vercel.app/mcp'
  const client = registerOAuthClient({ clientName: 'mcp-resource-test', redirectUris: [redirectUri] })
  const code = createAuthCode(client.clientId, '0x4444444444444444444444444444444444444444', { redirectUri, codeChallenge: challenge, resource })

  assert.equal(exchangeCodeForToken(code, client.clientId, '', redirectUri, verifier, 'https://attacker.example/mcp').error, 'invalid_target')
  const token = exchangeCodeForToken(code, client.clientId, '', redirectUri, verifier, resource)
  assert.equal(token.error, undefined)
  assert.equal(token.token_type, 'Bearer')
})


test('Dynamic client registration rejects malformed redirect URI metadata', () => {
  const capture = {}
  const response = {
    status(code) { capture.status = code; return this },
    json(body) { capture.body = body; return this },
  }
  oauthRegisterHandler({ body: { client_name: 'bad-client', redirect_uris: 'https://client.example/callback' } }, response)
  assert.equal(capture.status, 400)
  assert.equal(capture.body.error, 'invalid_client_metadata')
})
