import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createAuthCode, exchangeCodeForToken, registerOAuthClient } from '../src/services/mcpServer.mjs'

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
