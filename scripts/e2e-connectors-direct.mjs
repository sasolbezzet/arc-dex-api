// e2e-connectors-direct.mjs — DIRECT connection E2E for both connector paths.
//
// A. Hermes (paste-token path): UI token creation must hand the user a
//    ready-to-paste setup (hermes mcp add … --auth header) and the tools it
//    reads back must be Hermes-readable (valid name + JSON-schema input).
// B. Claude (claude.ai): DCR → authorize → approval page (passkey Register →
//    new dedicated Agent Wallet → SIWE) → redirect BACK to
//    https://claude.ai/api/mcp/auth_callback?code&state → code exchange →
//    /mcp initialize 200 = connector live, Claude web ready to chat.
// C. ChatGPT (chatgpt.com): same with the connector_platform_oauth callback.
//
// Usage: node --env-file=.env scripts/e2e-connectors-direct.mjs
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { hexToBytes } from 'viem'
import { chromium } from '/home/ubuntu/arc-dex/node_modules/playwright-core/index.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const EOA_KEY = process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`
const MCP_RESOURCE = `${BASE}/mcp`

const account = privateKeyToAccount(EOA_KEY)
const eoa = account.address
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const msca = String(state.walletAddress || '').toLowerCase()
if (!msca || !state.credentialId || !state.pkcs8) throw new Error('state file must have walletAddress + credentialId + pkcs8')

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)
const short = a => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

let browser
const failExit = async (page, code, why) => {
  console.log('❌', why)
  try { console.log('body tail:', (await page.evaluate(() => document.body.innerText)).slice(-700)) } catch {}
  await browser?.close()
  process.exit(code)
}

const resolveSignatures = async (page, stopAt) => {
  // SIWE helper: the page queues personal_sign requests on the injected
  // provider; we sign them here with the test EOA and hand results back.
  while (Date.now() < stopAt) {
    let items = []
    try { items = await page.evaluate(() => (window.__signQueue || []).splice(0, (window.__signQueue || []).length)) } catch {}
    for (const item of items) {
      try {
        const signature = await account.signMessage({ message: { raw: hexToBytes(item.messageHex) } })
        await page.evaluate(({ id, signature }) => window.__signResolvers?.[id]?.resolve(signature), { id: item.id, signature })
        console.log('   ✍️  signed SIWE challenge for', String(item.id).slice(0, 8))
      } catch (e) {
        console.log('   ⚠️ sign failed:', String(e).slice(0, 120))
        await page.evaluate(({ id }) => window.__signResolvers?.[id]?.reject(new Error('automation sign failed')), { id: item.id }).catch(() => {})
      }
    }
    try { await page.waitForTimeout(700) } catch { break }
  }
}

const runConnector = async (page, context, { name, redirectUri }) => {
  // 1. DCR exactly like the connector does.
  const dcr = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: `${name} E2E`, redirect_uris: [redirectUri] }),
  })
  const client = await dcr.json()
  if (dcr.status !== 201 || !client.client_id) throw new Error(`DCR ${name}: ${dcr.status} ${JSON.stringify(client).slice(0, 160)}`)

  // 2. authorize → 302 into the web approval page.
  const { verifier, challenge } = pkce()
  const stateValue = `e2e-${name}-${Date.now()}`
  const authorizeUrl = new URL(`${BASE}/api/auth/authorize`)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', client.client_id)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('state', stateValue)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('resource', MCP_RESOURCE)
  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' })
  const approvalUrl = authorizeRes.headers.get('location')
  if (authorizeRes.status !== 302 || !approvalUrl || !approvalUrl.includes('auth=mcp')) {
    throw new Error(`authorize ${name}: HTTP ${authorizeRes.status} location=${approvalUrl}`)
  }

  // 3. Open the approval page like the user's browser would.
  const callbackRequests = []
  await page.route(redirectUri.startsWith('https://claude.ai') ? 'https://claude.ai/**' : 'https://chatgpt.com/**', route => {
    callbackRequests.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<html><body>E2E connector landing stub</body></html>` })
  })
  await page.goto(approvalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(5000)
  const approvalText = await page.locator('body').innerText()
  if (!approvalText.includes('Otorisasi Claude / ChatGPT')) {
    throw new Error(`approval panel did not render for ${name} — OAuth URL parsing broken? body: ${approvalText.slice(0, 220)}`)
  }
  const approveNew = page.locator('button:has-text("buat wallet baru")').first()
  if (await approveNew.count() === 0) throw new Error(`"Setujui + buat wallet baru" button missing for ${name}`)
  const deadline = Date.now() + 420_000
  const signerDone = resolveSignatures(page, deadline) // SIWE signing loop
  await approveNew.click()
  console.log(`   ⏳ ${name} approval running (passkey Register + session setup + SIWE)…`)

  // 4. Wait for the redirect back to the connector callback.
  let callbackUrl = ''
  while (Date.now() < deadline && callbackRequests.length === 0) { try { await page.waitForTimeout(1500) } catch { break } }
  await signerDone
  if (callbackRequests.length === 0) {
    const tail = await page.evaluate(() => document.body.innerText).catch(() => '')
    throw new Error(`${name}: no callback redirect within timeout. body tail: ${tail.slice(-260)}`)
  }
  callbackUrl = callbackRequests[0]
  const cb = new URL(callbackUrl)
  const code = cb.searchParams.get('code')
  const returnedState = cb.searchParams.get('state')
  if (!code) throw new Error(`${name}: callback missing code → ${callbackUrl}`)
  if (returnedState !== stateValue) throw new Error(`${name}: state mismatch (${returnedState} ≠ ${stateValue})`)
  ok(`${name}: redirected back with code + matching state → ${redirectUri}`)

  // 5. Exchange the code and prove the connector is LIVE on /mcp.
  const tokenRes = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier, resource: MCP_RESOURCE }),
  })
  const tokenBody = await tokenRes.json()
  if (!tokenBody.access_token) throw new Error(`${name}: token exchange failed: ${tokenRes.status} ${JSON.stringify(tokenBody).slice(0, 200)}`)
  const initRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenBody.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: `${name.toLowerCase()}-connector`, version: '1.0' } } }),
  })
  if (initRes.status !== 200) throw new Error(`${name}: /mcp initialize with OAuth token → ${initRes.status}`)
  ok(`${name}: OAuth access token accepted by /mcp → connector LIVE, ready to chat`)

  // Cleanup: revoke the agent binding this run just created so repeated E2E
  // runs never accumulate test agents/wallets in the owner's list.
  try {
    // The page already redirected to the connector origin, so read the vault
    // token from the captured storage of every origin we visited.
    const ss = await context.storageState()
    const origin = ss.origins.find(o => o.origin.includes('arcoxdex'))
    const vaultToken = origin?.localStorage?.find(i => i.name === 'arx_vault_token')?.value || ''
    if (vaultToken) {
      const list = await (await fetch(`${BASE}/api/vault/agents`, { headers: { Authorization: `Bearer ${vaultToken}` } })).json()
      const agents = Array.isArray(list) ? list : (list.agents || [])
      const mine = agents.filter(a => String(a.agentKey || a.key || '').startsWith(`${client.client_id}|`))
      for (const a of mine) {
        const key = a.agentKey || a.key
        const del = await fetch(`${BASE}/api/vault/agents/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${vaultToken}` } })
        if (del.ok) console.log(`   🧹 cleaned up test agent ${String(key).slice(0, 40)}…`)
      }
    }
  } catch (e) {
    console.log('   ⚠️ cleanup skipped:', String(e?.message || e).slice(0, 120))
  }
  return { callbackUrl, tokenScope: tokenBody.scope || '' }
}

const ONLY = String(process.env.ONLY || '').toLowerCase() // '' | 'chatgpt' → skip owner login + Hermes

try {
  // ── ① mint EOA web-login token + Chrome with seeded passkey ──
  step('①', ONLY === 'chatgpt' ? 'launch Chrome for connector-only run…' : 'mint EOA web-login token + launch Chrome (virtual passkey)…')
  const issuedAt = new Date().toISOString()
  const loginMessage = ['ARCOX DEX login', 'Only sign this message on the official ARCOX DEX website.', `Address: ${eoa}`, `Issued At: ${issuedAt}`, 'Network: Arc Testnet'].join('\n')
  const loginSignature = await account.signMessage({ message: loginMessage })
  const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: eoa, issuedAt, signature: loginSignature }) })).json()
  if (!session.token) throw new Error(`auth/session failed: ${JSON.stringify(session).slice(0, 160)}`)

  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext()
  const page = await context.newPage()
  await context.addInitScript(({ addr, authToken }) => {
    localStorage.removeItem('arx_vault_token')
    localStorage.removeItem('arx_passkey_vault_token')
    localStorage.setItem('arc-dex-lang', 'id')
    localStorage.setItem('arc-dex-auth', JSON.stringify({ address: addr, token: authToken, issuedAt: Date.now() }))
    window.__signQueue = []
    window.__signResolvers = {}
    window.ethereum = {
      isMetaMask: false,
      request: async ({ method, params }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [addr]
        if (method === 'eth_chainId') return '0x4cef52'
        if (method === 'net_version') return '5042002'
        if (method === 'personal_sign') {
          const messageHex = params?.[0]
          const id = Math.random().toString(36).slice(2)
          return new Promise((resolve, reject) => { window.__signQueue.push({ id, messageHex }); window.__signResolvers[id] = { resolve, reject } })
        }
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
        throw { code: 4001, message: 'rejected by automation' }
      },
      on() {}, removeListener() {},
    }
  }, { addr: eoa.toLowerCase(), authToken: session.token })

  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, rpId: 'arcoxdex.vercel.app' },
  })
  const b64 = s => Buffer.from(s, 'base64url').toString('base64')
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: authenticator.authenticatorId,
    credential: { credentialId: b64(state.credentialId), isResidentCredential: true, rpId: state.rpId || 'arcoxdex.vercel.app', privateKey: Buffer.from(state.pkcs8, 'base64url').toString('base64'), userHandle: state.userHandle ? b64(state.userHandle) : undefined, signCount: 0 },
  })

  let hermes = { count: 0, names: [] }
  let connectionToken = ''
  if (ONLY !== 'chatgpt') {
  // ── ② owner login passkey ──
  step('②', 'open /plugin → Login Passkey (owner ceremony)…')
  await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await page.locator('button:has-text("Login Passkey")').first().click()
  const loginDeadline = Date.now() + 150_000
  let activated = false
  while (Date.now() < loginDeadline) {
    await page.waitForTimeout(3000)
    const st = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('arx_msca_state') || '{}') } catch { return {} } }).catch(() => ({}))
    if (st.walletAddress && st.walletAddress.toLowerCase() === msca && st.sessionActive) { activated = true; break }
  }
  if (!activated) await failExit(page, 3, 'passkey login never activated the saved Agent Wallet')
  ok(`owner Agent Wallet ${short(msca)} ACTIVE`)

  // ── ③ HERMES: token + ready-to-paste setup + Hermes-readable tools ──
  step('③', 'HERMES: Buat Token Koneksi → direct setup message…')
  // Select the actual connected-agent card; wallet overview rows are not
  // actionable and can have the same shortened address.
  const agentSection = page.locator('[data-testid="connected-agent-actions"]').locator('..')
  const agentRows = agentSection.locator('button').filter({ hasText: /…[0-9a-fA-F]{6}/ })
  if (await agentRows.count() === 0) await failExit(page, 4, 'no agent rows visible in Connected Agents')
  await agentRows.first().click()
  await page.waitForTimeout(1500)
  const tokenButton = page.locator('button:has-text("Buat Token Koneksi"), button:has-text("Create Connection Token"), button:has-text("Create connection token")').last()
  await tokenButton.click({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  // The UI may render the token in a code element or in the token dialog text.
  const tokenText = await page.locator('#arx-hermes-token-dialog').innerText({ timeout: 10_000 })
  connectionToken = (tokenText.match(/arx_at_[a-f0-9]+/i) || [])[0] || ''
  if (!connectionToken.startsWith('arx_at_')) await failExit(page, 4, 'connection token not displayed')
  const setupMessage = await page.locator('textarea').first().inputValue()
  const directCommand = `hermes mcp add arcox --url ${BASE}/mcp --auth header`
  if (!setupMessage.includes(directCommand)) await failExit(page, 4, `setup message missing the direct command "${directCommand}"`)
  if (!setupMessage.includes(connectionToken)) await failExit(page, 4, 'setup message does not embed the token')
  ok(`token ${connectionToken.slice(0, 14)}… + direct command present (no searching required)`)

  step('④', 'HERMES: handshake with default headers → tools must be Hermes-readable…')
  hermes = await page.evaluate(async ({ token, base }) => {
    const post = async (body, sid) => {
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) })
      const raw = await res.text()
      let parsed; try { parsed = JSON.parse(raw) } catch {
        const line = String(raw).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
        try { parsed = JSON.parse(line) } catch { parsed = raw }
      }
      return { status: res.status, sid: res.headers.get('mcp-session-id'), body: parsed }
    }
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes-direct', version: '1.0' } } })
    if (init.status !== 200) return { error: `initialize HTTP ${init.status}` }
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid)
    const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid)
    const list = tools.body?.result?.tools || []
    const broken = list.filter(t => !t || typeof t.name !== 'string' || !t.name || !t.inputSchema || typeof t.inputSchema !== 'object' || t.inputSchema.type !== 'object').map(t => t?.name || JSON.stringify(t).slice(0, 40))
    return { count: list.length, broken: broken.slice(0, 8), names: list.slice(0, 6).map(t => t.name) }
  }, { token: connectionToken, base: BASE })
  if (hermes.error) await failExit(page, 5, `Hermes handshake failed: ${hermes.error}`)
  if (hermes.count < 10) await failExit(page, 5, `only ${hermes.count} tools`)
  if (hermes.broken.length) await failExit(page, 5, `tools NOT Hermes-readable (name/inputSchema.type=object): ${hermes.broken.join(', ')}`)
  ok(`${hermes.count} tools, all with valid name + inputSchema(type=object) — e.g. ${hermes.names.join(', ')}`)
  } else {
    ok('connector-only run: skipping owner login + Hermes stages')
  }

  // ── ⑤ CLAUDE: direct web approval → back to claude.ai → live connector ──
  let claude = null
  if (ONLY !== 'chatgpt') {
    step('⑤', 'CLAUDE: authorize → web approval → redirect back to claude.ai…')
    claude = await runConnector(page, context, { name: 'Claude', redirectUri: 'https://claude.ai/api/mcp/auth_callback' })
  }

  // ── ⑥ CHATGPT: same direct path to chatgpt.com ──
  let chatgpt = null
  if (ONLY !== 'claude') {
    step('⑥', 'CHATGPT: authorize → web approval → redirect back to chatgpt.com…')
    chatgpt = await runConnector(page, context, { name: 'ChatGPT', redirectUri: 'https://chatgpt.com/connector_platform_oauth/callback' })
  }

  console.log('\n=== SUMMARY ===')
  console.log('CONNECTORS DIRECT E2E: ✅ PASSED')
  console.log('Hermes   : direct setup command +', hermes.count, 'Hermes-readable tools')
  if (claude) console.log('Claude   : approval →', claude.callbackUrl.slice(0, 72) + '… → /mcp 200')
  if (chatgpt) console.log('ChatGPT  : approval →', chatgpt.callbackUrl.slice(0, 72) + '… → /mcp 200')
  console.log('Result   : web Claude/ChatGPT menerima code+state dan token OAuth live — siap chat')
  await browser.close()
  browser = null
  process.exit(0)
} catch (error) {
  console.log('❌ FATAL:', error?.message || error)
  try { await browser?.close() } catch {}
  process.exit(20)
}
