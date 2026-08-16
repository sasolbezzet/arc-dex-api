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

// Fresh virtual authenticator: the passkey is created natively by the browser
// during the flow (Register), exactly like a new user on the deployed site.
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, rpId: 'arcoxdex.vercel.app' },
})
ok('virtual authenticator ready (passkey will be created natively)')

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
let newMsca = ''
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

// ── 8. Verify session visible in the UI agents list ──
const agents = await page.evaluate(() => document.body.innerText.includes('Terhubung')).catch(() => false)
ok(`plugin page reflects connection (Terhubung=${agents})`)

console.log('\n=== SUMMARY ===')
console.log('Chrome MCP connection E2E: ✅ PASSED — real Chrome → passkey login → SIWE → code → token → MCP session → READY TO TX')
console.log('EOA   :', eoa)
console.log('MSCA  :', newMsca || msca)
console.log('code  :', authCode.slice(0, 12) + '…')
console.log('tools :', (toolsList?.result?.tools || []).length)

await browser.close()
