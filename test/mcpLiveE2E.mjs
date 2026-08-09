import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createHash } from 'node:crypto'

const base = process.env.BASE_URL || 'http://localhost:3001'
const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const get = async path => {
  const r = await fetch(`${base}${path}`, { redirect: 'manual' })
  return { status: r.status, location: r.headers.get('location') }
}

const account = privateKeyToAccount(generatePrivateKey())
const redirectUri = 'https://example.com/mcp-callback'
const verifier = 'arcox-live-pkce-verifier-1234567890'
const challenge = createHash('sha256').update(verifier).digest('base64url')

const registered = await post('/api/auth/register', { client_name: 'Claude live E2E', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
if (registered.status !== 201) throw new Error(`DCR failed: ${registered.status} ${JSON.stringify(registered.body)}`)
const clientId = registered.body.client_id

const authorized = await get(`/api/auth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'state-live', code_challenge: challenge, code_challenge_method: 'S256' })}`)
if (authorized.status !== 302 || !authorized.location?.startsWith('https://arcoxdex.vercel.app/arc-dex/plugin?')) throw new Error(`Authorize redirect bad: ${authorized.status} ${authorized.location}`)
const authorizeParams = new URL(authorized.location).searchParams
const requestId = authorizeParams.get('request_id')
if (!requestId) throw new Error('Missing authorization request ID')

const msg = await fetch(`${base}/api/auth/siwe-message?${new URLSearchParams({ address: account.address, client_id: clientId, request_id: requestId })}`).then(r => r.json())
if (!msg.message) throw new Error(`SIWE message failed: ${JSON.stringify(msg)}`)
const signature = await account.signMessage({ message: msg.message })
const verified = await post('/api/auth/siwe-verify', { address: account.address, message: msg.message, signature, requestId, clientId, redirectUri, state: 'state-live', codeChallenge: challenge })
if (verified.status !== 200 || !verified.body.redirect) throw new Error(`SIWE verify failed: ${verified.status} ${JSON.stringify(verified.body)}`)
const code = new URL(verified.body.redirect).searchParams.get('code')
if (!code) throw new Error('Missing auth code')

const token = await post('/api/auth/token', { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier })
if (token.status !== 200 || !token.body.access_token?.startsWith('arx_at_')) throw new Error(`Token failed: ${token.status} ${JSON.stringify(token.body)}`)

const parseMcp = async r => {
  const text = await r.text()
  const json = text.startsWith('event:') ? text.match(/^data:\s*(.+)$/m)?.[1] : text
  return JSON.parse(json)
}

const init = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token.body.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-live-e2e', version: '1.0' } } }) })
const initBody = await parseMcp(init)
if (init.status !== 200 || initBody.error || !initBody.result?.serverInfo?.name) throw new Error(`MCP initialize failed: ${init.status} ${JSON.stringify(initBody)}`)
const sid = init.headers.get('mcp-session-id')
if (!sid) throw new Error('MCP missing session ID')

const list = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token.body.access_token}`, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
const listBody = await parseMcp(list)
const names = listBody.result?.tools?.map(x => x.name) || []
if (list.status !== 200 || !names.includes('arcox_wallet_balances') || !names.includes('arcox_execute_send')) throw new Error(`MCP tools/list failed: ${list.status} ${JSON.stringify(listBody)}`)

console.log(JSON.stringify({ ok: true, clientId, address: account.address, redirect: authorized.location, mcpSession: sid.slice(0, 8), tools: names.length, required: ['arcox_wallet_balances', 'arcox_execute_send'] }))
