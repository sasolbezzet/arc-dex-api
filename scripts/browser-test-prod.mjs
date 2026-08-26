// browser-test-prod.mjs — REAL Chrome E2E on the DEPLOYED site.
//
// 1. Mint a valid legacy auth token for a test EOA via the production
//    /api/auth/session (signed in Node with viem).
// 2. Launch Google Chrome with:
//    - a minimal injected window.ethereum (eth_accounts / eth_chainId only;
//      the app's soft-reconnect needs no signature)
//    - localStorage arc-dex-auth + arx_vault_token (so App restores the address
//      without the wallet modal)
//    - a CDP WebAuthn virtual authenticator (auto-answers the passkey prompt)
// 3. Open /plugin, click "✨ Buat Baru", wait for the passkey register +
//    auto-activation on Arc/Base/Arbitrum, verify via the same-origin API.
import { privateKeyToAccount } from 'viem/accounts'
import { chromium } from '/tmp/browser-test/node_modules/playwright-core/index.mjs'

const BASE = 'https://arcoxdex.vercel.app'
const PRIVATE_KEY = process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`

// ── 1. Mint auth token for the test EOA ──
const account = privateKeyToAccount(PRIVATE_KEY)
const issuedAt = new Date().toISOString()
const message = [
  'ARCOX DEX login',
  'Only sign this message on the official ARCOX DEX website.',
  `Address: ${account.address}`,
  `Issued At: ${issuedAt}`,
  'Network: Arc Testnet',
].join('\n')
const signature = await account.signMessage({ message })
const sessionRes = await fetch(`${BASE}/api/auth/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: account.address, issuedAt, signature }),
})
const session = await sessionRes.json()
if (!session.token) throw new Error(`auth/session failed: ${sessionRes.status} ${JSON.stringify(session)}`)
console.log('① minted EOA auth token for', account.address)

// ── 2. Launch Chrome ──
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext()
const page = await context.newPage()

await context.addInitScript(({ addr, token }) => {
  window.ethereum = {
    isMetaMask: false,
    request: async ({ method }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr]
      if (method === 'eth_chainId') return '0x4cef52'
      if (method === 'net_version') return '5042002'
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      throw { code: 4001, message: 'rejected by automation' }
    },
    on() {},
    removeListener() {},
  }
  // Instrument storage writes so we can see exactly who sets and who wipes
  // arx_vault_token and when.
  const storageLog = []
  const origSet = localStorage.setItem.bind(localStorage)
  const origRemove = localStorage.removeItem.bind(localStorage)
  localStorage.setItem = (k, v) => {
    if (k === 'arx_vault_token') storageLog.push(`SET ${new Date().toISOString().slice(11, 19)} arx_vault_token len=${String(v).length} prefix=${String(v).slice(0, 12)}`)
    return origSet(k, v)
  }
  localStorage.removeItem = (k) => {
    if (k === 'arx_vault_token') storageLog.push(`DEL ${new Date().toISOString().slice(11, 19)} arx_vault_token`)
    return origRemove(k)
  }
  window.__storageLog = storageLog
  localStorage.setItem('arc-dex-auth', JSON.stringify({ address: addr, token, issuedAt: Date.now() }))
  // Keep the EOA login token in arc-dex-auth only. arx_vault_token is reserved
  // for the passkey/MSCA vault session and must not be populated with an EOA token.
  localStorage.removeItem('arx_vault_token')
  localStorage.removeItem('arx_passkey_vault_token')
  localStorage.removeItem('arx_msca_state')
}, { addr: account.address.toLowerCase(), token: session.token })

const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
})

const logs = []
const apiResponses = []
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[console.${m.type()}] ${m.text().slice(0, 350)}`) })
page.on('pageerror', e => logs.push(`[pageerror] ${String(e).slice(0, 350)}`))
page.on('requestfailed', r => logs.push(`[reqfail] ${r.url().slice(0, 130)} :: ${r.failure()?.errorText || ''}`))
// Record EVERY backend API call with status + elapsed ms so we can see the
// exact request that wipes arx_vault_token (401 → clearStaleSession).
const apiTrace = []
page.on('response', async r => {
  const url = r.url()
  if (!url.includes('/api/')) return
  const path = url.replace(BASE, '').split('?')[0]
  const req = r.request()
  const auth = (req.headers()['authorization'] || '').slice(0, 14)
  apiTrace.push(`${new Date().toISOString().slice(11, 19)} ${r.status()} ${req.method()} ${path} auth=${auth}`)
  if (r.status() >= 400) apiResponses.push(`${r.status()} ${req.method()} ${path}`)
})

// ── 3. Drive the deployed UI ──
console.log('② open', `${BASE}/plugin`)
await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(7000)
console.log('   url:', page.url())
const buttons = await page.$$eval('button', els => els.map(b => (b.textContent || '').trim()).filter(Boolean))
const initialBody = await page.evaluate(() => document.body.innerText)
console.log('   buttons:', JSON.stringify(buttons).slice(0, 700))
console.log('   empty agent state:', /No agents connected yet|Belum ada agent terhubung/i.test(initialBody) ? 'detected' : 'not active')

const emptyState = /No agents connected yet|Belum ada agent terhubung/i.test(initialBody)
const bootstrapButton = page.locator('button:has-text("Create Connection Token"), button:has-text("Buat Token Koneksi")').first()
if (emptyState && await bootstrapButton.count() === 0) {
  console.log('❌ empty agent state is missing the bootstrap connection-token button.')
  console.log('   body:', initialBody.slice(0, 1200))
  await browser.close()
  process.exit(2)
}
if (emptyState) console.log('   ✅ empty agent state exposes the bootstrap connection-token button')

const buatBaru = page.locator('button:has-text("Create New"), button:has-text("Buat Baru")').first()
if (await buatBaru.count() === 0) {
  console.log('❌ Agent Wallet creation button not found.')
  console.log('   body:', (await page.evaluate(() => document.body.innerText)).slice(0, 900))
  console.log('logs:\n' + logs.slice(-15).join('\n'))
  await browser.close()
  process.exit(2)
}

console.log('③ clicking Agent Wallet creation button (register passkey via virtual authenticator)…')
await buatBaru.click()

let active = false
let allChains = false
let lastState = ''
let tokenSeenAt = ''
let tokenGoneAt = ''
const deadline = Date.now() + 6 * 60 * 1000
while (Date.now() < deadline) {
  await page.waitForTimeout(4000)
  const st = await page.evaluate(() => {
    let s = null
    try { s = JSON.parse(localStorage.getItem('arx_msca_state') || '{}') } catch {}
    const chainAuth = s?.chainAuthorizationStatus || {}
    const tok = localStorage.getItem('arx_vault_token') || ''
    return {
      walletAddress: s?.walletAddress || '',
      delegateAddress: s?.delegateAddress || '',
      sessionActive: !!s?.sessionActive,
      deployed: !!s?.deployed,
      chainAuth,
      tokPrefix: tok ? tok.slice(0, 12) : '',
      hasVaultToken: !!tok,
    }
  })
  const json = JSON.stringify(st)
  if (st.hasVaultToken && !tokenSeenAt) tokenSeenAt = new Date().toISOString().slice(11, 19)
  if (!st.hasVaultToken && tokenSeenAt && !tokenGoneAt) tokenGoneAt = new Date().toISOString().slice(11, 19)
  if (json !== lastState) { lastState = json; console.log('   state:', json) }
  if (st.sessionActive) active = true
  if (st.sessionActive && st.chainAuth['base-sepolia'] === 'authorized' && st.chainAuth['arbitrum-sepolia'] === 'authorized') {
    allChains = true
    break
  }
}
console.log('   token seen at:', tokenSeenAt || 'never', '| gone at:', tokenGoneAt || 'still present')

// Verify the first-agent path that is used when the owner has no bindings.
// The test creates no blockchain transaction; the resulting binding/token are
// revoked immediately after the browser-level assertions below.
let bootstrapAgentKey = ''
let bootstrapToken = ''
if (emptyState && active) {
  const bootstrapButton = page.locator('button:has-text("Create Connection Token"), button:has-text("Buat Token Koneksi")').first()
  const nameInput = page.locator('input[aria-label="Nama agent"]').first()
  if (await bootstrapButton.count() === 0 || await nameInput.count() === 0) throw new Error('bootstrap controls are missing from the empty Agent Connections state')
  await nameInput.fill('Chrome Bootstrap E2E')
  await bootstrapButton.click()
  await page.waitForTimeout(1200)
  bootstrapToken = await page.locator('code').filter({ hasText: /^arx_at_/ }).first().textContent() || ''
  const setupText = await page.locator('textarea').first().inputValue().catch(() => '')
  if (!bootstrapToken.startsWith('arx_at_') || !setupText.includes(`${BASE}/mcp`) || !setupText.includes(bootstrapToken)) {
    throw new Error('empty-state bootstrap did not display a usable MCP setup token')
  }
  const bootstrapMcp = await page.evaluate(async ({ token }) => {
    const response = await fetch('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chrome-bootstrap-e2e', version: '1' } } }),
    })
    return { status: response.status, body: (await response.text()).slice(0, 250) }
  }, { token: bootstrapToken })
  if (bootstrapMcp.status !== 200) throw new Error(`bootstrap MCP initialize failed: ${JSON.stringify(bootstrapMcp)}`)
  const passkeyToken = await page.evaluate(() => localStorage.getItem('arx_passkey_vault_token') || localStorage.getItem('arx_vault_token') || '')
  const bootstrapAgents = await page.evaluate(async () => {
    const token = localStorage.getItem('arx_passkey_vault_token') || localStorage.getItem('arx_vault_token') || ''
    const response = await fetch('/api/vault/agents', { headers: { Authorization: `Bearer ${token}` } })
    return { status: response.status, data: await response.json().catch(() => ({})) }
  })
  const created = (bootstrapAgents.data?.agents || []).find(agent => agent.clientName === 'Chrome Bootstrap E2E')
  bootstrapAgentKey = created?.agentKey || ''
  if (bootstrapAgents.status !== 200 || !bootstrapAgentKey) throw new Error(`bootstrap binding missing from owner view: ${JSON.stringify(bootstrapAgents)}`)
  console.log('   ✅ empty-state bootstrap issued token + MCP initialize 200 + owner binding')
  const revoked = await page.evaluate(async ({ agentKey, token }) => {
    const response = await fetch(`/api/vault/agents/${encodeURIComponent(agentKey)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    return { status: response.status, data: await response.json().catch(() => ({})) }
  }, { agentKey: bootstrapAgentKey, token: passkeyToken })
  if (revoked.status !== 200) throw new Error(`bootstrap cleanup failed: ${JSON.stringify(revoked)}`)
  const oldTokenResponse = await page.evaluate(async ({ token }) => {
    const response = await fetch('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 18, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chrome-bootstrap-revoked', version: '1' } } }) })
    return response.status
  }, { token: bootstrapToken })
  if (oldTokenResponse !== 401) throw new Error(`revoked bootstrap token remained valid: ${oldTokenResponse}`)
  console.log('   ✅ bootstrap test binding revoked and token now returns 401')
}
const storageOps = await page.evaluate(() => window.__storageLog || [])
console.log('   arx_vault_token storage ops:\n' + storageOps.slice(-25).join('\n') || '   (none)')

const verify = await page.evaluate(async () => {
  const token = localStorage.getItem('arx_vault_token') || ''
  let msca = ''
  try { msca = JSON.parse(localStorage.getItem('arx_msca_state') || '{}').walletAddress || '' } catch {}
  const out = { hasToken: !!token, msca }
  if (token && msca) {
    const s = await fetch('/api/session/status', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({}))
    out.session = { active: s.session?.active, statusReason: s.session?.statusReason, delegate: s.session?.delegateAddress }
    for (const chainKey of ['base-sepolia', 'arbitrum-sepolia']) {
      const d = await fetch(`/api/session/destination-status?chainKey=${chainKey}&walletAddress=${encodeURIComponent(msca)}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({}))
      out[chainKey] = { deployed: d.deployed, authorized: d.authorized }
    }
  }
  return out
})
console.log('④ API verification (from browser context):')
console.log(JSON.stringify(verify, null, 2))
console.log('⑤ full API trace (status method path auth-prefix):')
console.log(apiTrace.slice(-40).join('\n') || '   (none)')
console.log('⑥ backend API errors observed:')
console.log(apiResponses.slice(-30).join('\n') || '   (none)')
console.log('⑦ console/page errors:')
console.log(logs.slice(-25).join('\n') || '   (none)')

// Destination authorization runs best-effort after Arc activation; give the
// API-side reconciliation a short grace period before declaring failure.
let ok = active && verify.session?.active === true && verify['base-sepolia']?.authorized === true && verify['arbitrum-sepolia']?.authorized === true
if (!ok && active) {
  console.log('   (destination chains not ready yet — waiting up to 60s)')
  for (let i = 0; i < 15 && !ok; i++) {
    await page.waitForTimeout(4000)
    const retry = await page.evaluate(async () => {
      const token = localStorage.getItem('arx_vault_token') || ''
      let msca = ''
      try { msca = JSON.parse(localStorage.getItem('arx_msca_state') || '{}').walletAddress || '' } catch {}
      if (!token || !msca) return { hasToken: !!token, msca }
      const s = await fetch('/api/session/status', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({}))
      const out = { hasToken: true, msca, session: { active: s.session?.active, statusReason: s.session?.statusReason } }
      for (const chainKey of ['base-sepolia', 'arbitrum-sepolia']) {
        const d = await fetch(`/api/session/destination-status?chainKey=${chainKey}&walletAddress=${encodeURIComponent(msca)}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()).catch(() => ({}))
        out[chainKey] = { deployed: d.deployed, authorized: d.authorized }
      }
      return out
    })
    console.log('   retry:', JSON.stringify(retry))
    ok = retry.session?.active === true && retry['base-sepolia']?.authorized === true && retry['arbitrum-sepolia']?.authorized === true
  }
}

await page.screenshot({ path: '/tmp/browser-test/final.png' })
await browser.close()

if (ok) {
  console.log('\n✅ BROWSER E2E PASSED — real Chrome passkey register → session ACTIVE on Arc/Base/Arbitrum')
  process.exit(0)
} else {
  console.log('\n❌ BROWSER E2E FAILED')
  process.exit(1)
}
