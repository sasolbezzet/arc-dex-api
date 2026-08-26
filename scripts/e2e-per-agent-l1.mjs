// e2e-per-agent-l1.mjs — L1 integration E2E: per-agent isolation (Fase 7).
// Runs ONLY against a local staging backend (:3901) with isolated data.
// Guard: refuses to run against production.
//
//   1. DCR ×2 → two client_id
//   2. Device authorize ×2 → two user codes, two UNIQUE device clientIds
//   3. Approve both with different EOA identities + distinct active MSCAs
//   4. Poll token ×2 → two access tokens
//   5. Store: agentBindings["<cid1>|<eoa1>"].wallet != agentBindings["<cid2>|<eoa2>"].wallet
//   6. POST /mcp initialize + tools/list per token → 200 both
//   7. DELETE /agents/<key1> → token1 /mcp → 401; token2 still 200
//
// Usage: node scripts/e2e-per-agent-l1.mjs
import { readFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE || 'http://localhost:3901'
if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error(`REFUSED: L1 E2E must run against staging, got ${BASE}`)
  process.exit(2)
}

const W1 = '0x3333333333333333333333333333333333333333'
const W2 = '0x4444444444444444444444444444444444444444'
const VS1 = 'arx_vs_test_agent1' // vault session token authenticating W1
const VS2 = 'arx_vs_test_agent2' // vault session token authenticating W2
const STORE = 'data-staging/session-keys.json'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` :: ${extra}` : ''}`)
  if (!cond) failures++
}
const post = async (path, body, token = '') => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

// ── 1. DCR ×2 ──
console.log('\n① DCR ×2…')
const c1 = await post('/api/auth/register', { client_name: 'agent-l1-hermes', redirect_uris: ['http://127.0.0.1:9991/callback'] })
const c2 = await post('/api/auth/register', { client_name: 'agent-l1-claude', redirect_uris: ['http://127.0.0.1:9992/callback'] })
check('DCR client1 issued', c1.status === 201 && Boolean(c1.data.client_id))
check('DCR client2 issued', c2.status === 201 && Boolean(c2.data.client_id))
check('DCR distinct clients', c1.data.client_id !== c2.data.client_id)

// ── 2. Device authorize ×2 ──
console.log('② device authorize ×2')
const d1 = await post('/api/auth/device/authorize', { client_name: 'agent-l1-hermes' })
const d2 = await post('/api/auth/device/authorize', { client_name: 'agent-l1-claude' })
check('device1 user_code', /^ARCX-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(d1.data.user_code || ''), d1.data.user_code)
check('device2 user_code', /^ARCX-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(d2.data.user_code || ''), d2.data.user_code)

// ── 3. Approve ×2 with different EOAs + different bound MSCAs ──
console.log('③ approve ×2')
const acc1 = privateKeyToAccount(generatePrivateKey())
const acc2 = privateKeyToAccount(generatePrivateKey())
const approve = async (account, userCode, mscaWalletAddress, mscaSessionToken) => {
  const msg = await post('/api/auth/device/message', { address: account.address, user_code: userCode })
  if (msg.status !== 200) return { ok: false, extra: `message ${msg.status}` }
  const signature = await account.signMessage({ message: msg.data.message })
  const res = await post('/api/auth/device/approve', {
    address: account.address, message: msg.data.message, signature,
    user_code: userCode, mscaWalletAddress, mscaSessionToken, approve: true,
  })
  return { ok: res.status === 200 && res.data.ok === true, extra: `${res.status} ${JSON.stringify(res.data).slice(0, 80)}` }
}
const ap1 = await approve(acc1, d1.data.user_code, W1, VS1)
const ap2 = await approve(acc2, d2.data.user_code, W2, VS2)
check('approve agent1', ap1.ok, ap1.extra)
check('approve agent2', ap2.ok, ap2.extra)

// ── 4. Poll token ×2 ──
console.log('④ poll tokens')
const t1 = await post('/api/auth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d1.data.device_code })
const t2 = await post('/api/auth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: d2.data.device_code })
check('token1 issued', t1.status === 200 && Boolean(t1.data.access_token))
check('token2 issued', t2.status === 200 && Boolean(t2.data.access_token))

// ── 5. Store isolation ──
console.log('⑤ store isolation')
const after = JSON.parse(readFileSync(STORE, 'utf8'))
const bindings = Object.entries(after.agentBindings || {})
const b1 = bindings.find(([k]) => k.endsWith('|' + acc1.address.toLowerCase()))
const b2 = bindings.find(([k]) => k.endsWith('|' + acc2.address.toLowerCase()))
check('binding1 exists', Boolean(b1), b1?.[0])
check('binding2 exists', Boolean(b2), b2?.[0])
check('distinct agentKeys', b1 && b2 && b1[0] !== b2[0], `${b1?.[0]} vs ${b2?.[0]}`)
check('wallets differ', b1 && b2 && b1[1].walletAddress !== b2[1].walletAddress, `${b1?.[1]?.walletAddress} vs ${b2?.[1]?.walletAddress}`)

// ── 6. MCP initialize + tools/list per token → 200 ──
console.log('⑥ MCP per token')
const mcpProbe = async (token) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const r1 = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'l1', version: '1' } } }) })
  const sid = r1.headers.get('mcp-session-id') || ''
  const r2 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
  return { init: r1.status, tools: r2.status }
}
const m1 = await mcpProbe(t1.data.access_token)
const m2 = await mcpProbe(t2.data.access_token)
check('mcp1 init+tools 200', m1.init === 200 && m1.tools === 200, JSON.stringify(m1))
check('mcp2 init+tools 200', m2.init === 200 && m2.tools === 200, JSON.stringify(m2))

// ── 7. DELETE agent1 (vault session VS1 owns W1) → token1 401, token2 200 ──
console.log('⑦ revoke agent1')
const del = await fetch(`${BASE}/api/vault/agents/${encodeURIComponent(b1[0])}`, { method: 'DELETE', headers: { Authorization: `Bearer ${VS1}` } })
check('DELETE agent1 ok', del.status === 200, `status ${del.status}`)
const afterDel = JSON.parse(readFileSync(STORE, 'utf8'))
check('binding1 removed', !afterDel.agentBindings?.[b1[0]])
const m1b = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t1.data.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'l1', version: '1' } } }) })
check('token1 dead → 401', m1b.status === 401, `status ${m1b.status}`)
const m2b = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${t2.data.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'l1', version: '1' } } }) })
check('token2 still 200', m2b.status === 200, `status ${m2b.status}`)

console.log(failures === 0 ? '\nL1 ALL PASS' : `\nL1 ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)