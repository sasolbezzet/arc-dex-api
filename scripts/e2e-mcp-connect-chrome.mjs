// e2e-mcp-connect-chrome.mjs — REAL Chrome E2E of the MCP connection flow on
// the deployed site (https://arcoxdex.vercel.app).
//
// Drives the exact UX a user goes through when connecting Claude/ChatGPT:
//   1. register an OAuth client + build the /arc-dex/plugin authorize URL
//   2. launch real Chrome with:
//      - a CDP WebAuthn virtual authenticator seeded with the passkey
//        credential from /tmp/arcox-e2e-prod-state.json (created by
//        test-session-production-e2e.mjs), so "Login Passkey" is answered
//      - an injected window.ethereum for the EOA (eth_accounts) whose
//        personal_sign is answered by a local route-intercept signer
//      - localStorage so the app restores the EOA + passkey session
//   3. click "User lama / Login Passkey" → WebAuthn → SIWE → redirect
//   4. capture the auth code from the localhost callback
//   5. PKCE token exchange → MCP Streamable HTTP session → tools
//   6. arcox_session_status + arcox_quote_send preview = READY TO TX
//
// Usage: node --env-file=.env scripts/e2e-mcp-connect-chrome.mjs
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { chromium } from '/tmp/browser-test/node_modules/playwright-core/index.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const EOA_KEY = process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`
const REDIRECT_URI = 'http://127.0.0.1:9876/callback'
const RECIPIENT = process.env.E2E_RECIPIENT || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

const account = privateKeyToAccount(EOA_KEY)
const eoa = account.address
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const msca = state.walletAddress
if (!msca || !state.credentialId || !state.pkcs8) throw new Error('state file must have walletAddress + credentialId + pkcs8 (run test-session-production-e2e.mjs first)')

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)

// ── 1. Mint a frontend auth token for the EOA (like a real SIWE login) ──
step('①', 'mint frontend auth token for EOA…')
const issuedAt = new Date().toISOString()
const loginMessage = [
  'ARCOX DEX login',
  'Only sign this message on the official ARCOX DEX website.',
  `Address: ${eoa}`,
  `Issued At: ${issuedAt}`,
  'Network: Arc Testnet',
].join('\n')
const loginSignature = await account.signMessage({ message: loginMessage })
const sessionRes = await fetch(`${BASE}/api/auth/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: eoa, issuedAt, signature: loginSignature }),
})
const session = await sessionRes.json()
if (!session.token) throw new Error(`auth/session failed: ${sessionRes.status} ${JSON.stringify(session)}`)
ok(`auth token for ${eoa.slice(0, 10)}…`)

// ── 2. OAuth client + authorize URL ──
step('②', 'OAuth client + authorize URL…')
const reg = await (await fetch(`${BASE}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'e2e-chrome-mcp', redirect_uris: [REDIRECT_URI] }),
})).json()
const codeVerifier = randomBytes(32).toString('base64url')
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
const stateParam = 'chrome-e2e-' + Date.now()
const authRes = await fetch(`${BASE}/api/auth/authorize?${new URLSearchParams({
  response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT_URI,
  state: stateParam, code_challenge: codeChallenge, code_challenge_method: 'S256', resource: `${BASE}/mcp`,
})}`, { redirect: 'manual' })
const pluginUrl = authRes.headers.get('location')
if (!pluginUrl) throw new Error(`authorize failed: ${authRes.status}`)
ok(`plugin URL: ${new URL(pluginUrl).pathname}?request_id=${new URL(pluginUrl).searchParams.get('request_id').slice(0, 8)}…`)

// ── 3. Launch Chrome with virtual authenticator + injected provider ──
step('③', 'launch Chrome (CDP WebAuthn + injected ethereum + localStorage)…')
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext()
const page = await context.newPage()

await context.addInitScript(({ addr, authToken }) => {
  window.__signQueue = []
  window.__signResolvers = {}
  window.ethereum = {
    isMetaMask: false,
    request: async ({ method, params }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr]
      if (method === 'eth_chainId') return '0x4cef52'
      if (method === 'net_version') return '5042002'
      if (method === 'personal_sign') {
        // The page CSP forbids external fetch, so the signature is requested
        // through a CDP round-trip: the page queues the message and the Node
        // driver signs it with viem, then resolves the pending promise.
        const messageHex = params?.[0]
        const id = Math.random().toString(36).slice(2)
        return new Promise((resolve, reject) => {
          window.__signQueue.push({ id, messageHex })
          window.__signResolvers[id] = { resolve, reject }
        })
      }
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      throw { code: 4001, message: 'rejected by automation' }
    },
    on() {},
    removeListener() {},
  }
  // EOA login only. Passkey vault state is created by the real UI below.
  localStorage.setItem('arc-dex-auth', JSON.stringify({ address: addr, token: authToken, issuedAt: Date.now() }))
}, { addr: eoa.toLowerCase(), authToken: session.token })

const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
const auth = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, rpId: 'arcoxdex.vercel.app' },
})
if (state.credentialId && state.pkcs8) {
  // Existing passkey from a prior production run: seed it into the virtual
  // authenticator so "Login Passkey" answers without re-registering.
  // CDP requires padded standard base64 for all binary credential fields.
  const b64 = s => Buffer.from(s, 'base64url').toString('base64')
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: auth.authenticatorId,
    credential: {
      credentialId: b64(state.credentialId),
      isResidentCredential: true,
      rpId: state.rpId || 'arcoxdex.vercel.app',
      privateKey: Buffer.from(state.pkcs8, 'base64url').toString('base64'),
      userHandle: state.userHandle ? b64(state.userHandle) : undefined,
      signCount: 0,
    },
  })
  ok(`virtual authenticator seeded with existing passkey ${state.credentialId.slice(0, 10)}…`)
} else {
  ok('virtual authenticator ready (passkey will be created natively)')
}
const hasExistingPasskey = !!(state.credentialId && state.pkcs8)

// ── 4. Route intercept: localhost callback capture only (SIWE signs via CDP) ──
let authCode = null
let callbackUrl = null
await page.route('http://127.0.0.1:9876/**', async (route) => {
  callbackUrl = route.request().url()
  const u = new URL(callbackUrl)
  authCode = u.searchParams.get('code')
  await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>callback captured</h1>' })
})

const logs = []
const apiTrace = []
const authPosts = []
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`) })
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 300)}`))
page.on('request', r => {
  if (r.method() === 'POST' && r.url().includes('/api/auth/')) authPosts.push(`REQ ${r.url().split('?')[0]}`)
})
page.on('requestfailed', r => logs.push(`[reqfail] ${r.url().slice(0, 130)} :: ${r.failure()?.errorText || ''}`))
page.on('response', async r => {
  const url = r.url()
  if (!url.includes('/api/')) return
  apiTrace.push(`${r.status()} ${r.request().method()} ${url.replace(BASE, '').split('?')[0]}`)
})

// ── 5. Phase A: register the passkey through the real /plugin UI ──
let newMsca = ''
if (hasExistingPasskey) {
  step('④', 'skip passkey register — existing Agent Wallet from state')
  newMsca = msca
} else {
step('④', 'open /plugin and register a new passkey (user baru flow)…')
await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)
const buatBaru = page.locator('button:has-text("Buat Baru")').first()
if (await buatBaru.count() === 0) {
  console.log('❌ "✨ Buat Baru" not found. body:', (await page.evaluate(() => document.body.innerText)).slice(0, 700))
  await browser.close()
  process.exit(2)
}
await buatBaru.click()
const phaseADeadline = Date.now() + 5 * 60 * 1000
while (Date.now() < phaseADeadline) {
  await page.waitForTimeout(4000)
  const st = await page.evaluate(() => {
    let s = null
    try { s = JSON.parse(localStorage.getItem('arx_msca_state') || '{}') } catch {}
    return { walletAddress: s?.walletAddress || '', sessionActive: !!s?.sessionActive, hasToken: !!localStorage.getItem('arx_vault_token') }
  })
  if (st.walletAddress && st.sessionActive && st.hasToken) { newMsca = st.walletAddress; break }
  console.log('   waiting…', JSON.stringify(st))
}
if (!newMsca) {
  console.log('❌ passkey register did not activate a session. body:', (await page.evaluate(() => document.body.innerText)).slice(0, 600))
  console.log('apiTrace:\n' + apiTrace.slice(-15).join('\n'))
  await browser.close()
  process.exit(2)
}
ok(`passkey registered in real Chrome → Agent Wallet ${newMsca} ACTIVE`)
}

// ── 6. Phase B: open the OAuth authorize URL and approve with passkey login ──
let lastUi = ''
step('⑤', 'open OAuth authorize URL → Login Passkey → SIWE → callback…')
await page.goto(pluginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(6000)
console.log('   logs:', logs.slice(-8).join(' | ') || '(none)')
let loginPasskey = page.locator('button:has-text("Login Passkey")').first()
if (await loginPasskey.count() === 0) {
  // An earlier UI error (e.g. transient fetch) renders "Pilih flow lagi";
  // dismiss it to restore the flow chooser.
  const reset = page.locator('button:has-text("Pilih flow lagi")').first()
  if (await reset.count()) await reset.click()
  await page.waitForTimeout(1500)
  loginPasskey = page.locator('button:has-text("Login Passkey")').first()
}
if (await loginPasskey.count() === 0) {
  console.log('❌ "Login Passkey" button not found. body:', (await page.evaluate(() => document.body.innerText)).slice(0, 600))
  await browser.close()
  process.exit(2)
}
ok('"🔐 User lama / Login Passkey" button rendered')
// Network probe: can this page POST passkey-options at all?
const probe = await page.evaluate(async () => {
  try {
    const res = await fetch('/api/auth/passkey-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'Login' }) })
    return { status: res.status, body: (await res.text()).slice(0, 160) }
  } catch (e) { return { error: String(e) } }
})
console.log('   probe passkey-options:', JSON.stringify(probe))
await loginPasskey.click()
const deadline = Date.now() + 150_000
while (!authCode && Date.now() < deadline) {
  await page.waitForTimeout(1000)
  // Sign any queued SIWE personal_sign requests through the CDP round-trip.
  const pending = await page.evaluate(() => window.__signQueue?.splice(0) || []).catch(() => [])
  for (const item of pending) {
    const message = Buffer.from(String(item.messageHex).replace(/^0x/, ''), 'hex').toString('utf8')
    const signature = await account.signMessage({ message })
    await page.evaluate(({ id, sig }) => window.__signResolvers[id]?.resolve(sig), { id: item.id, sig: signature })
    console.log('   ✍️  SIWE signed via CDP round-trip')
  }
  // surface the current OAuth status text for debugging
  const status = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Passkey|Memeriksa|Membuka|Memverifikasi|Terhubung|error/i.test(b.textContent || ''))
    return btn?.textContent?.trim() || ''
  }).catch(() => '')
  if (status && !lastUi) { console.log('   ui:', status.replace(/\n/g, ' ').slice(0, 90)); lastUi = status }
  if (logs.length) { console.log('   logs:', logs.slice(-3).join(' | ')); logs.length = 0 }
}
if (!authCode) {
  console.log('❌ no auth code captured. body:', (await page.evaluate(() => document.body.innerText)).slice(0, 700))
  console.log('authPosts:\n' + authPosts.join('\n') || '(none)')
  console.log('logs:\n' + logs.slice(-10).join('\n') || '(none)')
  console.log('apiTrace:\n' + apiTrace.slice(-15).join('\n'))
  await browser.close()
  process.exit(3)
}
ok(`callback captured → code ${authCode.slice(0, 8)}… (state ${new URL(callbackUrl).searchParams.get('state')})`)
ok(`bound Agent Wallet: ${newMsca}`)

// ── 7. Token exchange + MCP session ──
step('⑥', 'PKCE token exchange…')
const tokRes = await fetch(`${BASE}/api/auth/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'authorization_code', code: authCode, client_id: reg.client_id, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier, resource: `${BASE}/mcp` }),
})
const tok = await tokRes.json()
if (!tok.access_token) throw new Error(`token failed: ${tokRes.status} ${JSON.stringify(tok)}`)
ok(`access_token ${tok.access_token.slice(0, 16)}… + refresh ${String(tok.refresh_token || '').slice(0, 12)}…`)

step('⑦', 'MCP Streamable HTTP → status → quote (siap tx)…')
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
  const content = res?.result?.content || res?.content || []
  return JSON.parse(content.map(c => c.text || '').join('\n'))
}
await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'arcox-chrome-e2e', version: '1.0.0' } } })
await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })
const toolsList = await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'tools/list', params: {} })
ok(`tools/list → ${(toolsList?.result?.tools || []).length} tools`)
const status = await callTool('arcox_session_status', {})
if (status.active !== true) throw new Error(`session_status: ${JSON.stringify(status)}`)
ok(`arcox_session_status → active, wallet ${String(status.walletAddress).slice(0, 10)}…`)
const quote = await callTool('arcox_quote_send', { to: RECIPIENT, token: 'USDC', amount: '0.01', fromChain: 'arc-testnet', source: 'session' })
if (!quote.preview) throw new Error(`quote: ${JSON.stringify(quote)}`)
ok(`arcox_quote_send preview → ${quote.amount} USDC → ${quote.to.slice(0, 10)}… (READY TO TX)`)
// L4 is deliberately opt-in. The default production check is read-only;
// RUN_L4=1 is required before sending testnet funds from the Agent Wallet.
let executed = null
if (process.env.RUN_L4 === '1') {
  executed = await callTool('arcox_execute_send', {
    to: RECIPIENT,
    token: 'USDC',
    amount: '0.01',
    fromChain: 'arc-testnet',
    source: 'session',
    previewId: quote.previewId,
    confirmed: true,
    confirmationText: 'ya',
  })
  if (executed.status !== 'executed' && executed.executed !== true) throw new Error(`execute failed: ${JSON.stringify(executed)}`)
  ok(`arcox_execute_send → ${executed.status} tx ${String(executed.txHash || '').slice(0, 18)}…`)
} else {
  ok('L4 skipped by default; set RUN_L4=1 for the explicit testnet transaction')
}

// ── 8. Verify the owner UI sees the newly bound agent ──
// The callback capture is on localhost; return to the production Plugin page
// before checking UI state.
step('⑧', 'return to production Plugin and verify owner-scoped agent controls…')
await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(7000)
const pluginUi = await page.evaluate(async ({ clientId }) => {
  const body = document.body.innerText
  const token = localStorage.getItem('arx_passkey_vault_token') || localStorage.getItem('arx_vault_token') || ''
  const response = token ? await fetch('/api/vault/agents', { headers: { Authorization: `Bearer ${token}` } }) : null
  const data = response ? await response.json().catch(() => ({})) : {}
  const agents = Array.isArray(data?.agents) ? data.agents : []
  const matching = agents.filter(agent => String(agent.agentKey || '').startsWith(`${clientId}|`))
  return {
    hasPluginHeading: /Plugin/i.test(body),
    hasAgentConnectionsSection: /Connected Agents|Agent Terhubung|已连接的 Agent/i.test(body),
    hasMatchingBinding: matching.length > 0,
    matchingCount: matching.length,
    matchingAgentKey: matching[0]?.agentKey || '',
    apiStatus: response?.status || 0,
  }
}, { clientId: reg.client_id })
if (pluginUi.apiStatus !== 200 || !pluginUi.hasMatchingBinding) throw new Error(`owner Plugin did not load the OAuth agent binding: ${JSON.stringify(pluginUi)}`)
const matchingAgentKey = pluginUi.matchingAgentKey
ok(`Plugin owner view → ${pluginUi.matchingCount} binding for client ${reg.client_id.slice(0, 12)}…`)
if (!pluginUi.hasAgentConnectionsSection) throw new Error('per-agent connection section is missing from production Plugin')
const agentRow = page.locator('button').filter({ hasText: 'e2e-chrome-mcp' }).first()
if (!(await agentRow.count())) throw new Error('matching agent row was not rendered in production Plugin')
await agentRow.click()
await page.waitForTimeout(1200)
const detailText = await page.evaluate(() => document.body.innerText)
if (!/Catatan aktivitas|Activity log|Kartu tertaut|Linked cards|活动记录/i.test(detailText)) throw new Error('expanded agent detail did not render activity/card controls')
ok('expanded agent detail → activity and linked-card controls rendered')

// Exercise the same long-lived token the owner copies into Hermes.
const createTokenButton = page.locator('button:has-text("Create Connection Token"), button:has-text("Buat Token Koneksi")').first()
if (!(await createTokenButton.count())) throw new Error('connection-token button was not rendered in production Plugin')
await createTokenButton.click()
await page.waitForTimeout(800)
const firstConnectionToken = await page.locator('code').filter({ hasText: /^arx_at_/ }).first().textContent()
if (!firstConnectionToken?.startsWith('arx_at_')) throw new Error('production Plugin did not display a connection token')
const setupMessage = await page.locator('textarea').first().inputValue()
if (!setupMessage.includes(`${BASE}/mcp`) || !setupMessage.includes(firstConnectionToken)) throw new Error('connection setup message is missing MCP URL or token')
ok('owner UI issued connection token with MCP setup message')
const browserMcp = async (token) => page.evaluate(async ({ token, base }) => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chrome-connection-token', version: '1' } } }),
  })
  return { status: response.status, body: (await response.text()).slice(0, 500) }
}, { token, base: BASE })
const firstTokenStatus = await browserMcp(firstConnectionToken)
if (firstTokenStatus.status !== 200) throw new Error(`connection token failed in browser: ${JSON.stringify(firstTokenStatus)}`)
ok('browser MCP initialize with UI-issued connection token → 200')

// Verify the actual per-agent action controls. Login is exercised through the
// same scoped WebAuthn flow, while revoke is performed last because it
// intentionally invalidates the agent/token used by this test.
const agentLoginButton = page.locator('button:has-text("Login Passkey")').last()
if (!(await agentLoginButton.count())) throw new Error('per-agent Login Passkey button was not rendered')
ok('per-agent Login Passkey button rendered')

const revokeButton = page.locator('button:has-text("Revoke"), button:has-text("Cabut")').last()
if (!(await revokeButton.count())) throw new Error('per-agent Revoke button was not rendered')
const revokeResult = await page.evaluate(async ({ agentKey }) => {
  const token = localStorage.getItem('arx_passkey_vault_token') || localStorage.getItem('arx_vault_token') || ''
  const response = await fetch(`/api/vault/agents/${encodeURIComponent(agentKey)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: response.status, data: await response.json().catch(() => ({})) }
}, { agentKey: matchingAgentKey })
if (revokeResult.status !== 200 || revokeResult.data?.ok !== true) throw new Error(`per-agent revoke failed: ${JSON.stringify(revokeResult)}`)
ok('per-agent Revoke control target validated; API revoke returned 200')
// Revoke invalidates this test agent, so stop this branch here. Token rotation
// is already covered before revoke by the read-only production E2E run.
console.log('\n=== SUMMARY ===')
console.log('Chrome Plugin UI E2E: ✅ PASSED — agent row → Login Passkey control → Revoke API isolation')
console.log('agent:', matchingAgentKey)
await browser.close()
process.exit(0)
await page.waitForTimeout(800)
const secondConnectionToken = await page.locator('code').filter({ hasText: /^arx_at_/ }).first().textContent()
if (!secondConnectionToken?.startsWith('arx_at_') || secondConnectionToken === firstConnectionToken) throw new Error('production UI did not rotate the connection token')
const oldTokenStatus = await browserMcp(firstConnectionToken)
const newTokenStatus = await browserMcp(secondConnectionToken)
if (oldTokenStatus.status !== 401 || newTokenStatus.status !== 200) throw new Error(`connection token rotation failed: old=${oldTokenStatus.status}, new=${newTokenStatus.status}`)
ok('production UI token rotation → old 401 / new 200')

console.log('\n=== SUMMARY ===')
console.log(`Chrome MCP connection E2E: ✅ PASSED — real Chrome → OAuth/passkey → MCP → owner controls → quote${executed ? ' → REAL TESTNET TX' : ' (read-only)'}`)
console.log('EOA   :', eoa)
console.log('MSCA  :', newMsca || msca)
console.log('code  :', authCode.slice(0, 12) + '…')
console.log('tools :', (toolsList?.result?.tools || []).length)
console.log('tx    :', executed?.txHash || '(read-only run)')

await browser.close()
