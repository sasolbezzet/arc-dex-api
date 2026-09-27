#!/usr/bin/env node
// e2e-mcp-tools-mainnet.mjs — uji e2e tool plugin agent (MCP) di produksi mainnet.
//
// Menjalankan persis alur klien agent (Claude/ChatGPT/Hermes):
//   ① dynamic client registration → ② authorize (PKCE) → ③ SIWE challenge →
//   ④ tanda tangan EOA → ⑤ siwe-verify (opsional ikat MSCA) → ⑥ token exchange
//   ⑦ MCP Streamable HTTP: initialize → tools/list → tools/call
//   ⑧ refresh_token grant → token baru tetap bisa memanggil tool
//
// Tool yang dieksekusi:
//   • arcox_mcp_info / arcox_session_status / arcox_wallet_balances (read-only)
//   • arcox_quote_send / arcox_quote_swap / arcox_quote_bridge (preview atau
//     penolakan terstruktur `no_session` — keduanya sah selama ada schemaVersion)
//   • guard: source=eoA harus `msca_only`, fromChain tak dikenal harus
//     `unsupported_chain` (tidak boleh fallback diam-diam ke Arc)
//
// Pemakaian:
//   node --env-file=.env scripts/e2e-mcp-tools-mainnet.mjs
//   MSCA_ADDRESS=0x… MSCA_SESSION_TOKEN=… node --env-file=.env scripts/e2e-mcp-tools-mainnet.mjs   # ikat sesi MSCA
// Eksekusi tx (execute_*) hanya dijalankan kalau sesi MSCA aktif — kalau tidak,
// skrip melaporkannya sebagai terblokir, bukan gagal.
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = String(process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app').replace(/\/+$/, '')
const REDIRECT_URI = process.env.MCP_REDIRECT_URI || 'http://127.0.0.1:9876/callback'
const ARC_CHAIN_KEY = 'arc-mainnet'
const CHAINS = { arc: ARC_CHAIN_KEY, base: 'base-mainnet', arbitrum: 'arbitrum-mainnet' }
const EXPECTED_TOOLS = [
  'arcox_session_status', 'arcox_wallet_balances', 'arcox_quote_send', 'arcox_execute_send',
  'arcox_quote_swap', 'arcox_execute_swap', 'arcox_quote_bridge', 'arcox_execute_bridge',
  'arcox_bridge_status', 'arcox_transaction_history',
]

function resolveKey() {
  if (process.env.MCP_PRIVATE_KEY) return process.env.MCP_PRIVATE_KEY
  if (process.env.EOA_PRIVATE_KEY) return process.env.EOA_PRIVATE_KEY
  if (process.env.TEST_EOA_KEY) return process.env.TEST_EOA_KEY
  try {
    const env = readFileSync(`${process.env.HOME}/.arcox/agent.env`, 'utf8')
    const match = env.match(/^EOA_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)
    if (match) return match[1]
  } catch { /* tanpa state lokal */ }
  throw new Error('Tidak ada private key (MCP_PRIVATE_KEY / EOA_PRIVATE_KEY / TEST_EOA_KEY)')
}

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const note = (label, detail = '') => {
  results.push({ ok: true, skipped: true, label, detail })
  console.log(`   ⏭️  ${label}${detail ? ` — ${detail}` : ''}`)
}
const short = value => `${String(value).slice(0, 12)}…${String(value).slice(-6)}`

const account = privateKeyToAccount(resolveKey())
const eoa = account.address
const mscaAddress = String(process.env.MSCA_ADDRESS || '').trim()
const mscaSessionToken = String(process.env.MSCA_SESSION_TOKEN || '').trim()
console.log('ARCOX — E2E tool plugin agent (MCP) mainnet')
console.log(`eoa   : ${eoa}`)
console.log(`mcp   : ${BASE}/mcp`)
console.log(`msca  : ${mscaAddress || '(tidak diikat — uji permukaan tool + guard)'}`)

// ── ①-⑥ OAuth + SIWE ─────────────────────────────────────────────────────────
console.log('\n①-⑥ OAuth + SIWE (alur klien agent)')
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'e2e-mcp-tools-mainnet', redirect_uris: [REDIRECT_URI] }),
})
const client = await reg.json().catch(() => ({}))
record(reg.status === 201 && Boolean(client.client_id), 'dynamic client registration', `HTTP ${reg.status} client_id ${short(client.client_id || '-')}`)

const codeVerifier = randomBytes(32).toString('base64url')
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
const stateParam = `e2e-mcp-${Date.now()}`
const authRes = await fetch(`${BASE}/api/auth/authorize?${new URLSearchParams({
  response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT_URI,
  state: stateParam, code_challenge: codeChallenge, code_challenge_method: 'S256', resource: `${BASE}/mcp`,
})}`, { redirect: 'manual' })
const location = authRes.headers.get('location') || ''
const requestId = location ? new URL(location).searchParams.get('request_id') : ''
record(authRes.status === 302 && Boolean(requestId), 'authorize → request_id', `HTTP ${authRes.status}`)

const msgRes = await fetch(`${BASE}/api/auth/siwe-message?${new URLSearchParams({ address: eoa, client_id: client.client_id, request_id: requestId })}`)
const msgData = await msgRes.json().catch(() => ({}))
record(Boolean(msgData.message), 'SIWE challenge', `nonce ${String(msgData.nonce || '-').slice(0, 12)}`)

const signature = await account.signMessage({ message: msgData.message })
const verifyBody = {
  address: eoa, message: msgData.message, signature,
  requestId, clientId: client.client_id, redirectUri: REDIRECT_URI,
  state: stateParam, codeChallenge, resource: `${BASE}/mcp`,
}
if (mscaAddress && mscaSessionToken) {
  verifyBody.mscaWalletAddress = mscaAddress
  verifyBody.mscaSessionToken = mscaSessionToken
}
const verifyRes = await fetch(`${BASE}/api/auth/siwe-verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(verifyBody) })
const verifyData = await verifyRes.json().catch(() => ({}))
record(verifyRes.status === 200 && Boolean(verifyData.code), 'siwe-verify → auth code', `HTTP ${verifyRes.status}${mscaAddress ? ' (MSCA diikat)' : ''}`)

const tokenRes = await fetch(`${BASE}/api/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    grant_type: 'authorization_code', code: verifyData.code, client_id: client.client_id,
    redirect_uri: REDIRECT_URI, code_verifier: codeVerifier, resource: `${BASE}/mcp`,
  }),
})
const tokenData = await tokenRes.json().catch(() => ({}))
record(tokenRes.status === 200 && Boolean(tokenData.access_token), 'token exchange (PKCE)', `HTTP ${tokenRes.status} expires_in ${tokenData.expires_in || '-'}s refresh ${tokenData.refresh_token ? 'ada' : 'tidak ada'}`)
if (!tokenData.access_token) {
  console.log('\n❌ tidak bisa lanjut tanpa access_token')
  process.exit(1)
}

// ── ⑦ MCP Streamable HTTP ────────────────────────────────────────────────────
console.log('\n⑦ MCP session')
let sessionId = ''
let requestId7 = 1
const mcpPost = async (body, token = tokenData.access_token) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch {
    const dataLine = String(text).split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    try { data = JSON.parse(dataLine) } catch { data = { raw: text.slice(0, 200) } }
  }
  return { status: res.status, data }
}
const callTool = async (name, args, token) => {
  const out = await mcpPost({ jsonrpc: '2.0', id: requestId7++, method: 'tools/call', params: { name, arguments: args } }, token)
  const content = out.data?.result?.content || out.data?.content || []
  const text = content.map(item => item.text || '').join('\n')
  try { return { status: out.status, payload: JSON.parse(text) } } catch { return { status: out.status, payload: { raw: text.slice(0, 300) } } }
}

const init = await mcpPost({ jsonrpc: '2.0', id: requestId7++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'arcox-e2e-tools', version: '1.0.0' } } })
record(Boolean(init.data?.result?.serverInfo || init.data?.result?.protocolVersion), 'initialize', `HTTP ${init.status} server ${String(init.data?.result?.serverInfo?.name || '-')} protocol ${String(init.data?.result?.protocolVersion || '-')}`)
await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })

const list = await mcpPost({ jsonrpc: '2.0', id: requestId7++, method: 'tools/list', params: {} })
const toolNames = (list.data?.result?.tools || []).map(tool => tool.name)
record(toolNames.length > 20, `tools/list → ${toolNames.length} tool`, toolNames.slice(0, 6).join(', ') + ' …')

// ── tools/call: permukaan tool + guard ───────────────────────────────────────
console.log('\n⑧ tools/call')
const present = EXPECTED_TOOLS.filter(name => toolNames.includes(name))
record(present.length === EXPECTED_TOOLS.length, 'tool utama agent tersedia', `${present.length}/${EXPECTED_TOOLS.length}${present.length < EXPECTED_TOOLS.length ? ` — hilang: ${EXPECTED_TOOLS.filter(n => !toolNames.includes(n)).join(', ')}` : ''}`)

const info = await callTool('arcox_mcp_info', {})
record(Boolean(info.payload?.server && info.payload?.tool_profile), 'arcox_mcp_info', `server=${info.payload?.server} v${info.payload?.version} profile=${info.payload?.tool_profile} dimiliki user=${short(info.payload?.userId || '-')}`)

const statusPayload = (await callTool('arcox_session_status', {})).payload || {}
const sessionActive = statusPayload.active === true
record(typeof statusPayload.active === 'boolean', 'arcox_session_status → status terstruktur', `active=${statusPayload.active} wallet=${short(statusPayload.session?.walletAddress || statusPayload.walletAddress || '-')}`)

const balances = (await callTool('arcox_wallet_balances', {})).payload || {}
if (sessionActive) {
  record(Boolean(balances.chains), 'arcox_wallet_balances → saldo MSCA', `USDC(Arc)=${balances.USDC ?? '-'} chains=${Object.keys(balances.chains || {}).length}`)
} else {
  record(balances.reason === 'no_session', 'arcox_wallet_balances menolak dengan jelas tanpa sesi', `reason=${balances.reason}`)
}

// Guard: source selain session harus ditolak, bukan dieksekusi.
const eoaGuard = (await callTool('arcox_quote_send', { to: eoa, amount: '0.01', token: 'USDC', fromChain: ARC_CHAIN_KEY, source: 'eoa' })).payload || {}
record(eoaGuard.reason === 'msca_only', 'guard quote_send source=eoA → msca_only', JSON.stringify(eoaGuard).slice(0, 130))

const chainGuard = (await callTool('arcox_quote_send', { to: eoa, amount: '0.01', token: 'USDC', fromChain: 'ethereum-mainnet', source: 'session' })).payload || {}
record(chainGuard.reason === 'unsupported_chain', 'guard chain tak didukung → unsupported_chain (tanpa fallback ke Arc)', `supported=${JSON.stringify(chainGuard.supportedChains || []).slice(0, 90)}`)

const swapQuote = (await callTool('arcox_quote_swap', { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.01', source: 'session' })).payload || {}
if (sessionActive) {
  record(swapQuote.preview === true || swapQuote.rejected === true, 'arcox_quote_swap', swapQuote.preview ? `preview amountOut≈${swapQuote.amountOut} adapter=${short(swapQuote.previewId || '')}` : `rejected: ${swapQuote.reason || ''}`)
} else {
  record(swapQuote.reason === 'no_session', 'arcox_quote_swap menunggu sesi MSCA (bukan error)', `reason=${swapQuote.reason}`)
}

const sendQuote = (await callTool('arcox_quote_send', { to: eoa, amount: '0.01', token: 'USDC', fromChain: ARC_CHAIN_KEY, source: 'session' })).payload || {}
if (sessionActive) {
  record(Boolean(sendQuote.previewId), 'arcox_quote_send → preview', `${sendQuote.amount} ${sendQuote.token} dari ${sendQuote.fromChain} → ${short(sendQuote.to || eoa)}`)
} else {
  record(sendQuote.reason === 'no_session', 'arcox_quote_send menunggu sesi MSCA (bukan error)', `reason=${sendQuote.reason}`)
}

const bridgeQuote = (await callTool('arcox_quote_bridge', { fromChain: CHAINS.arc, toChain: CHAINS.base, amount: '0.01', token: 'USDC', source: 'session' })).payload || {}
record(bridgeQuote.preview === true || Boolean(bridgeQuote.reason), 'arcox_quote_bridge → preview/penolakan terstruktur', `reason=${bridgeQuote.reason || 'preview'}${bridgeQuote.preview ? ` fee=${JSON.stringify(bridgeQuote.fees || bridgeQuote.bridgeFee || null).slice(0, 60)}` : ''}`)

const history = (await callTool('arcox_transaction_history', {})).payload || {}
record(Boolean(history) && !history.raw, 'arcox_transaction_history', JSON.stringify(history).slice(0, 120))

// ── refresh_token: token baru harus tetap bisa memakai tool ─────────────────
console.log('\n⑨ refresh_token grant')
const refreshRes = await fetch(`${BASE}/api/auth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokenData.refresh_token, client_id: client.client_id }),
})
const refreshed = await refreshRes.json().catch(() => ({}))
record(refreshRes.status === 200 && Boolean(refreshed.access_token), 'refresh_token → access_token baru (rotasi)', `HTTP ${refreshRes.status}`)
if (refreshed.access_token) {
  const afterRefresh = await callTool('arcox_session_status', {}, refreshed.access_token)
  record(typeof afterRefresh.payload?.active === 'boolean', 'tool tetap bekerja dengan token hasil refresh', `active=${afterRefresh.payload?.active}`)
}

// ── execute: butuh sesi MSCA aktif + dana ──────────────────────────────────
console.log('\n⑩ arcox_execute_send (butuh Agent Wallet berisi dana)')
if (!sessionActive) {
  note('arcox_execute_send dilewati: belum ada sesi MSCA aktif di produksi', 'aktifkan Agent Wallet di Plugin page, lalu jalankan ulang skrip ini dengan MSCA_ADDRESS + MSCA_SESSION_TOKEN')
} else if (Number(balances.USDC ?? 0) <= 0) {
  note('arcox_execute_send dilewati: Agent Wallet belum berdana di Arc mainnet', `USDC=${balances.USDC}`)
} else {
  const execute = (await callTool('arcox_execute_send', {
    to: eoa, amount: '0.005', token: 'USDC', fromChain: ARC_CHAIN_KEY, source: 'session',
    previewId: sendQuote.previewId, confirmed: true, confirmationText: 'ya',
  })).payload || {}
  record(execute.status === 'executed' || execute.executed === true, 'arcox_execute_send → tx nyata', `${execute.status} tx ${short(execute.txHash || '-')}`)
}

const failed = results.filter(item => !item.ok)
const skipped = results.filter(item => item.skipped)
console.log('\nRingkasan')
console.log(`  lulus   : ${results.length - failed.length - skipped.length}/${results.length - skipped.length}`)
if (skipped.length) console.log(`  dilewati: ${skipped.length} (${skipped.map(item => item.label).join('; ')})`)
for (const item of failed) console.log(`    ❌ ${item.label} — ${item.detail}`)
process.exit(failed.length ? 1 : 0)
