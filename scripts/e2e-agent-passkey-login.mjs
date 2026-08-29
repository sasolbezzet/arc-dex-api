// e2e-agent-passkey-login.mjs — E2E for the per-agent "Login Passkey" button.
//
// Regression: agents created via connection token / OAuth have NO passkey
// credential bound yet, so the per-agent Login Passkey button used to die with
// 403 agent_passkey_binding_required (chicken-and-egg). Fix: discoverable
// login when no credential is pre-bound + first-use credential binding.
//
// Also proves the full Hermes path end-to-end after that login:
//   bootstrap token → tools/list → tools/call arcox_wallet_balances →
//   quote → execute swap = REAL UserOp on Arc testnet.
//
// Usage: node --env-file=.env scripts/e2e-agent-passkey-login.mjs
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'
import { hexToBytes } from 'viem'
import { chromium } from '/home/ubuntu/arc-dex/node_modules/playwright-core/index.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'

const account = privateKeyToAccount(process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`)
const eoa = account.address
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const msca = String(state.walletAddress || '').toLowerCase()
if (!msca || !state.credentialId || !state.pkcs8) throw new Error('state file must have walletAddress + credentialId + pkcs8')

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)
const short = a => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`

let browser
const failExit = async (page, code, why) => {
  console.log('❌', why)
  try { console.log('body tail:', (await page.evaluate(() => document.body.innerText)).slice(-700)) } catch {}
  await browser?.close()
  process.exit(code)
}

// MCP helpers with Hermes-default headers (Accept: application/json only) and
// an SSE fallback parser — exactly what Hermes CLI sends.
const mcpPost = async (token, body, sid) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  let parsed
  try { parsed = JSON.parse(raw) } catch {
    const line = String(raw).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
    try { parsed = JSON.parse(line) } catch { parsed = { raw } }
  }
  return { status: res.status, sid: res.headers.get('mcp-session-id'), body: parsed }
}

try {
  // ── ① mint EOA web-login token + Chrome with seeded passkey ──
  step('①', 'mint EOA web-login token + launch Chrome (virtual passkey)…')
  const issuedAt = new Date().toISOString()
  const loginMessage = ['ARCOX DEX login', 'Only sign this message on the official ARCOX DEX website.', `Address: ${eoa}`, `Issued At: ${issuedAt}`, 'Network: Arc Testnet'].join('\n')
  const loginSignature = await account.signMessage({ message: loginMessage })
  const session = await (await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: eoa, issuedAt, signature: loginSignature }) })).json()
  if (!session.token) throw new Error(`auth/session failed: ${JSON.stringify(session).slice(0, 160)}`)

  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext()
  const page = await context.newPage()
  await context.addInitScript(({ addr, authToken }) => {
    // Wipe stale vault sessions only on the FIRST load; later navigations
    // (reload) must keep them — that is exactly what the mount-restore fix
    // relies on. Real browsers never wipe localStorage between reloads.
    if (localStorage.getItem('arx_e2e_boot') !== '1') {
      localStorage.removeItem('arx_vault_token')
      localStorage.removeItem('arx_passkey_vault_token')
      localStorage.setItem('arx_e2e_boot', '1')
    }
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

  // Background SIWE signer (safety net for any personal_sign the page queues).
  const stopSign = Date.now() + 420_000
  const signerLoop = (async () => {
    while (Date.now() < stopSign) {
      let items = []
      try { items = await page.evaluate(() => (window.__signQueue || []).splice(0, (window.__signQueue || []).length)) } catch {}
      for (const item of items) {
        try {
          const signature = await account.signMessage({ message: { raw: hexToBytes(item.messageHex) } })
          await page.evaluate(({ id, signature }) => window.__signResolvers?.[id]?.resolve(signature), { id: item.id, signature }).catch(() => {})
        } catch {
          await page.evaluate(({ id }) => window.__signResolvers?.[id]?.reject(new Error('automation sign failed')), { id: item.id }).catch(() => {})
        }
      }
      try { await page.waitForTimeout(700) } catch { break }
    }
  })()

  // ── ② owner login passkey ──
  step('②', 'open /plugin → owner Login Passkey ceremony…')
  await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(6000)
  await page.locator('button:has-text("Login Passkey"), button:has-text("Masuk Passkey")').first().click()
  const loginDeadline = Date.now() + 180_000
  let activated = false
  while (Date.now() < loginDeadline) {
    await page.waitForTimeout(3000)
    const st = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('arx_msca_state') || '{}') } catch { return {} } }).catch(() => ({}))
    if (st.walletAddress && st.walletAddress.toLowerCase() === msca && st.sessionActive) { activated = true; break }
  }
  if (!activated) await failExit(page, 3, 'owner passkey login never activated the saved Agent Wallet')
  ok(`owner Agent Wallet ${short(msca)} ACTIVE`)

  const vaultToken = await page.evaluate(() => localStorage.getItem('arx_vault_token') || '')
  if (!vaultToken.startsWith('arx_vault_') && vaultToken.length < 10) await failExit(page, 3, 'vault token missing after owner login')

  // ── ③ bootstrap a Hermes-style agent + connection token via API ──
  step('③', 'bootstrap connection-token agent (Hermes flow)…')
  const boot = await page.evaluate(async ({ vaultToken }) => {
    const res = await fetch('/api/vault/agents/bootstrap-connection-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vaultToken}` },
      body: JSON.stringify({ clientName: 'hermes-passkey-e2e', ttlDays: 30 }),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  }, { vaultToken })
  if (boot.status !== 200 || !boot.body?.token) await failExit(page, 4, `bootstrap failed: ${boot.status} ${JSON.stringify(boot.body).slice(0, 200)}`)
  const agentKey = String(boot.body.agentKey || '')
  const connToken = String(boot.body.token || '')
  ok(`agent "${boot.body.agentName}" (${short(agentKey)}) bound to wallet ${short(boot.body.walletAddress)}; token ${connToken.slice(0, 14)}…`)

  // ── ④ THE FIX: per-agent Login Passkey on an agent with NO pre-bound credential ──
  step('④', 'per-agent Login Passkey (agent has no pre-bound credential)…')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000)
  // Wait for the vault agents fetch to land; the row is a <button> holding the
  // agent name + wallet address. Note: ensureConnectionClient normalizes any
  // name containing "hermes" to "hermes-mcp", so match that label.
  const agentRow = page.locator('button', { hasText: 'hermes-mcp' }).first()
  try { await agentRow.waitFor({ state: 'visible', timeout: 30_000 }) } catch {
    // Diagnose: what does the API return with the stored token, and what does
    // the app actually have in state/localStorage right now?
    const diag = await page.evaluate(async () => {
      const tk = localStorage.getItem('arx_passkey_vault_token') || localStorage.getItem('arx_vault_token') || ''
      const call = async path => {
        try { const r = await fetch(path, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} }); return { status: r.status, body: (await r.text()).slice(0, 2200) } }
        catch (e) { return { status: 0, body: String(e) } }
      }
      const [agents, cards] = await Promise.all([call('/api/vault/agents'), call('/api/vault/cards')])
      let names = []
      try { names = (JSON.parse(agents.body)?.agents || []).map(a => a.clientName) } catch {}
      const rowTexts = Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').slice(0, 50)).filter(t => t.toLowerCase().includes('hermes') || t.toLowerCase().includes('e2e')).slice(0, 8)
      return { hasToken: Boolean(tk), agentsStatus: agents.status, cardsStatus: cards.status, names, rowTexts }
    }).catch(e => ({ error: String(e) }))
    console.log('   🔍 diag:', JSON.stringify(diag).slice(0, 900))
    await failExit(page, 5, 'agent row never appeared after reload (vault agents fetch?)')
  }
  await agentRow.click()
  await page.waitForTimeout(1500)
  const bodyBefore = await page.evaluate(() => document.body.innerText)
  if (bodyBefore.includes('agent_passkey_binding_required')) await failExit(page, 5, 'stale binding_required error already visible')
  const perAgentLogin = page.locator('button:has-text("Login Passkey")').last()
  if (await perAgentLogin.count() === 0) await failExit(page, 5, 'per-agent Login Passkey button not found in agent detail')
  await perAgentLogin.click()
  // Passkey ceremony runs; success = no error banner + agentAction cleared.
  let passkeyOk = false
  const fixDeadline = Date.now() + 180_000
  while (Date.now() < fixDeadline) {
    await page.waitForTimeout(2500)
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    if (/agent_passkey_(binding_required|not_bound|wallet_mismatch)/.test(text)) await failExit(page, 5, 'REGRESSION: agent passkey error banner appeared')
    const busy = await page.evaluate(() => document.querySelectorAll("button[style*='wait']").length).catch(() => 0)
    if (!busy) { passkeyOk = true; break }
  }
  if (!passkeyOk) await failExit(page, 5, 'per-agent Login Passkey never settled (still busy after timeout)')
  const vaultAfter = await page.evaluate(() => localStorage.getItem('arx_vault_token') || '')
  if (!vaultAfter) await failExit(page, 5, 'vault token missing after per-agent login')
  // MCP tools require an active Arc session key; make sure login left it on.
  let sessActive = false
  const sessDeadline = Date.now() + 90_000
  while (Date.now() < sessDeadline) {
    const st = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('arx_msca_state') || '{}') } catch { return {} } }).catch(() => ({}))
    if (st.walletAddress && String(st.walletAddress).toLowerCase() === msca && st.sessionActive) { sessActive = true; break }
    await page.waitForTimeout(2500)
  }
  if (!sessActive) await failExit(page, 5, 'session key inactive after per-agent login (autoActivateSession)')
  ok('per-agent Login Passkey SUCCEEDED — no agent_passkey_* error, session key ACTIVE')

  // ── ⑤ MCP: Hermes-style handshake → tools/call wallet balances ──
  step('⑤', 'MCP with connection token: initialize → tools/list → tools/call arcox_wallet_balances…')
  const init = await mcpPost(connToken, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes-passkey-e2e', version: '1.0' } } })
  if (init.status !== 200) await failExit(page, 6, `initialize → ${init.status}`)
  await mcpPost(connToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid)
  const tools = await mcpPost(connToken, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid)
  const toolCount = tools.body?.result?.tools?.length || 0
  if (toolCount < 10) await failExit(page, 6, `tools/list → only ${toolCount} tools`)
  ok(`${toolCount} tools listed`)
  const bal = await mcpPost(connToken, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'arcox_wallet_balances', arguments: {} } }, init.sid)
  const balText = bal.body?.result?.content?.[0]?.text || ''
  let balJson = {}
  try { balJson = JSON.parse(balText) } catch {}
  if (!balJson.walletAddress) await failExit(page, 6, `wallet_balances failed: HTTP ${bal.status} ${balText.slice(0, 220)}`)
  ok(`wallet_balances OK → wallet ${short(balJson.walletAddress)}, Arc USDC: ${balJson.chains?.['arc-testnet']?.USDC ?? balJson.USDC ?? 'n/a'}`)

  // ── ⑥ REAL TX via MCP: quote → execute swap on Arc testnet ──
  step('⑥', 'REAL TX: quote 0.01 USDC → EURC, then execute…')
  const quote = await mcpPost(connToken, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'arcox_quote_swap', arguments: { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.01', source: 'session' } } }, init.sid)
  const quoteJson = (() => { try { return JSON.parse(quote.body?.result?.content?.[0]?.text || '{}') } catch { return {} } })()
  if (!quoteJson.previewId) await failExit(page, 7, `quote failed: ${JSON.stringify(quoteJson).slice(0, 260)}`)
  ok(`quote OK previewId=${String(quoteJson.previewId).slice(0, 18)}… out=${quoteJson.amountOut ?? quoteJson.prepared?.amountOut ?? '?'}`)
  const exec = await mcpPost(connToken, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'arcox_execute_swap', arguments: { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.01', source: 'session', previewId: quoteJson.previewId, confirmed: true, confirmationText: 'yes' } } }, init.sid)
  const execJson = (() => { try { return JSON.parse(exec.body?.result?.content?.[0]?.text || '{}') } catch { return {} } })()
  if (execJson.status !== 'executed' && !execJson.executed) {
    await failExit(page, 7, `execute did not run: HTTP ${exec.status} ${JSON.stringify(execJson).slice(0, 300)}`)
  }
  const txHash = execJson.txHash || execJson.userOpHash || execJson.receipt?.transactionHash || ''
  ok(`REAL TX EXECUTED → ${String(txHash).slice(0, 26)}…`)

  await signerLoop
  console.log('\n=== SUMMARY ===')
  console.log('AGENT PASSKEY LOGIN E2E: ✅ PASSED')
  console.log('Per-agent Login Passkey : works without pre-bound credential (first-use binding)')
  console.log('MCP tools/call balances :', short(balJson.walletAddress), 'USDC', balJson.chains?.['arc-testnet']?.USDC ?? balJson.USDC ?? 'n/a')
  console.log('Real swap via MCP       :', String(txHash).slice(0, 30) + '…')

  // Cleanup: revoke the e2e agent so the owner list stays clean.
  try {
    const list = await (await fetch(`${BASE}/api/vault/agents`, { headers: { Authorization: `Bearer ${vaultAfter}` } })).json()
    const agents = Array.isArray(list) ? list : (list.agents || [])
    const mine = agents.find(a => a.agentKey === agentKey)
    if (mine) {
      const del = await fetch(`${BASE}/api/vault/agents/${encodeURIComponent(agentKey)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${vaultAfter}` } })
      if (del.ok) console.log('🧹 cleaned up e2e agent', short(agentKey))
    }
  } catch (e) { console.log('⚠️ cleanup skipped:', String(e?.message || e).slice(0, 120)) }

  await browser.close()
  browser = null
  process.exit(0)
} catch (error) {
  console.log('❌ FATAL:', error?.message || error)
  try { await browser?.close() } catch {}
  process.exit(20)
}
