// e2e-old-user-tx-ready.mjs — REAL Chrome E2E as an EXISTING ("user lama") owner.
//
// Old-user habits exercised end-to-end against production:
//   ①  mint an EOA web-login token (what the site does after SIWE login)
//   ②  launch Chrome with a CDP virtual authenticator SEEDED with the saved
//      passkey credential (/tmp/arcox-e2e-prod-state.json), so the real
//      "Login Passkey" ceremony answers exactly like on the user's device
//   ③  open /plugin WITHOUT a stored vault token → click "Login Passkey"
//      like an old user does every visit → wait until the Agent Wallet is
//      active again
//   ④  verify the rebuilt UX they now see: onboarding stepper, wallet listed
//      per agent, copy-address affordance, three agent controls intact
//   ⑤  rotate credentials like a real owner: Buat Token Koneksi → capture the
//      one-time arx_at_ token + setup message
//   ⑥  drive the MCP endpoint FROM THE PAGE using Hermes's default headers
//      (Accept: application/json only — the exact payload shape that used to
//      get HTTP 406 before the interop fix)
//   ⑦  prove the Claude/ChatGPT protocol surface still answers (RFC 9728 +
//      RFC 8414 metadata + dynamic client registration)
//   ⑧  session_status + wallet_balances + arcox_quote_send = READY TO TX
//   ⑨  RUN_L4=1 optionally executes the real 0.01 USDC testnet transfer
//
// Usage: node --env-file=.env scripts/e2e-old-user-tx-ready.mjs [RUN_L4=1]
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { chromium } from '/tmp/browser-test/node_modules/playwright-core/index.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const EOA_KEY = process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`
const RECIPIENT = process.env.E2E_RECIPIENT || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

const account = privateKeyToAccount(EOA_KEY)
const eoa = account.address
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const msca = String(state.walletAddress || '').toLowerCase()
if (!msca || !state.credentialId || !state.pkcs8) throw new Error('state file must have walletAddress + credentialId + pkcs8')

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)
const short = a => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`
const failExit = async (page, code, why) => {
  console.log('❌', why)
  try { console.log('body:', (await page.evaluate(() => document.body.innerText)).slice(0, 900)) } catch {}
  await browser?.close()
  process.exit(code)
}

let browser
try {
  // ── ① mint the EOA web-login token ──
  step('①', 'mint EOA web-login token…')
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
  ok(`auth token for ${short(eoa)}`)

  // ── ② launch Chrome: virtual authenticator + injected provider ──
  step('②', 'launch Chrome (CDP WebAuthn seeded + injected ethereum)…')
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext()
  const page = await context.newPage()

  await context.addInitScript(({ addr, authToken }) => {
    // Aged-out session: simulate the recurring "old user visits again" state.
    localStorage.removeItem('arx_vault_token')
    localStorage.removeItem('arx_passkey_vault_token')
    // Pin the UI language the assertions below expect (fresh profiles would
    // otherwise follow navigator.language and render English labels).
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
  }, { addr: eoa.toLowerCase(), authToken: session.token })

  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, rpId: 'arcoxdex.vercel.app' },
  })
  const b64 = s => Buffer.from(s, 'base64url').toString('base64')
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: authenticator.authenticatorId,
    credential: {
      credentialId: b64(state.credentialId),
      isResidentCredential: true,
      rpId: state.rpId || 'arcoxdex.vercel.app',
      privateKey: Buffer.from(state.pkcs8, 'base64url').toString('base64'),
      userHandle: state.userHandle ? b64(state.userHandle) : undefined,
      signCount: 0,
    },
  })
  ok(`virtual authenticator seeded with saved passkey ${state.credentialId.slice(0, 10)}…`)

  const consoleErrors = []
  const pageErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => pageErrors.push(String(e)))

  // ── ③ old-user login Passkey through the real UI ──
  step('③', 'open /plugin → click Login Passkey (user-lama ceremony)…')
  await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(6000)
  const initialText = await page.locator('body').innerText()
  if (!initialText.includes('Mulai di sini')) await failExit(page, 2, 'onboarding stepper "Mulai di sini" is missing')
  const loginButton = page.locator('button:has-text("Login Passkey")').first()
  if (await loginButton.count() === 0) await failExit(page, 2, 'no Login Passkey button rendered')
  await loginButton.click()
  const deadline = Date.now() + 150_000
  let activated = false
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000)
    const st = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('arx_msca_state') || '{}') } catch { return {} }
    }).catch(() => ({}))
    if (st.walletAddress && st.walletAddress.toLowerCase() === msca && st.sessionActive) { activated = true; break }
  }
  if (!activated) await failExit(page, 3, 'passkey login never activated the saved Agent Wallet')
  const vaultToken = await page.evaluate(() => localStorage.getItem('arx_passkey_vault_token') || localStorage.getItem('arx_vault_token') || '')
  if (!vaultToken) await failExit(page, 3, 'vault token missing after login')
  ok(`passkey login succeeded → Agent Wallet ${short(msca)} ACTIVE again`)

  // ── ④ rebuilt UX seen by the old user ──
  step('④', 'verify rebuilt UX (stepper progress, wallet-per-agent list, copy affordance)…')
  const uiText = await page.locator('body').innerText()
  if (!uiText.includes('Aktifkan Agent Wallet')) await failExit(page, 4, 'stepper lost its step-1 label')
  if (!uiText.includes('Agent Terhubung')) await failExit(page, 4, 'Agent Terhubung section missing')
  const agentRows = page.locator('button').filter({ hasText: /[0-9a-fA-F]{6}\u2026|\u2026[0-9a-fA-F]{6}/ })
  if (await agentRows.count() === 0) await failExit(page, 4, 'no existing agent rows for the saved wallet')
  if (!uiText.includes('Daftar wallet agent')) await failExit(page, 4, '"Daftar wallet agent" summary missing')
  const copyAffordance = page.locator('[aria-label="Salin alamat wallet agent"]')
  if (await copyAffordance.count() === 0) await failExit(page, 4, 'wallet copy affordance missing on agent rows')
  ok(`${await agentRows.count()} agent row(s); wallet list + copy button present`)

  // ── ⑤ rotate credentials: Buat Token Koneksi ──
  step('⑤', 'Buat Token Koneksi (old-user rotation habit)…')
  const agentToggle = agentRows.first()
  await agentToggle.scrollIntoViewIfNeeded().catch(() => {})
  try {
    await agentToggle.click({ timeout: 8000 })
  } catch (e) {
    const btns = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim().slice(0, 40)).filter(Boolean))
    await failExit(page, 5, `agent-row click failed (${e.message?.slice(0, 80)}); visible buttons:\n${btns.join(' | ')}`)
  }
  await page.waitForTimeout(1500)
  let expandProbe
  try {
    expandProbe = await page.waitForSelector('button:has-text("Buat Token Koneksi"), button:has-text("Create Connection Token")', { state: 'visible', timeout: 8000 })
  } catch {
    const btns = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim().slice(0, 40)).filter(Boolean))
    await failExit(page, 5, `token button not visible after expand; buttons present:\n${btns.join(' | ')}`)
  }
  void expandProbe
  const expandedText = await page.locator('body').innerText()
  for (const needed of ['Login Passkey']) {
    if (!expandedText.includes(needed)) await failExit(page, 5, `agent card missing "${needed}"`)
  }
  try {
    await page.locator('button:has-text("Buat Token Koneksi"), button:has-text("Create Connection Token")').first().click({ timeout: 10000 })
  } catch {
    const btns = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim().slice(0, 40)).filter(Boolean))
      await failExit(page, 5, `create-token button vanished before click; buttons:\n${btns.join(' | ')}`)
  }
  await page.waitForTimeout(1200)
  const connectionToken = ((await page.locator('code').filter({ hasText: /^arx_at_/ }).first().textContent()) || '').trim()
  if (!connectionToken.startsWith('arx_at_')) await failExit(page, 5, 'one-time connection token not displayed')
  const setupMessage = await page.locator('textarea').first().inputValue()
  if (!setupMessage.includes(`${BASE}/mcp`) || !setupMessage.includes(connectionToken)) await failExit(page, 5, 'setup message incomplete')
  ok(`captured ${connectionToken.slice(0, 16)}… with setup instructions`)

  // ── ⑥ Hermes-default handshake FROM THE PAGE (Accept json-only!) ──
  step('⑥', 'MCP handshake via page fetch with Hermes default headers…')
  const hermesHandshake = await page.evaluate(async ({ token, base }) => {
    const post = async (body, sid) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) },
        body: JSON.stringify(body),
      })
      const raw = await res.text()
      let parsed
      try { parsed = JSON.parse(raw) } catch {
        const line = String(raw).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
        try { parsed = JSON.parse(line) } catch { parsed = raw }
      }
      return { status: res.status, sid: res.headers.get('mcp-session-id'), body: parsed }
    }
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes-sim-from-page', version: '1.0' } } })
    if (init.status !== 200) return { error: `initialize HTTP ${init.status}: ${JSON.stringify(init.body).slice(0, 160)}` }
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid)
    const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid)
    return { status: tools.status, count: (tools.body?.result?.tools || []).length }
  }, { token: connectionToken, base: BASE })
  if (hermesHandshake.error) await failExit(page, 6, `Hermes-default handshake failed: ${hermesHandshake.error}`)
  if (hermesHandshake.count < 10) await failExit(page, 6, `tools/list only returned ${hermesHandshake.count} tools`)
  ok(`Hermes-default Accept:application/json accepted → initialize 200, ${hermesHandshake.count} tools`)

  // ── ⑦ Claude/ChatGPT protocol surface intact ──
  step('⑦', 'Claude/ChatGPT OAuth discovery probes…')
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server/mcp']) {
    const res = await fetch(`${BASE}${path}`)
    if (res.status !== 200) await failExit(page, 7, `${path} → ${res.status}`)
  }
  const meta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server/mcp`)).json()
  if (meta.issuer !== BASE || !meta.registration_endpoint) await failExit(page, 7, `metadata mismatch: ${JSON.stringify(meta).slice(0, 200)}`)
  const dcr = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'claude-chatgpt-probe', redirect_uris: ['http://localhost:9877/callback'] }),
  })
  const dcrBody = await dcr.json()
  if (dcr.status !== 201 || !String(dcrBody.client_id || '').startsWith('arcox_')) await failExit(page, 7, `dynamic client registration broken: ${dcr.status} ${JSON.stringify(dcrBody).slice(0, 200)}`)
  ok(`protected-resource + authorization-server 200, issuer ${meta.issuer}, DCR issues clients (${dcrBody.client_id})`)

  // ── ⑧ READY TO TX ──
  step('⑧', 'session_status → balances → quote (READY TO TX)…')
  let sessionId = ''
  let reqId = 1
  const mcpPost = async body => {
    const headers = { Authorization: `Bearer ${connectionToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const raw = await res.text()
    try { return JSON.parse(raw) } catch {
      const line = String(raw).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
      try { return JSON.parse(line) } catch { return raw }
    }
  }
  const callTool = async (name, args) => {
    const res = await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'tools/call', params: { name, arguments: args } })
    const content = res?.result?.content || []
    return JSON.parse(content.map(c => c.text || '').join('\n'))
  }
  await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'arcox-ready-check', version: '1.0.0' } } })
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const sessionStatus = await callTool('arcox_session_status', {})
  if (sessionStatus.active !== true) await failExit(page, 8, `session_status: ${JSON.stringify(sessionStatus).slice(0, 220)}`)
  ok(`arcox_session_status → active, wallet ${short(sessionStatus.walletAddress || msca)}`)
  const balances = await callTool('arcox_wallet_balances', {})
  const arcUsdc = balances.chains?.['arc-testnet']?.USDC ?? balances.USDC
  ok(`arcox_wallet_balances → Arc USDC ${arcUsdc ?? '?'}`)
  const quote = await callTool('arcox_quote_send', { to: RECIPIENT, token: 'USDC', amount: '0.01', fromChain: 'arc-testnet', source: 'session' })
  if (!quote.preview) await failExit(page, 8, `quote rejected: ${JSON.stringify(quote).slice(0, 260)}`)
  ok(`arcox_quote_send preview → ${quote.amountIn || quote.amount} USDC → ${String(quote.recipient || quote.to || '').slice(0, 10)}… (previewId ${String(quote.previewId).slice(0, 8)}…) — READY TO TX`)

  // ── ⑨ optional REAL execution ──
  let executedInfo = null
  if (process.env.RUN_L4 === '1') {
    step('⑨', 'EXECUTE real 0.01 USDC testnet transfer…')
    const executed = await callTool('arcox_execute_send', {
      to: RECIPIENT, token: 'USDC', amount: '0.01', fromChain: 'arc-testnet', source: 'session',
      previewId: quote.previewId, confirmed: true, confirmationText: 'ya',
    })
    if (executed.status !== 'executed' && executed.executed !== true) await failExit(page, 9, `execute failed: ${JSON.stringify(executed).slice(0, 320)}`)
    executedInfo = executed
    ok(`REAL TX EXECUTED → ${executed.txHash} | ${executed.explorerUrl || ''}`)
  }

  if (pageErrors.length) await failExit(page, 10, `uncaught page errors: ${pageErrors[0]}`)
  if (consoleErrors.length) console.log('\n   (non-fatal console messages:', consoleErrors.length, ')')

  console.log('\n=== SUMMARY ===')
  console.log('OLD-USER TX-READY E2E: ✅ PASSED')
  console.log('EOA       :', eoa)
  console.log('MSCA      :', short(msca))
  console.log('token leg :', connectionToken.slice(0, 18) + '… rotated OK')
  console.log('tools     :', hermesHandshake.count)
  console.log('READY     : quote preview OK', executedInfo ? '| REAL TX ' + executedInfo.txHash : '')
  await browser.close()
  browser = null
  process.exit(0)
} catch (error) {
  console.log('❌ FATAL:', error?.message || error)
  try { await browser?.close() } catch {}
  process.exit(20)
}
