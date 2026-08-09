import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
