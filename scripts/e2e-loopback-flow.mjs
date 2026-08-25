// E2E: same-device loopback OAuth flow (Method B) — simulates what Hermes does
// when oauth.device_flow=local: register a client with a loopback redirect,
// start a local callback listener, complete SIWE, and receive the auth code
// through the callback before exchanging it for a token.
// Usage: BASE=http://localhost:3901 node scripts/e2e-loopback-flow.mjs
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createHash, randomUUID } from 'crypto'
import http from 'http'

const BASE = process.env.BASE || 'http://localhost:3901'
const CALLBACK_PORT = Number(process.env.CALLBACK_PORT || 39765)
let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` :: ${extra}` : ''}`)
  if (!cond) failures++
}

const account = privateKeyToAccount(generatePrivateKey())
const state = randomUUID()
const codeVerifier = randomUUID() + randomUUID()
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}/callback`

// 1. Dynamic client registration (like Hermes does before the flow)
let clientId
{
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Hermes e2e loopback', redirect_uris: [redirectUri] }),
  })
  check('register 201', r.status === 201)
  const d = await r.json()
  clientId = d.client_id
  check('client_id issued', Boolean(clientId))
}

// 2. Start a local callback listener (what Hermes' callback waiter does)
const received = new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, redirectUri)
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><body>Login successful. You can close this tab.</body></html>')
    server.close()
    resolve({ code, gotState })
  })
  server.on('error', reject)
  server.listen(CALLBACK_PORT, '127.0.0.1')
})

// 3. Authorize request (what the MCP SDK builds)
let requestId
{
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  const r = await fetch(`${BASE}/api/auth/authorize?${params}`, { redirect: 'manual' })
  const loc = String(r.headers.get('location') || '')
  check('authorize redirects to plugin consent', r.status === 302 && loc.includes('/plugin'), loc.slice(0, 80))
  requestId = new URL(loc).searchParams.get('request_id')
  check('request_id propagated', Boolean(requestId))
}

// 4. SIWE message (what PluginPanel does after passkey)
let msgData
{
  const r = await fetch(`${BASE}/api/auth/siwe-message?address=${encodeURIComponent(account.address)}&client_id=${encodeURIComponent(clientId)}&request_id=${encodeURIComponent(requestId)}`)
  check('siwe-message 200', r.status === 200)
  msgData = await r.json()
  check('message has nonce', Boolean(msgData.message))
}

// 5. SIWE verify -> get auth code (what PluginPanel does after wallet sign)
let code
{
  const signature = await account.signMessage({ message: msgData.message })
  const r = await fetch(`${BASE}/api/auth/siwe-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: account.address, message: msgData.message, signature,
      requestId, clientId, redirectUri, state, codeChallenge,
    }),
  })
  const d = await r.json()
  check('siwe-verify returns code', r.status === 200 && Boolean(d.code), JSON.stringify(d).slice(0, 80))
  code = d.code
}

// 6. Deliver the redirect to the local callback (what the browser does)
{
  const cb = await fetch(`${redirectUri}?code=${code}&state=${state}`)
  check('callback page 200', cb.status === 200)
}
const cbResult = await received
check('callback received code', cbResult.code === code)
check('callback state matches', cbResult.gotState === state)

// 7. Exchange code for token (what the MCP SDK does)
let tokens
{
  const r = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier }),
  })
  const d = await r.json()
  check('token issued', r.status === 200 && Boolean(d.access_token), JSON.stringify(d).slice(0, 80))
  tokens = d
}

// 8. Access token works against /mcp
{
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-loopback', version: '1.0' } } }),
  })
  check('MCP initialize authorized', r.status === 200)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
