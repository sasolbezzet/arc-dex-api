// e2e-mcp-connect-prod.mjs — FULL MCP connection E2E on the deployed site.
//
// Drives the exact flow a real Claude/ChatGPT connection performs on
// https://arcoxdex.vercel.app until the Agent Wallet is ready to transact:
//
//   0. read the fresh passkey session state created by
//      scripts/test-session-production-e2e.mjs (vault token + active MSCA)
//   1. top up the new MSCA on Arc from the treasury Unified Balance (1 USDC)
//   2. POST /api/auth/register            → OAuth client (localhost redirect)
//   3. GET  /api/auth/authorize           → request_id
//   4. GET  /api/auth/siwe-message        → SIWE challenge
//   5. sign the SIWE message with the test EOA (personal_sign)
//   6. POST /api/auth/siwe-verify         → auth code + EOA→MSCA binding
//   7. POST /api/auth/token (PKCE)        → access_token + refresh_token
//   8. POST /mcp (Streamable HTTP)        → initialize, tools/list
//   9. tools/call arcox_session_status    → active MSCA session
//  10. tools/call arcox_quote_send        → preview (READY TO TRANSACT)
//  11. tools/call arcox_execute_send      → real 0.01 USDC transfer
//  12. refresh_token grant                → new access token still works
//
// Usage: node --env-file=.env scripts/e2e-mcp-connect-prod.mjs
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const EOA_KEY = process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`
const REDIRECT_URI = 'http://127.0.0.1:9876/callback'
const RECIPIENT = process.env.E2E_RECIPIENT || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

const account = privateKeyToAccount(EOA_KEY)
const eoa = account.address
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const msca = state.walletAddress
const vaultToken = state.token
if (!msca || !vaultToken) throw new Error('PROD_STATE_PATH must contain walletAddress + token from test-session-production-e2e.mjs')

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)

// ── 1. Fund the new MSCA on Arc if it is dry (treasury unified balance → wallet) ──
step('①', 'check + top up MSCA on Arc if needed…')
const { createPublicClient, http, defineChain, formatUnits } = await import('viem')
const { resolveArcRpc } = await import('../src/config/arcRpc.mjs')
const arcRpc = resolveArcRpc({ preferCanteen: true })
const arcClient = createPublicClient({ chain: defineChain({ id: 5042002, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [arcRpc] } } }), transport: http(arcRpc, { timeout: 15000 }) })
let mscaBalance = await arcClient.getBalance({ address: msca }).catch(() => 0n)
if (mscaBalance < 10n ** 17n) { // < 0.1 USDC
  const { spendDelegatedUnifiedBalance } = await import('../src/services/aiRouterSpendService.mjs')
  try {
    const fund = await spendDelegatedUnifiedBalance({ sourceAccount: process.env.X402_RECIPIENT_ADDRESS || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e', amount: '1', destinationChain: 'Arc_Testnet', recipient: msca })
    ok(`treasury → MSCA ${fund.txHash.slice(0, 18)}… (fee ${fund.totalFee})`)
  } catch (error) {
    console.log('   ⚠️  top-up skipped (treasury dry):', error?.message?.slice(0, 80))
  }
  mscaBalance = await arcClient.getBalance({ address: msca }).catch(() => 0n)
}
ok(`MSCA Arc balance ${formatUnits(mscaBalance, 18)} USDC`)

// ── 2. Register OAuth client ──
step('②', 'dynamic client registration…')
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'e2e-mcp-connect-prod', redirect_uris: [REDIRECT_URI] }),
})
const client = await reg.json()
if (reg.status !== 201 || !client.client_id) throw new Error(`register failed: ${reg.status} ${JSON.stringify(client)}`)
ok(`client_id ${client.client_id}`)

// ── 3. Authorize ──
step('③', 'authorization request…')
const codeVerifier = randomBytes(32).toString('base64url')
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
const stateParam = 'e2e-state-' + Date.now()
const authRes = await fetch(`${BASE}/api/auth/authorize?${new URLSearchParams({
  response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT_URI,
  state: stateParam, code_challenge: codeChallenge, code_challenge_method: 'S256',
  resource: `${BASE}/mcp`,
})}`, { redirect: 'manual' })
const location = authRes.headers.get('location')
if (authRes.status !== 302 || !location) throw new Error(`authorize failed: ${authRes.status}`)
const requestId = new URL(location).searchParams.get('request_id')
ok(`redirect → ${new URL(location).pathname}?request_id=${requestId.slice(0, 8)}…`)

// ── 4. SIWE message ──
step('④', 'SIWE challenge…')
const msgRes = await fetch(`${BASE}/api/auth/siwe-message?${new URLSearchParams({ address: eoa, client_id: client.client_id, request_id: requestId })}`)
const msgData = await msgRes.json()
if (!msgData.message) throw new Error(`siwe-message failed: ${msgRes.status} ${JSON.stringify(msgData)}`)
ok(`challenge for ${eoa.slice(0, 10)}… (nonce ${msgData.nonce})`)

// ── 5. Sign SIWE with the EOA (personal_sign semantics) ──
step('⑤', 'sign SIWE with test EOA…')
const signature = await account.signMessage({ message: msgData.message })
ok(`signature ${signature.slice(0, 18)}…`)

// ── 6. Verify → auth code (+ passkey binding) ──
step('⑥', 'SIWE verify with passkey MSCA binding…')
const verifyRes = await fetch(`${BASE}/api/auth/siwe-verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    address: eoa, message: msgData.message, signature,
    requestId, clientId: client.client_id, redirectUri: REDIRECT_URI,
    state: stateParam, codeChallenge,
    resource: `${BASE}/mcp`,
    mscaWalletAddress: msca, mscaSessionToken: vaultToken,
  }),
})
const verifyData = await verifyRes.json()
if (verifyRes.status !== 200 || !verifyData.code) throw new Error(`siwe-verify failed: ${verifyRes.status} ${JSON.stringify(verifyData)}`)
ok(`auth code issued + EOA→MSCA bound (${verifyData.code.slice(0, 8)}…)`)

// ── 7. Token exchange (PKCE) ──
step('⑦', 'token exchange…')
const tokenRes = await fetch(`${BASE}/api/auth/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'authorization_code', code: verifyData.code, client_id: client.client_id,
    redirect_uri: REDIRECT_URI, code_verifier: codeVerifier, resource: `${BASE}/mcp`,
  }),
})
const tokenData = await tokenRes.json()
if (tokenRes.status !== 200 || !tokenData.access_token) throw new Error(`token failed: ${tokenRes.status} ${JSON.stringify(tokenData)}`)
ok(`access_token ${tokenData.access_token.slice(0, 16)}… + refresh_token ${String(tokenData.refresh_token || '').slice(0, 16)}… (expires_in ${tokenData.expires_in}s)`)

// ── 8-11. MCP Streamable HTTP session ──
step('⑧', 'MCP initialize + tools/list + status + quote + execute…')
let sessionId = ''
let mcpRequestId = 1
const mcpPost = async (body) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  // Streamable HTTP may answer with SSE (event: message / data: {…}) — extract
  // the JSON payload from data: lines before parsing.
  let data
  try { data = JSON.parse(text) } catch {
    const dataLine = String(text).split(/\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
    if (dataLine) { try { data = JSON.parse(dataLine) } catch { data = dataLine } } else data = text
  }
  // 202 Accepted is the standard Streamable HTTP response for notifications.
  if (res.status !== 200 && res.status !== 202 && !String(text).includes('result')) throw new Error(`mcp ${body.method} failed: ${res.status} ${String(text).slice(0, 300)}`)
  return data
}
const callTool = async (name, args) => {
  const res = await mcpPost({ jsonrpc: '2.0', id: mcpRequestId++, method: 'tools/call', params: { name, arguments: args } })
  const content = res?.result?.content || res?.content || []
  const text = content.map(c => c.text || '').join('\n')
  return JSON.parse(text)
}

const init = await mcpPost({ jsonrpc: '2.0', id: mcpRequestId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'arcox-e2e', version: '1.0.0' } } })
ok(`initialized (protocol ${init?.result?.protocolVersion || '?'})`)
await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })
const tools = await mcpPost({ jsonrpc: '2.0', id: mcpRequestId++, method: 'tools/list', params: {} })
const names = (tools?.result?.tools || []).map(t => t.name)
ok(`tools/list → ${names.length} tools`)

const sessionStatus = await callTool('arcox_session_status', {})
if (sessionStatus.active !== true) throw new Error(`session_status: ${JSON.stringify(sessionStatus)}`)
const activeWallet = sessionStatus.session?.walletAddress || sessionStatus.walletAddress
ok(`arcox_session_status → active, wallet ${String(activeWallet).slice(0, 10)}…`)

const balances = await callTool('arcox_wallet_balances', {})
const arcUsdc = balances.chains?.['arc-testnet']?.USDC ?? balances.USDC
ok(`arcox_wallet_balances → Arc USDC ${arcUsdc}`)

step('⑨', 'QUOTE (siap tx)…')
const quote = await callTool('arcox_quote_send', { to: RECIPIENT, token: 'USDC', amount: '0.01', fromChain: 'arc-testnet', source: 'session' })
if (!quote.preview && quote.rejected !== false) throw new Error(`quote rejected: ${JSON.stringify(quote)}`)
console.log('   quote:', JSON.stringify(quote).slice(0, 600))
ok(`arcox_quote_send preview → ${quote.amountIn || quote.amount} USDC → ${String(quote.recipient || quote.to || '').slice(0, 10)}… (previewId ${String(quote.previewId).slice(0, 8)}…)`)

step('⑩', 'EXECUTE real tx…')
const executed = await callTool('arcox_execute_send', {
  to: RECIPIENT, token: 'USDC', amount: '0.01', fromChain: 'arc-testnet', source: 'session',
  previewId: quote.previewId, confirmed: true, confirmationText: 'ya',
})
if (executed.status !== 'executed' && executed.executed !== true) throw new Error(`execute failed: ${JSON.stringify(executed)}`)
ok(`arcox_execute_send → ${executed.status} tx ${executed.txHash.slice(0, 18)}…`)

step('⑪', 'refresh_token grant…')
const refreshRes = await fetch(`${BASE}/api/auth/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokenData.refresh_token, client_id: client.client_id }),
})
const refreshed = await refreshRes.json()
if (refreshRes.status !== 200 || !refreshed.access_token) throw new Error(`refresh failed: ${refreshRes.status} ${JSON.stringify(refreshed)}`)
ok(`refresh_token → new access_token ${refreshed.access_token.slice(0, 16)}… (rotated)`)

console.log('\n=== SUMMARY ===')
console.log('MCP connection E2E: ✅ PASSED — OAuth → passkey binding → token → MCP session → status → quote → REAL TX')
console.log('EOA      :', eoa)
console.log('MSCA     :', msca)
console.log('client   :', client.client_id)
console.log('send tx  :', executed.txHash, '| explorer:', executed.explorerUrl)
