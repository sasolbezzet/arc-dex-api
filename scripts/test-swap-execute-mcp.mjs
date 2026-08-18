import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const EOA_KEY = process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`
const REDIRECT_URI = 'http://127.0.0.1:9876/callback'
const account = privateKeyToAccount(EOA_KEY)
const eoa = account.address
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const msca = state.walletAddress
const vaultToken = state.token

const reg = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'swap-exec-e2e', redirect_uris: [REDIRECT_URI] }) })
const client = await reg.json()
const codeVerifier = randomBytes(32).toString('base64url')
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
const stateParam = 'swap-ex-' + Date.now()
const authRes = await fetch(`${BASE}/api/auth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT_URI, state: stateParam, code_challenge: codeChallenge, code_challenge_method: 'S256', resource: `${BASE}/mcp` })}`, { redirect: 'manual' })
const requestId = new URL(authRes.headers.get('location')).searchParams.get('request_id')
const msgRes = await fetch(`${BASE}/api/auth/siwe-message?${new URLSearchParams({ address: eoa, client_id: client.client_id, request_id: requestId })}`)
const msgData = await msgRes.json()
const signature = await account.signMessage({ message: msgData.message })
const verifyRes = await fetch(`${BASE}/api/auth/siwe-verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: eoa, message: msgData.message, signature, requestId, clientId: client.client_id, redirectUri: REDIRECT_URI, state: stateParam, codeChallenge, resource: `${BASE}/mcp`, mscaWalletAddress: msca, mscaSessionToken: vaultToken }) })
const verifyData = await verifyRes.json()
const tokenRes = await fetch(`${BASE}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code: verifyData.code, client_id: client.client_id, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier, resource: `${BASE}/mcp` }) })
const tokenData = await tokenRes.json()
if (!tokenData.access_token) throw new Error(`token failed: ${tokenRes.status} ${JSON.stringify(tokenData)}`)

let sessionId = ''
let rid = 1
const mcpPost = async (body) => {
  const headers = { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch {
    const dataLine = String(text).split(/\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
    if (dataLine) { try { data = JSON.parse(dataLine) } catch { data = dataLine } } else data = text
  }
  return data
}
const callTool = async (name, args) => {
  const res = await mcpPost({ jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } })
  const content = res?.result?.content || res?.content || []
  return JSON.parse(content.map(c => c.text || '').join('\n'))
}
await mcpPost({ jsonrpc: '2.0', id: rid++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'swap-exec-e2e', version: '1.0.0' } } })
await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })

// Quote USDC→cirBTC (works via AMM)
const q = await callTool('arcox_quote_swap', { tokenIn: 'USDC', tokenOut: 'cirBTC', amountIn: '0.5', source: 'session' })
console.log('QUOTE:', JSON.stringify({ preview: q.preview, previewId: q.previewId, prepared: q.prepared }))
if (!q.preview || !q.previewId) { console.log('quote failed:', JSON.stringify(q).slice(0,500)); process.exit(1) }

// Execute (should work via AMM router, but likely rejected)
const ex = await callTool('arcox_execute_swap', { tokenIn: 'USDC', tokenOut: 'cirBTC', amountIn: '0.5', source: 'session', previewId: q.previewId, confirmed: true, confirmationText: 'ya' })
console.log('EXECUTE:', JSON.stringify(ex))
