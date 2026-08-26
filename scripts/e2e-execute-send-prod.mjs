// e2e-execute-send-prod.mjs — FULL production E2E of the Hermes agent path:
// loopback OAuth (PKCE) + MSCA identity binding → MCP session → quote →
// EXECUTE a real 0.01 USDC send on Arc Testnet via the Agent Wallet session key.
//
// This is what Hermes does after pairing, minus Chrome: every step hits the
// deployed endpoints on https://arcoxdex.vercel.app exactly as an MCP client
// would. Requires /tmp/arcox-e2e-prod-state.json (EOA key + vault token).
//
// Usage: node --env-file=.env TEST_EOA_KEY=0x… scripts/e2e-execute-send-prod.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { base64UrlToBytes } from 'webauthn-p256'
import { makePasskeyGetFn } from './e2e-webauthn.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const REDIRECT_URI = 'http://127.0.0.1:9877/callback'
const RECIPIENT = process.env.E2E_RECIPIENT || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'
const AMOUNT = process.env.E2E_AMOUNT || '0.01'

const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
if (!state.walletAddress || !state.credentialId || !state.pkcs8) throw new Error('state file must have walletAddress + credentialId + pkcs8')
const account = privateKeyToAccount(process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`)
const eoa = account.address

// ── ⓪ Fresh vault session token via headless passkey login ──
// The stored arx_vs_… token expires; every run mints a new one exactly like
// "Login Passkey" does in the browser, then persists it back to the state file.
async function freshVaultToken() {
  const optsRes = await fetch(`${BASE}/api/auth/passkey-options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'Login' }),
  })
  const optsJson = await optsRes.json()
  const options = optsJson.options || {}
  const flowId = optsJson.flowId
  const challenge = String(options.challenge || '')
  const rpId = state.rpId || options.rp?.id || options.rpId || 'arcoxdex.vercel.app'
  const privateKey = await webcrypto.subtle.importKey('pkcs8', Buffer.from(state.pkcs8, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const getFn = makePasskeyGetFn({ privateKey, credentialId: state.credentialId, rpId, userHandle: state.userHandle || '' })
  const assertion = await getFn({ publicKey: { challenge: base64UrlToBytes(challenge), rpId } })
  const toB64 = bytes => Buffer.from(bytes).toString('base64url')
  const credential = {
    id: state.credentialId,
    rawId: state.credentialId,
    type: 'public-key',
    response: {
      ...(state.userHandle ? { userHandle: state.userHandle } : {}),
      clientDataJSON: toB64(assertion.response.clientDataJSON),
      authenticatorData: toB64(assertion.response.authenticatorData),
      signature: toB64(assertion.response.signature),
    },
  }
  const verifyRes = await fetch(`${BASE}/api/auth/passkey-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, mode: 'Login', flowId }),
  })
  const verified = await verifyRes.json()
  if (!verified.token) throw new Error(`passkey login failed: ${verifyRes.status} ${JSON.stringify(verified).slice(0, 300)}`)
  return verified.token
}

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)

// ── 1. Frontend auth token for the EOA + fresh MSCA vault token ──
step('①', 'mint frontend auth token for EOA + fresh vault token…')
const issuedAt = new Date().toISOString()
const loginMessage = [
  'ARCOX DEX login',
  'Only sign this message on the official ARCOX DEX website.',
  `Address: ${eoa}`,
  `Issued At: ${issuedAt}`,
  'Network: Arc Testnet',
].join('\n')
const loginSignature = await account.signMessage({ message: loginMessage })
const session = await (await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: eoa, issuedAt, signature: loginSignature }),
})).json()
if (!session.token) throw new Error(`auth/session failed: ${JSON.stringify(session)}`)
ok(`auth token for ${eoa.slice(0, 10)}…`)
const mscaSessionToken = await freshVaultToken()
state.token = mscaSessionToken
try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)) } catch {}
ok(`fresh vault token ${mscaSessionToken.slice(0, 12)}… for ${state.walletAddress.slice(0, 10)}…`)

// ── 2. OAuth client + authorize (loopback redirect, PKCE S256) ──
step('②', 'register OAuth client + authorize…')
const reg = await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Hermes Agent (execute e2e)', redirect_uris: [REDIRECT_URI] }),
})).json()
const codeVerifier = randomBytes(32).toString('base64url')
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
const stateParam = 'exec-e2e-' + Date.now()
const authRes = await fetch(`${BASE}/api/auth/authorize?${new URLSearchParams({
  response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT_URI,
  state: stateParam, code_challenge: codeChallenge, code_challenge_method: 'S256', resource: `${BASE}/mcp`,
})}`, { redirect: 'manual' })
const pluginUrl = authRes.headers.get('location')
const requestId = new URL(pluginUrl).searchParams.get('request_id')
if (!requestId) throw new Error(`authorize failed: ${authRes.status}`)
ok(`request_id ${requestId.slice(0, 8)}…`)

// ── 3. SIWE challenge bound to the authorization request ──
step('③', 'SIWE challenge…')
const msgData = await (await fetch(`${BASE}/api/auth/siwe-message?address=${encodeURIComponent(eoa)}&client_id=${encodeURIComponent(reg.client_id)}&request_id=${encodeURIComponent(requestId)}`)).json()
if (!msgData.message) throw new Error(`siwe-message failed: ${JSON.stringify(msgData)}`)
ok('challenge issued')

// ── 4. Sign + verify WITH MSCA binding (passkey vault token proves Agent Wallet) ──
step('④', 'SIWE verify + bind Agent Wallet…')
const signature = await account.signMessage({ message: msgData.message })
const verify = await (await fetch(`${BASE}/api/auth/siwe-verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    address: eoa, message: msgData.message, signature,
    clientId: reg.client_id, redirectUri: REDIRECT_URI, state: stateParam,
    codeChallenge, requestId, resource: `${BASE}/mcp`,
    mscaWalletAddress: state.walletAddress, mscaSessionToken,
  }),
})).json()
if (!verify.code) throw new Error(`siwe-verify failed: ${JSON.stringify(verify)}`)
ok(`code ${verify.code.slice(0, 8)}… bound to MSCA ${state.walletAddress.slice(0, 10)}…`)

// ── 5. Token exchange ──
step('⑤', 'PKCE token exchange…')
const tok = await (await fetch(`${BASE}/api/auth/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'authorization_code', code: verify.code, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier, resource: `${BASE}/mcp` }),
})).json()
if (!tok.access_token) throw new Error(`token failed: ${JSON.stringify(tok)}`)
ok(`access_token ${tok.access_token.slice(0, 16)}…`)

// ── 6. MCP session: initialize → status → quote → EXECUTE ──
step('⑥', 'MCP session + tools…')
let sessionId = ''
let reqId = 1
const mcpPost = async (body) => {
  const headers = { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch {
    const dataLine = String(text).split(/\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
    try { data = JSON.parse(dataLine) } catch { data = text }
  }
  return data
}
const callTool = async (name, args) => {
  const res = await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'tools/call', params: { name, arguments: args } })
  const content = res?.result?.content || []
  return JSON.parse(content.map(c => c.text || '').join('\n'))
}
await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes-execute-e2e', version: '1.0.0' } } })
await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })

const status = await callTool('arcox_session_status', {})
if (status.active !== true) throw new Error(`session_status: ${JSON.stringify(status)}`)
ok(`arcox_session_status → active, wallet ${String(status.walletAddress).slice(0, 10)}…`)

step('⑦', 'arcox_quote_send preview…')
const quote = await callTool('arcox_quote_send', { to: RECIPIENT, token: 'USDC', amount: AMOUNT, fromChain: 'arc-testnet', source: 'session' })
if (!quote.preview || !quote.previewId) throw new Error(`quote: ${JSON.stringify(quote).slice(0, 300)}`)
ok(`previewId ${String(quote.previewId).slice(0, 12)}… → ${quote.amount} USDC → ${quote.to.slice(0, 10)}…`)

step('⑧', 'arcox_execute_send (REAL tx)…')
const exec = await callTool('arcox_execute_send', {
  to: RECIPIENT, amount: AMOUNT, token: 'USDC', fromChain: 'arc-testnet',
  source: 'session', previewId: quote.previewId, confirmed: true, confirmationText: 'ya',
})
console.log('   result:', JSON.stringify(exec).slice(0, 400))
if (!(exec.executed === true && exec.txHash)) throw new Error(`execute failed: ${JSON.stringify(exec).slice(0, 300)}`)

console.log('\n=== SUMMARY ===')
console.log('Hermes-style MCP execution E2E: ✅ PASSED — real USDC send executed on Arc Testnet')
console.log('MSCA  :', status.walletAddress)
console.log('txHash:', exec.txHash)
process.exit(0)
