// e2e-plugin-ui-flows.mjs — REAL browser UI test for the three Plugin flows.
//
// Drives the Plugin page in headless Chrome with a virtual EOA (injected
// EIP-1193 provider + host-side signer bridge) and a CDP virtual WebAuthn
// authenticator, then asserts on what the user actually sees and clicks:
//
//   FLOW 1 — Create New Wallet (Hermes → "Buat Agent Wallet")
//            the passkey prompt must carry the agent name + a unique number
//            ("Hermes Agent Wallet #01"), the wallet must end up active, and
//            the agent card must appear.
//   FLOW 2 — Revoke → Relogin
//            the card must show "Akses dicabut" and a "Relogin" button, and
//            relogin must finish with the passkey alone (no new SIWE).
//   FLOW 3 — Clear → Login Passkey
//            the card disappears, then Login Passkey re-binds it through the
//            owner-proof path (a fresh SIWE signature is expected there).
//   EXTRA  — Grok OAuth approval card proves the same naming rule for a
//            non-Hermes agent ("Grok Agent Wallet #01") — the original bug was
//            an agent-less/random passkey label on those agents.
//
// Chrome is driven over CDP directly (no browser automation dependency beyond
// the `ws` package arcox-e2e.mjs already uses).
//
// Usage:
//   rm -f /tmp/arcox-ui-flows.json
//   node scripts/e2e-plugin-ui-flows.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import WebSocket from 'ws'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const BASE = String(process.env.E2E_UI_BASE || 'https://arcoxdex.vercel.app').replace(/\/+$/, '')
const STATE_PATH = process.env.E2E_UI_STATE_PATH || '/tmp/arcox-ui-flows.json'
const RP_ID = process.env.E2E_RP_ID || 'arcoxdex.vercel.app'
const CHROME_BIN = process.env.E2E_CHROME || '/usr/bin/google-chrome'
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 19231)
// A unique profile per run: a leftover Chrome from an earlier run would keep
// the old localStorage (passkey counter, wallet tokens) and the CDP port.
const PROFILE_BASE = '/tmp/arcox-ui-flows-profile'
const PROFILE = process.env.E2E_PROFILE || `${PROFILE_BASE}-${Date.now()}`
const CREATE_LABEL = 'Buat Agent Wallet'
const LOGIN_LABEL = 'Login Passkey yang sudah ada'
const OAUTH_LOGIN_LABEL = 'Login Passkey'
const CARD_AGENT = 'hermes'
const OAUTH_CARD_AGENT = 'grok'
// FLOW 5 — a stale per-agent session token must not block card actions.
// Run a subset with E2E_UI_FLOWS=1,5 (Flow 5 needs the card Flow 1 creates).
const FLOWS = new Set(String(process.env.E2E_UI_FLOWS || '1,2,3,4,5').split(',').map(value => value.trim()).filter(Boolean))
const flowEnabled = (id, label) => {
  if (FLOWS.has(id)) return true
  console.log(`   ⏭️  ${label} skipped (E2E_UI_FLOWS=${[...FLOWS].join(',')})`)
  return false
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const short = a => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
const persist = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
// Each run uses a fresh virtual owner by default. Reusing the previous run's
// EOA would hit `agent_wallet_rotation_forbidden` on the next "Buat Agent
// Wallet": the agent is already bound to that owner's earlier wallet. Set
// E2E_UI_REUSE_EOA=1 (plus a state file) only when resuming an interrupted run.
const reuseEoa = process.env.E2E_UI_REUSE_EOA === '1'
const eoaKey = (reuseEoa && state.eoaKey) || `0x${Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex')}`
state.eoaKey = eoaKey
persist()
const account = privateKeyToAccount(eoaKey)
const eoa = getAddress(account.address)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   •', msg)

// Creating a Hermes wallet pops the connection-token dialog automatically. Its
// backdrop covers the agent card, and clicks are dispatched as real mouse
// events at the element centre, so an open modal silently swallows them.
const closeModals = async cdp => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const clicked = await cdp.eval(`(() => {
      const backdrop = document.querySelector('.plugin-modal-backdrop')
      if (!backdrop) return ''
      const button = Array.from(backdrop.querySelectorAll('button'))
        .find(node => /Kembali ke Plugin ARCOX|Tutup|Close|Batal|Cancel/i.test(node.textContent || ''))
      if (!button) return ''
      button.click()
      return button.textContent.trim()
    })()`).catch(() => '')
    if (!clicked) { await sleep(400); break }
    ok(`closed the open modal ("${clicked}")`)
    await sleep(800)
  }
}

// ── CDP client ──
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(port) {
    let targets
    for (let attempt = 0; attempt < 60; attempt++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break } catch { await sleep(500) }
    }
    if (!targets) throw new Error('CDP: chrome not reachable')
    const target = targets.find(entry => entry.type === 'page') || targets[0]
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const client = new CDP(ws)
    ws.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.id && client.pending.has(message.id)) {
        const { resolve, reject } = client.pending.get(message.id)
        client.pending.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : resolve(message.result)
      }
    })
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    return client
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error('eval: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text))
    return result.result?.value
  }
  async waitReady(timeout = 60_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try { if (await this.eval('document.readyState') === 'complete') return } catch { /* retry */ }
      await sleep(300)
    }
  }
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await this.waitReady()
    await this.eval(HELPERS)
  }
  async waitFor(expression, { timeout = 240_000, every = 1500, label = '' } = {}) {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression)
        if (last) return last
      } catch (error) { last = `error: ${error?.message}` }
      await sleep(every)
    }
    throw new Error(`waitFor timeout: ${label || expression} (last: ${typeof last === 'string' ? last : JSON.stringify(last)})`)
  }
  /** Click the first button whose label matches inside one of the finders. */
  async clickFound(finderJs, { timeout = 60_000, label = '', dom = false } = {}) {
    const deadline = Date.now() + timeout
    let seen = ''
    while (Date.now() < deadline) {
      if (dom) {
        // Deterministic path for card mini-buttons: the dashboard repaints
        // every 10s and neighbouring buttons sit a few pixels apart, so a
        // coordinate click can land on the wrong one (Clear hit Revoke).
        const clicked = await this.eval(`(() => {
          const el = (${finderJs})
          if (!el || el.disabled) return ''
          el.scrollIntoView({ block: 'center' })
          const text = (el.textContent || '').trim().slice(0, 40)
          el.click()
          return JSON.stringify({ text })
        })()`).catch(error => { seen = String(error?.message || error); return '' })
        if (clicked) {
          console.log('   • clicked:', JSON.parse(clicked).text)
          return true
        }
      } else {
      const payload = await this.eval(`(() => {
        const element = (${finderJs})
        if (!element) return ''
        element.scrollIntoView({ block: 'center' })
        const rect = element.getBoundingClientRect()
        const x = Math.round(rect.x + rect.width / 2)
        const y = Math.round(rect.y + rect.height / 2)
        const hit = document.elementFromPoint(x, y)
        const onTarget = Boolean(hit) && (hit === element || element.contains(hit) || hit.contains(element)) && element.disabled !== true
        // A modal backdrop means the click is meant to be impossible; retry
        // instead of clicking through it (that hid the token dialog bug).
        const blockedByModal = Boolean(hit && hit.closest && hit.closest('.plugin-modal-backdrop'))
        return JSON.stringify({ x, y, onTarget, blockedByModal })
      })()`).catch(error => { seen = String(error?.message || error); return '' })
      if (payload) {
        const { x, y, onTarget, blockedByModal } = JSON.parse(payload)
        if (onTarget) {
          await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
          await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
          return true
        }
        if (!blockedByModal) {
          // The dashboard re-renders every 10s: a measurement taken just before
          // a repaint can land on the neighbouring mini-button (Clear clicked
          // Revoke). Click the exact element we selected instead.
          const domClicked = await this.eval(`(() => { const el = (${finderJs}); if (!el) return ''; el.click(); return 'dom' })()`).catch(() => '')
          if (domClicked) return true
        }
      }
      }
      seen = (await this.bodyText().catch(() => '')).slice(-300)
      await sleep(700)
    }
    throw new Error(`click timeout: ${label || finderJs} (page tail: ${seen.replace(/\n+/g, ' | ')})`)
  }
  async bodyText() { return this.eval('document.body ? document.body.innerText : ""') }
}

/** In-page element finders, installed after every navigation. */
const HELPERS = `
window.__bodyButton = (text, selectors) => {
  for (const selector of selectors) {
    for (const scope of document.querySelectorAll(selector)) {
      const button = Array.from(scope.querySelectorAll('button')).find(node => (node.textContent || '').includes(text))
      if (button) return button
    }
  }
  return null
}
window.__providerButton = (agent, text) => {
  const scope = Array.from(document.querySelectorAll('.plugin-provider-card')).find(node => new RegExp(agent, 'i').test(node.innerText || ''))
  if (!scope) return null
  return Array.from(scope.querySelectorAll('button')).find(node => (node.textContent || '').includes(text)) || null
}
window.__cardButton = (agent, text) => {
  const card = Array.from(document.querySelectorAll('article.agent-card')).find(node => new RegExp(agent, 'i').test(node.innerText || ''))
  if (!card) return null
  return Array.from(card.querySelectorAll('button')).find(node => (node.textContent || '').includes(text)) || null
}
// Card buttons are disabled while any plugin action is running; clicking a
// disabled button silently does nothing, so wait for an idle card first.
window.__cardIdle = (agent) => {
  const card = Array.from(document.querySelectorAll('article.agent-card')).find(node => new RegExp(agent, 'i').test(node.innerText || ''))
  if (!card) return false
  return !Array.from(card.querySelectorAll('button')).some(node => node.disabled)
}
window.__card = (agent) => {
  const card = Array.from(document.querySelectorAll('article.agent-card')).find(node => new RegExp(agent, 'i').test(node.innerText || ''))
  if (!card) return ''
  const badge = card.querySelector('.agent-status')
  return JSON.stringify({
    badge: (badge ? badge.textContent : '').trim(),
    buttons: Array.from(card.querySelectorAll('button')).map(node => (node.textContent || '').trim()),
  })
}
true
`

const injectSource = `
(() => {
  const ADDR = ${JSON.stringify(eoa.toLowerCase())}
  try { localStorage.setItem('arc-dex-lang', 'id') } catch {}
  // Ceremony/API logs must survive the app's own navigations (an OAuth approval
  // ends with a redirect), so they live in localStorage instead of the window.
  const LOG_KEYS = {
    passkey: 'arx_e2e_passkey_log',
    sign: 'arx_e2e_sign_log',
    api: 'arx_e2e_api_log',
    unsupported: 'arx_e2e_unsupported_log',
  }
  const readLog = key => { try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] } }
  const pushLog = (key, entry) => {
    try { localStorage.setItem(key, JSON.stringify(readLog(key).concat([entry]).slice(-500))) } catch {}
  }
  window.__e2eLogs = { keys: LOG_KEYS, read: readLog, push: pushLog }
  if (localStorage.getItem('arx_e2e_ui_boot') !== '1') {
    for (const key of ['arx_vault_token', 'arx_passkey_vault_token', 'arx_owner_vault_token', 'arx_eoa_vault_token', ...Object.values(LOG_KEYS)].filter(Boolean)) {
      try { localStorage.removeItem(key) } catch {}
    }
    try { localStorage.setItem('arx_e2e_ui_boot', '1') } catch {}
  }
  // Trace every backend call so a failed flow can be diagnosed from the exact
  // request/response pair instead of only the banner text.
  if (!window.__apiTraceInstalled) {
    window.__apiTraceInstalled = true
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const method = (init && init.method) || (input && input.method) || 'GET'
      const response = await originalFetch(input, init)
      if (url.indexOf('/api/') !== -1) {
        let body = ''
        try { body = (await response.clone().text()).slice(0, 240) } catch {}
        // The request body proves whether a passkey login carried owner proof
        // (ownerAddress + ownerSessionToken) or was passkey-only.
        let reqBody = ''
        try { reqBody = typeof (init && init.body) === 'string' ? String(init.body).slice(0, 400) : '' } catch {}
        pushLog(LOG_KEYS.api, { method, url, status: response.status, body, reqBody, at: Date.now() })
      }
      return response
    }
  }
  const credentials = navigator.credentials
  for (const method of ['create', 'get']) {
    if (!credentials || credentials['__wrapped_' + method]) continue
    const original = credentials[method] ? credentials[method].bind(credentials) : null
    if (!original) continue
    try {
      Object.defineProperty(credentials, method, {
        configurable: true,
        value: async options => {
          let allow = null
          let picked = ''
          try {
            const publicKey = (options && options.publicKey) || {}
            const user = publicKey.user || {}
            const rp = publicKey.rp || {}
            // Login must be scoped with allowCredentials; without it WebAuthn
            // runs discoverable and can hand back another agent's passkey.
            const allowCredentials = publicKey.allowCredentials
            allow = Array.isArray(allowCredentials)
              ? allowCredentials.map(entry => String((entry && entry.id) || '').slice(0, 8))
              : null
            pushLog(LOG_KEYS.passkey, {
              method,
              userName: String(user.name || ''),
              displayName: String(user.displayName || ''),
              rpName: String(rp.name || ''),
              rpId: String(rp.id || ''),
              allow,
              at: Date.now(),
            })
          } catch {}
          const result = await original(options)
          try {
            const rawId = result && result.rawId ? (result.rawId.byteLength || result.rawId.length) : 0
            picked = rawId
              ? Array.from(new Uint8Array(result.rawId)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 8)
              : ''
            const entries = readLog(LOG_KEYS.passkey)
            if (entries.length > 0) {
              entries[entries.length - 1].returned = picked
              entries[entries.length - 1].allowed =
                allow === null ? 'discoverable' : allow.length === 0 ? 'empty' : allow.length
              try { localStorage.setItem(LOG_KEYS.passkey, JSON.stringify(entries.slice(-500))) } catch {}
            }
          } catch {}
          return result
        },
      })
      credentials['__wrapped_' + method] = true
    } catch {}
  }
  window.__signQueue = []
  window.__signResolvers = {}
  const provider = {
    isMetaMask: true,
    request: async ({ method, params }) => {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts': return [ADDR]
        case 'eth_chainId': return '0x4cef52'
        case 'net_version': return '5042002'
        case 'personal_sign':
        case 'eth_sign': {
          const message = params ? params[0] : ''
          const id = Math.random().toString(36).slice(2)
          pushLog(LOG_KEYS.sign, { id, method, at: Date.now(), preview: String(message).slice(0, 80) })
          return await new Promise((resolve, reject) => {
            window.__signQueue.push({ id, message })
            window.__signResolvers[id] = { resolve, reject }
          })
        }
        case 'wallet_getPermissions': return []
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
        case 'wallet_requestPermissions': return null
        default:
          pushLog(LOG_KEYS.unsupported, method)
          throw { code: 4001, message: 'rejected by automation: ' + method }
      }
    },
    on: () => {}, removeListener: () => {}, removeAllListeners: () => {},
  }
  Object.defineProperty(window, 'ethereum', { configurable: true, value: provider })
  try {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: 'e2e-ui', name: 'E2E Virtual Wallet', icon: 'data:image/svg+xml;base64,', rdns: 'io.arcox.e2e' }, provider },
    }))
  } catch {}
})()
`

let chrome
let cdp
let hostSigner
let stopped = false

async function cleanup() {
  stopped = true
  try { await hostSigner } catch { /* ignore */ }
  try { chrome?.kill('SIGKILL') } catch { /* ignore */ }
}

async function fail(why) {
  console.log('\n❌', why)
  try {
    console.log('   page tail :', (await cdp.bodyText()).slice(-900).replace(/\n+/g, ' | '))
    console.log('   banners   :', await cdp.eval('JSON.stringify(Array.from(document.querySelectorAll(".inline-error, .inline-notice")).map(node => node.innerText.slice(0, 200)))'))
    // Focus on writes: the dashboard polls vault reads every few seconds, which
    // would otherwise push the failing auth/session calls out of the window.
    const trace = await cdp.eval(`JSON.stringify(window.__e2eLogs.read('arx_e2e_api_log').filter(entry => entry.method !== 'GET').slice(-14).map(entry => ({ status: entry.status, method: entry.method, url: entry.url, req: String(entry.reqBody || '').slice(0, 260), body: String(entry.body || '').slice(0, 180) })))`)
    for (const entry of JSON.parse(trace || '[]')) console.log(`   api ${entry.status} ${entry.method} ${String(entry.url).replace(BASE, '')} ← ${entry.req} → ${entry.body}`)
    console.log('   passkeys  :', await cdp.eval(`JSON.stringify(window.__e2eLogs.read('arx_e2e_passkey_log').slice(-4))`))
    console.log('   last signs:', await cdp.eval(`JSON.stringify(window.__e2eLogs.read('arx_e2e_sign_log').slice(-3).map(entry => entry.preview))`))
    console.log('   unsupported provider methods:', await cdp.eval(`JSON.stringify(Array.from(new Set(window.__e2eLogs.read('arx_e2e_unsupported_log'))))`))
  } catch { /* diagnostics are best effort */ }
  await cleanup()
  process.exit(1)
}

// Logs survive navigations (localStorage-backed), so counts stay comparable
// across the OAuth approval redirect.
const readPasskeys = async () => JSON.parse(await cdp.eval(`JSON.stringify(window.__e2eLogs.read('arx_e2e_passkey_log'))`))
const readSignCount = async () => Number(await cdp.eval(`window.__e2eLogs.read('arx_e2e_sign_log').length`))
const readCard = async () => {
  const raw = await cdp.eval(`window.__card(${JSON.stringify(CARD_AGENT)})`)
  return raw ? JSON.parse(raw) : null
}
const cardBadgeWait = (accept) => `(() => {
  const raw = window.__card(${JSON.stringify(CARD_AGENT)})
  if (!raw) return ''
  const card = JSON.parse(raw)
  return card.badge && ${accept} ? raw : ''
})()`
const cardGoneWait = agent => `window.__card(${JSON.stringify(agent)}) === '' ? 'gone' : ''`
const waitCardIdle = agent => cdp.waitFor(
  `window.__cardIdle(${JSON.stringify(agent)}) ? 'idle' : ''`,
  { timeout: 180_000, every: 1000, label: `idle ${agent} card` },
)
const cardBadgeWaitFor = (agent, accept) => `(() => {
  const raw = window.__card(${JSON.stringify(agent)})
  if (!raw) return ''
  const card = JSON.parse(raw)
  return card.badge && ${accept} ? raw : ''
})()`

/**
 * Start the real MCP OAuth authorization the way Claude/ChatGPT/Grok do:
 * dynamic client registration (DCR) plus PKCE. The backend answers
 * /api/auth/authorize with a 302 to the Plugin approval page; the returned URL
 * is handed to the browser so the approval (and its passkey/SIWE ceremony)
 * happens in the real UI instead of being chased inside Node.
 */
const base64url = buffer => Buffer.from(buffer).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const startOAuthFlow = async clientName => {
  const redirectUri = `${BASE}/arc-dex/plugin`
  const registration = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  }).then(response => response.json()).catch(error => ({ error: error?.message }))
  if (!registration.client_id) throw new Error(`OAuth registration failed: ${JSON.stringify(registration)}`)
  const verifier = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const authorizeUrl = `${BASE}/api/auth/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    state: `e2e-${Date.now().toString(36)}`,
    code_challenge: base64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
  })
  const response = await fetch(authorizeUrl, { redirect: 'manual' })
  const location = response.headers.get('location')
  if (!location) throw new Error(`OAuth authorize did not redirect (status ${response.status})`)
  return { clientId: registration.client_id, pluginUrl: location.startsWith('http') ? location : `${BASE}${location}` }
}

try {
  spawnSync('pkill', ['-f', PROFILE_BASE], { stdio: 'ignore' })
  await sleep(1500)
  rmSync(PROFILE, { recursive: true, force: true })
  chrome = spawn(CHROME_BIN, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    '--window-size=1500,2400',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' })

  cdp = await CDP.connect(CDP_PORT)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource })
  // The in-page finders must exist on every document too: an OAuth approval
  // ends with a redirect the app performs itself, which navigate() never sees.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })
  await cdp.send('WebAuthn.enable')
  const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      rpId: RP_ID,
    },
  })
  ok(`virtual EOA ${eoa} · authenticator ${String(authenticator.authenticatorId).slice(0, 10)}… (rpId ${RP_ID})`)

  hostSigner = (async () => {
    while (!stopped) {
      try {
        const raw = await cdp.eval('window.__signQueue && window.__signQueue.length ? JSON.stringify(window.__signQueue.splice(0, window.__signQueue.length)) : ""')
        if (raw) {
          for (const item of JSON.parse(raw)) {
            try {
              const isHex = typeof item.message === 'string' && /^0x[0-9a-fA-F]+$/.test(item.message) && item.message.length % 2 === 0
              const signature = isHex
                ? await account.signMessage({ message: { raw: item.message } })
                : await account.signMessage({ message: String(item.message) })
              await cdp.eval(`if (window.__signResolvers[${JSON.stringify(item.id)}]) window.__signResolvers[${JSON.stringify(item.id)}].resolve(${JSON.stringify(signature)}); true`)
              console.log('   🔏 signed owner message:', String(item.message).slice(0, 46).replace(/\n/g, ' ') + '…')
            } catch (error) {
              await cdp.eval(`if (window.__signResolvers[${JSON.stringify(item.id)}]) window.__signResolvers[${JSON.stringify(item.id)}].reject(new Error('automation sign failed')); true`).catch(() => {})
              console.log('   ⚠️ sign failed:', error?.message)
            }
          }
        }
      } catch { /* page navigating */ }
      await sleep(500)
    }
  })()

  // ── FLOW 1 — Create New Wallet ──
  step('①', 'FLOW 1 — Create New Wallet (Hermes) in the browser…')
  await cdp.navigate(`${BASE}/plugin`)
  await cdp.waitFor(`Boolean(document.querySelector('.plugin-page'))`, { timeout: 90_000, label: 'plugin page' })
  await sleep(4000)
  const signsBefore1 = await readSignCount()
  await cdp.clickFound(
    `window.__bodyButton(${JSON.stringify(CREATE_LABEL)}, ['.plugin-session-banner']) || window.__providerButton('hermes', ${JSON.stringify(CREATE_LABEL)})`,
    { timeout: 90_000, label: `"${CREATE_LABEL}" button` },
  )
  ok('clicked "Buat Agent Wallet"; waiting for the passkey prompt and 3-chain activation…')

  const createEntry = await cdp.waitFor(`(() => {
    const creates = window.__e2eLogs.read('arx_e2e_passkey_log').filter(entry => entry.method === 'create')
    return creates.length ? JSON.stringify(creates[creates.length - 1]) : ''
  })()`, { timeout: 420_000, label: 'passkey create ceremony' }).then(raw => JSON.parse(raw))
  ok(`passkey prompt → user.name="${createEntry.userName}" rp.name="${createEntry.rpName}"`)

  const activeState = await cdp.waitFor(`(() => {
    const keys = Object.keys(localStorage).filter(key => key.indexOf('arx_msca_state') === 0)
    for (const key of keys) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || '{}')
        if (parsed.walletAddress && parsed.sessionActive) return JSON.stringify({ key, walletAddress: parsed.walletAddress })
      } catch {}
    }
    return ''
  })()`, { timeout: 600_000, every: 3000, label: 'active MSCA session (Arc + Base + Arbitrum)' }).then(raw => JSON.parse(raw))
  state.msca = activeState.walletAddress
  persist()
  ok(`wallet ${short(activeState.walletAddress)} ACTIVE (state key ${activeState.key})`)

  check('passkey prompt carries the agent name', /hermes/i.test(createEntry.userName) || /hermes/i.test(createEntry.rpName), `user.name="${createEntry.userName}" rp.name="${createEntry.rpName}"`)
  check('passkey prompt carries a unique wallet number', /#\d{2}/.test(createEntry.userName), `user.name="${createEntry.userName}"`)
  check('owner SIWE was requested for the new wallet', (await readSignCount()) > signsBefore1, `${(await readSignCount()) - signsBefore1} signature(s)`)

  // Fail fast with the backend's own message when the agent is already bound to
  // another wallet: waiting 4 minutes for a card that can never appear hides a
  // clear 403 behind a timeout.
  const rejected = await cdp.eval(`JSON.stringify((window.__e2eLogs.read('arx_e2e_api_log') || [])
    .filter(entry => /activate-binding/.test(entry.url) && Number(entry.status) === 403)
    .map(entry => String(entry.body || '')))`).then(raw => JSON.parse(raw || '[]'))
  if (rejected.length) {
    throw new Error(`activate-binding ditolak backend: ${rejected[rejected.length - 1].slice(0, 300)}`)
  }

  const card1 = await cdp.waitFor(`window.__card(${JSON.stringify(CARD_AGENT)})`, { timeout: 240_000, every: 2000, label: 'Hermes agent card' }).then(raw => JSON.parse(raw))
  check('Hermes agent card appears after creation', Boolean(card1), `badge="${card1.badge}"`)

  // ── FLOW 2 — Revoke → Relogin ──
  if (!flowEnabled('2', 'FLOW 2')) {
    // nothing to do — Flow 3/5 below still run against the created card
  } else {
  step('②', 'FLOW 2 — Revoke, then Relogin with the passkey only…')
  await closeModals(cdp)
  await waitCardIdle(CARD_AGENT)
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(CARD_AGENT)}, 'Cabut Akses')`, { timeout: 90_000, label: 'revoke button', dom: true })
  await cdp.waitFor(`(() => {
    const backdrop = document.querySelector('.plugin-modal-backdrop')
    return backdrop && /cabut akses/i.test(backdrop.innerText || '') ? 'open' : ''
  })()`, { timeout: 60_000, every: 700, label: 'revoke dialog' })
  await cdp.clickFound(`window.__bodyButton('Ya, cabut akses', ['.plugin-modal'])`, { timeout: 60_000, label: 'revoke confirmation', dom: true })

  const revoked = await cdp.waitFor(cardBadgeWait(`card.badge === 'Akses dicabut'`), { timeout: 180_000, every: 2000, label: 'revoked badge' }).then(raw => JSON.parse(raw))
  check('revoked card shows the state label "Akses dicabut"', revoked.badge === 'Akses dicabut', `badge="${revoked.badge}"`)
  check('revoked card offers "Relogin"', revoked.buttons.some(label => /Relogin/i.test(label)), revoked.buttons.join(' | '))

  await closeModals(cdp)
  await waitCardIdle(CARD_AGENT)
  const signsBefore2 = await readSignCount()
  const passkeysBefore2 = (await readPasskeys()).length
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(CARD_AGENT)}, 'Relogin')`, { timeout: 90_000, label: 'relogin button', dom: true })
  const recovered = await cdp.waitFor(cardBadgeWait(`card.badge !== 'Akses dicabut'`), { timeout: 480_000, every: 3000, label: 'active card after relogin' }).then(raw => JSON.parse(raw))
  check('relogin uses the passkey', (await readPasskeys()).length > passkeysBefore2, `${(await readPasskeys()).length - passkeysBefore2} ceremony(s)`)
  check('relogin needs no new owner SIWE', (await readSignCount()) === signsBefore2, `${(await readSignCount()) - signsBefore2} signature(s)`)
  check('card is active again after relogin', recovered.badge !== 'Akses dicabut', `badge="${recovered.badge}"`)
  }

  // ── FLOW 3 — Clear → Login Passkey ──
  if (!flowEnabled('3', 'FLOW 3')) {
    // nothing to do — Flow 5 below still runs against the created card
  } else {
  step('③', 'FLOW 3 — Clear the agent, then Login Passkey (owner proof path)…')
  await closeModals(cdp)
  const signsBefore3 = await readSignCount()
  const passkeysBefore3 = (await readPasskeys()).length
  await waitCardIdle(CARD_AGENT)
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(CARD_AGENT)}, 'Hapus')`, { timeout: 90_000, label: 'clear button', dom: true })
  await cdp.waitFor(`window.__card(${JSON.stringify(CARD_AGENT)}) === '' ? 'gone' : ''`, { timeout: 180_000, every: 2000, label: 'card removal after clear' })
  check('clear removes the agent card', true, 'card gone from the dashboard')

  await closeModals(cdp)
  await cdp.clickFound(
    `window.__bodyButton(${JSON.stringify(LOGIN_LABEL)}, ['.plugin-session-banner']) || window.__providerButton('hermes', ${JSON.stringify(LOGIN_LABEL)})`,
    { timeout: 90_000, label: `"${LOGIN_LABEL}" button`, dom: true },
  )
  const rebound = await cdp.waitFor(cardBadgeWait(`card.badge !== 'Akses dicabut'`), { timeout: 600_000, every: 3000, label: 'card rebound after clear + login passkey' }).then(raw => JSON.parse(raw))
  check('relogin after clear re-binds the agent card', true, `badge="${rebound.badge}"`)
  check('relogin after clear uses the passkey', (await readPasskeys()).length > passkeysBefore3, `${(await readPasskeys()).length - passkeysBefore3} ceremony(s)`)
  // After Clear the durable binding is gone, so the login must carry owner
  // proof. A still-valid 24h owner session is a legitimate proof, so a fresh
  // SIWE signature is not required — the sent token/address is what matters.
  const ownerProofSent = await cdp.eval(`JSON.stringify(window.__e2eLogs.read('arx_e2e_api_log')
    .filter(entry => /\\/api\\/session\\/(generate-key|activate-binding)/.test(entry.url) && String(entry.reqBody || '').includes('ownerSessionToken'))
    .map(entry => entry.url))`).then(raw => JSON.parse(raw || '[]'))
  check('relogin after clear sends the owner proof', ownerProofSent.length > 0, `calls=${ownerProofSent.length} signature(s)=${(await readSignCount()) - signsBefore3}`)
  }

  // ── FLOW 4 — OAuth agent (Grok): create → revoke/relogin → clear/login ──
  if (!flowEnabled('4', 'FLOW 4')) {
    // nothing to do — Flow 5 below still runs against the created card
  } else {
  step('④', 'FLOW 4 — Grok via real OAuth: create a wallet on the approval card…')
  const grokOauth = await startOAuthFlow('Grok')
  await cdp.navigate(grokOauth.pluginUrl)
  await cdp.waitFor(`Boolean(document.querySelector('.plugin-oauth'))`, { timeout: 90_000, label: 'OAuth approval card' })
  await sleep(2500)
  const createsBefore4 = (await readPasskeys()).filter(entry => entry.method === 'create').length
  await cdp.clickFound(`window.__bodyButton(${JSON.stringify(CREATE_LABEL)}, ['.plugin-oauth'])`, { timeout: 90_000, label: 'OAuth create wallet button', dom: true })
  const grokEntry = await cdp.waitFor(`(() => {
    const creates = window.__e2eLogs.read('arx_e2e_passkey_log').filter(entry => entry.method === 'create')
    const last = creates[creates.length - 1]
    if (!last || creates.length <= ${createsBefore4}) return ''
    return /grok/i.test((last.userName || '') + (last.rpName || '')) ? JSON.stringify(last) : ''
  })()`, { timeout: 420_000, every: 2000, label: 'Grok passkey create ceremony' }).then(raw => JSON.parse(raw))
  check('Grok passkey prompt carries the agent name', /grok/i.test(grokEntry.userName), `user.name="${grokEntry.userName}"`)
  check('Grok passkey prompt carries a unique wallet number', /#\d{2}/.test(grokEntry.userName), `user.name="${grokEntry.userName}" rp.name="${grokEntry.rpName}"`)

  // The approval finishes by redirecting to the callback, so wait for the
  // approval URL to be gone and then reopen the dashboard.
  await cdp.waitFor(`location.href.indexOf('auth=mcp') === -1 ? 'redirected' : ''`, { timeout: 420_000, every: 3000, label: 'OAuth approval redirect' })
  await cdp.navigate(`${BASE}/plugin`)
  await cdp.waitFor(`Boolean(document.querySelector('.plugin-page'))`, { timeout: 90_000, label: 'plugin page after approval' })
  await sleep(3000)
  const grokCard = await cdp.waitFor(`window.__card(${JSON.stringify(OAUTH_CARD_AGENT)})`, { timeout: 240_000, every: 2000, label: 'Grok agent card' }).then(raw => JSON.parse(raw))
  check('Grok agent card appears after a real OAuth approval', Boolean(grokCard), `badge="${grokCard?.badge}"`)

  // Revoke → Relogin (passkey only) on the OAuth agent card.
  await closeModals(cdp)
  await waitCardIdle(OAUTH_CARD_AGENT)
  const grokSignsBefore = await readSignCount()
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(OAUTH_CARD_AGENT)}, 'Cabut Akses')`, { timeout: 90_000, label: 'Grok revoke button', dom: true })
  await cdp.waitFor(`(() => {
    const backdrop = document.querySelector('.plugin-modal-backdrop')
    return backdrop && /cabut akses/i.test(backdrop.innerText || '') ? 'open' : ''
  })()`, { timeout: 60_000, every: 700, label: 'Grok revoke dialog' })
  await cdp.clickFound(`window.__bodyButton('Ya, cabut akses', ['.plugin-modal'])`, { timeout: 60_000, label: 'Grok revoke confirmation', dom: true })
  const grokRevoked = await cdp.waitFor(cardBadgeWaitFor(OAUTH_CARD_AGENT, `card.badge === 'Akses dicabut'`), { timeout: 180_000, every: 2000, label: 'Grok revoked badge' }).then(raw => JSON.parse(raw))
  check('Grok card shows "Akses dicabut" after revoke', grokRevoked.badge === 'Akses dicabut', `badge="${grokRevoked.badge}"`)
  await closeModals(cdp)
  await waitCardIdle(OAUTH_CARD_AGENT)
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(OAUTH_CARD_AGENT)}, 'Relogin')`, { timeout: 90_000, label: 'Grok relogin button', dom: true })
  const grokRecovered = await cdp.waitFor(cardBadgeWaitFor(OAUTH_CARD_AGENT, `card.badge !== 'Akses dicabut'`), { timeout: 480_000, every: 3000, label: 'Grok card active after relogin' }).then(raw => JSON.parse(raw))
  check('Grok relogin needs no new owner SIWE', (await readSignCount()) === grokSignsBefore, `${(await readSignCount()) - grokSignsBefore} signature(s)`)
  check('Grok card is active again after relogin', grokRecovered.badge !== 'Akses dicabut', `badge="${grokRecovered.badge}"`)

  // Clear from the dashboard, then re-bind through a brand-new OAuth request.
  await closeModals(cdp)
  await waitCardIdle(OAUTH_CARD_AGENT)
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(OAUTH_CARD_AGENT)}, 'Hapus')`, { timeout: 90_000, label: 'Grok clear button', dom: true })
  await cdp.waitFor(cardGoneWait(OAUTH_CARD_AGENT), { timeout: 180_000, every: 2000, label: 'Grok card removal after clear' })
  check('Grok clear removes the agent card', true, 'card gone from the dashboard')

  const grokOauth2 = await startOAuthFlow('Grok')
  await cdp.navigate(grokOauth2.pluginUrl)
  await cdp.waitFor(`Boolean(document.querySelector('.plugin-oauth'))`, { timeout: 90_000, label: 'second OAuth approval card' })
  await sleep(2000)
  await cdp.clickFound(`window.__bodyButton(${JSON.stringify(OAUTH_LOGIN_LABEL)}, ['.plugin-oauth'])`, { timeout: 90_000, label: 'OAuth login passkey button', dom: true })
  const grokRebound = await cdp.waitFor(cardBadgeWaitFor(OAUTH_CARD_AGENT, `card.badge !== 'Akses dicabut'`), { timeout: 600_000, every: 3000, label: 'Grok card rebound after clear + login passkey' }).then(raw => JSON.parse(raw))
  check('Grok relogin after clear re-binds the agent card', grokRebound.badge !== 'Akses dicabut', `badge="${grokRebound.badge}"`)
  }

  // ── FLOW 5 — stale per-agent session token ──
  // Production evidence behind this: a card action kept sending the agent own
  // 24h-old `arx_oauth_vault_token:<clientId>` slot, the backend answered 401,
  // and Revoke/Clear reported "Sesi berakhir. Masuk kembali dengan passkey."
  // even though the same page had a healthy session for `/api/vault/agents`.
  if (!flowEnabled('5', 'FLOW 5')) {
    // nothing to do
  } else {
  step('⑤', 'FLOW 5 — a stale per-agent token must not block Revoke/Clear…')
  // The dashboard reads readiness/activity on `/api/vault/agents/<agentKey>/…`,
  // so the request log is the authoritative source for the EXACT key a card
  // action will use. The Hermes card of this run is the connection-token agent
  // (`arcox_conn_*`) owned by this run's freshly generated EOA — OAuth cards use
  // an `arcox_<uuid>` client id instead.
  const hermesAgentKey = await cdp.eval(`(() => {
    const marker = '/api/vault/agents/'
    const owner = ${JSON.stringify(eoa.toLowerCase())}
    const keys = window.__e2eLogs.read('arx_e2e_api_log')
      .map(entry => String(entry.url || ''))
      .filter(url => url.indexOf(marker) !== -1)
      .map(url => decodeURIComponent(url.split(marker)[1].split('/')[0]))
    const unique = [...new Set(keys)]
    const connectionAgent = unique.find(key => /^arcox_conn_/i.test(key) && key.toLowerCase().indexOf(owner) !== -1)
    return connectionAgent || unique.find(key => /^arcox_conn_/i.test(key)) || ''
  })()`).then(value => String(value || ''))
  const hermesClientId = hermesAgentKey.split('|')[0]
  // Seed every slot the dashboard may prefer for this agent: the exact
  // composite key plus its clientId-only form.
  const staleSlots = [...new Set([hermesClientId, hermesAgentKey].filter(Boolean))]
    .map(clientId => `arx_oauth_vault_token:${clientId}`)
  check('Flow 5 can address the Hermes per-agent token slot', staleSlots.length > 0,
    `agentKey=${hermesAgentKey || '(unknown)'} slots=${staleSlots.join(', ') || '(none)'}`)

  const seedStaleToken = async () => cdp.eval(`(() => {
    for (const slot of ${JSON.stringify(staleSlots)}) localStorage.setItem(slot, 'arx_vs_deadbeefdeadbeefdeadbeefdeadbeef')
    return ${JSON.stringify(staleSlots)}.filter(slot => localStorage.getItem(slot)).join(',')
  })()`).then(value => String(value || ''))

  await closeModals(cdp)
  await seedStaleToken()
  // Reload so the dashboard boots in exactly the state a returning user has:
  // a healthy global session plus an expired per-agent slot.
  await cdp.navigate(`${BASE}/plugin`)
  await cdp.waitFor(`Boolean(document.querySelector('.plugin-page'))`, { timeout: 90_000, label: 'plugin page after stale token' })
  await cdp.waitFor(`window.__card(${JSON.stringify(CARD_AGENT)}) !== '' ? 'card' : ''`, { timeout: 120_000, every: 2000, label: 'Hermes card with stale token' })
  await sleep(3000)

  await waitCardIdle(CARD_AGENT)
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(CARD_AGENT)}, 'Cabut Akses')`, { timeout: 90_000, label: 'revoke button with stale token', dom: true })
  await cdp.waitFor(`(() => {
    const backdrop = document.querySelector('.plugin-modal-backdrop')
    return backdrop && /cabut akses/i.test(backdrop.innerText || '') ? 'open' : ''
  })()`, { timeout: 60_000, every: 700, label: 'revoke dialog with stale token' })
  await cdp.clickFound(`window.__bodyButton('Ya, cabut akses', ['.plugin-modal'])`, { timeout: 60_000, label: 'revoke confirmation with stale token', dom: true })

  let revokeSurvived = true
  const staleRevoked = await cdp.waitFor(cardBadgeWait(`card.badge === 'Akses dicabut'`), { timeout: 120_000, every: 2000, label: 'revoked badge with stale token' })
    .then(raw => JSON.parse(raw))
    .catch(() => { revokeSurvived = false; return null })
  const staleRetired = await cdp.eval(`(() => {
    const left = ${JSON.stringify(staleSlots)}.filter(slot => localStorage.getItem(slot) !== null)
    return left.length ? 'still-there: ' + left.join(',') : 'retired'
  })()`).then(value => String(value || ''))
  const bannerAfterStale = await cdp.eval(`(() => {
    const node = document.querySelector('.plugin-alert.inline-error')
    return node ? String(node.innerText || '').trim() : ''
  })()`).then(value => String(value || ''))
  check('a stale per-agent token does not abort Revoke', revokeSurvived && staleRevoked?.badge === 'Akses dicabut',
    `badge="${staleRevoked?.badge || '(unchanged)'}"`)
  check('no "Sesi berakhir" after the card action', !/Sesi berakhir/i.test(bannerAfterStale), `banner="${bannerAfterStale.slice(0, 80)}"`)
  check('the rejected per-agent token is retired from localStorage', staleRetired === 'retired', staleRetired)

  // Clear must survive the same stale slot: seed it again and delete the card.
  await closeModals(cdp)
  await seedStaleToken()
  await waitCardIdle(CARD_AGENT)
  await cdp.clickFound(`window.__cardButton(${JSON.stringify(CARD_AGENT)}, 'Hapus')`, { timeout: 90_000, label: 'clear button with stale token', dom: true })
  const clearSurvived = await cdp.waitFor(cardGoneWait(CARD_AGENT), { timeout: 180_000, every: 2000, label: 'card removal with stale token' })
    .then(() => true).catch(() => false)
  check('a stale per-agent token does not abort Clear', clearSurvived, clearSurvived ? 'card gone from the dashboard' : 'card still present')
  }

  const failed = results.filter(entry => !entry.ok)
  console.log(`\n${failed.length === 0 ? '✅ ALL UI CHECKS PASSED' : `❌ ${failed.length}/${results.length} UI CHECKS FAILED`}`)
  console.log('   owner (EOA) :', eoa)
  console.log('   wallet      :', state.msca ? short(state.msca) : '(none)')
  console.log('   state file  :', STATE_PATH)
  await cleanup()
  if (failed.length > 0) {
    for (const entry of failed) console.log('   ✗', entry.name)
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  await fail(error?.message || String(error))
}
