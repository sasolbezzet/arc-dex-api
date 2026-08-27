// Production Chrome E2E for the supported Hermes flow:
// Plugin → Agent Terhubung → Buat Token Koneksi → MCP header → initialize/tools.
import { readFileSync } from 'node:fs'
import { chromium } from '/tmp/browser-test/node_modules/playwright-core/index.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const vaultToken = state.sessionToken || state.token || process.env.E2E_VAULT_TOKEN || ''
if (!vaultToken) throw new Error('state file must contain sessionToken/token or set E2E_VAULT_TOKEN')

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)

step('①', 'launch real Chrome and open production Plugin…')
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext()
const page = await context.newPage()
await context.addInitScript(({ token }) => {
  localStorage.setItem('arx_vault_token', token)
  localStorage.setItem('arx_passkey_vault_token', token)
}, { token: vaultToken })
const consoleErrors = []
const pageErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => pageErrors.push(String(error)))
await page.goto(`${BASE}/plugin`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const initialText = await page.locator('body').innerText()
if (!/Agent Terhubung|Connected Agents/i.test(initialText)) throw new Error(`Agent Terhubung section is missing; page text: ${initialText.slice(0, 500)}`)
if (/hermes mcp login arcox/i.test(initialText)) throw new Error('obsolete hermes mcp login instruction is visible')
if (/Auth URL|Token URL|Dynamic Client Registration|OAuth.*DCR/i.test(initialText)) throw new Error('obsolete OAuth instructions are visible')
ok('Plugin loaded without obsolete Hermes OAuth instructions')

step('②', 'inspect Agent Terhubung cards and select one agent…')
const agentRows = page.locator('button').filter({ hasText: /hermes|agent|mcp/i })
if (await agentRows.count() === 0) throw new Error('no agent card rendered; use a seeded owner session with an agent binding')
const agentRow = agentRows.first()
await agentRow.click()
await page.waitForTimeout(1000)
const expandedText = await page.locator('body').innerText()
if (!/Buat Token Koneksi|Create Connection Token/i.test(expandedText)) throw new Error('selected agent does not show connection-token control')
if (!/Login Passkey/i.test(expandedText)) throw new Error('selected agent does not show Login Passkey control')
if (!/Cabut akses|Revoke/i.test(expandedText)) throw new Error('selected agent does not show revoke control')
ok('agent card expanded with token, Login Passkey, and revoke controls')

step('③', 'create a connection token from the selected agent…')
const createButton = page.locator('button:has-text("Buat Token Koneksi"), button:has-text("Create Connection Token")').first()
await createButton.click()
await page.waitForTimeout(1000)
const tokenElement = page.locator('code').filter({ hasText: /^arx_at_/ }).first()
const connectionToken = (await tokenElement.textContent() || '').trim()
if (!connectionToken.startsWith('arx_at_')) throw new Error('connection token was not displayed')
const setupMessage = await page.locator('textarea').first().inputValue()
if (!setupMessage.includes(`${BASE}/mcp`)) throw new Error('setup message does not contain MCP URL')
if (!setupMessage.includes(connectionToken)) throw new Error('setup message does not contain the displayed token')
if (!/Token akses Hermes|Hermes/i.test(setupMessage)) throw new Error('setup message does not identify Hermes access token')
ok('one-time Hermes connection token and setup message rendered')

step('④', 'use the copied token as Hermes header credential against MCP…')
const mcp = await page.evaluate(async ({ base, token }) => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hermes-header-e2e', version: '1' } } }),
  })
  return { status: response.status, body: await response.text() }
}, { base: BASE, token: connectionToken })
if (mcp.status !== 200) throw new Error(`MCP initialize failed: ${mcp.status} ${mcp.body.slice(0, 300)}`)
ok('Hermes-style Authorization: Bearer token → MCP initialize 200')

step('⑤', 'request tools/list with the same scoped token…')
const tools = await page.evaluate(async ({ base, token }) => {
  const init = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  return { status: init.status, body: await init.text() }
}, { base: BASE, token: connectionToken })
if (tools.status !== 200) throw new Error(`tools/list failed: ${tools.status} ${tools.body.slice(0, 300)}`)
const toolCount = (tools.body.match(/arcox_/g) || []).length
ok(`tools/list → HTTP 200${toolCount ? `, ${toolCount} ARCOX references` : ''}`)

step('⑥', 'verify final UX and browser errors…')
const finalText = await page.locator('body').innerText()
if (/hermes mcp login arcox|Dynamic Client Registration|Auth URL|Token URL/i.test(finalText)) throw new Error('obsolete OAuth flow still appears in final UX')
if (consoleErrors.length || pageErrors.length) throw new Error(`browser errors: ${JSON.stringify({ consoleErrors, pageErrors })}`)
ok('no browser console/page errors')

console.log('\n=== SUMMARY ===')
console.log('Chrome production connection-token E2E: ✅ PASSED')
console.log('Flow: Agent Terhubung → Buat Token Koneksi → Hermes Bearer header → MCP initialize/tools/list')
console.log('MCP URL:', `${BASE}/mcp`)
await browser.close()
