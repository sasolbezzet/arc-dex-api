// e2e-realtx.mjs — REAL TX via MCP on the SAVED passkey session (no new agent).
// Reuses /tmp/arcox-e2e-prod-state.json: fresh vault token → bootstrap token
// bound to the SAME wallet → MCP session → balances → quote → execute swap.
import { readFileSync } from 'node:fs'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { base64UrlToBytes } from 'webauthn-p256'
import { makePasskeyGetFn } from './e2e-webauthn.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
const account = privateKeyToAccount(process.env.TEST_EOA_KEY || `0x${'11'.repeat(32)}`)
const eoa = account.address
const msca = String(state.walletAddress).toLowerCase()

const step = (n, msg) => console.log(`\n${n} ${msg}`)
const ok = msg => console.log('   ✅', msg)

async function freshVaultToken() {
  const optsRes = await fetch(`${BASE}/api/auth/passkey-options`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'Login' }),
  })
  const optsJson = await optsRes.json()
  const options = optsJson.options || {}
  const challenge = String(options.challenge || '')
  const rpId = state.rpId || options.rp?.id || options.rpId || 'arcoxdex.vercel.app'
  const privateKey = await webcrypto.subtle.importKey('pkcs8', Buffer.from(state.pkcs8, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const getFn = makePasskeyGetFn({ privateKey, credentialId: state.credentialId, rpId, userHandle: state.userHandle || '' })
  const assertion = await getFn({ publicKey: { challenge: base64UrlToBytes(challenge), rpId } })
  const toB64 = bytes => Buffer.from(bytes).toString('base64url')
  const credential = {
    id: state.credentialId, rawId: state.credentialId, type: 'public-key',
    response: {
      ...(state.userHandle ? { userHandle: state.userHandle } : {}),
      clientDataJSON: toB64(assertion.response.clientDataJSON),
      authenticatorData: toB64(assertion.response.authenticatorData),
      signature: toB64(assertion.response.signature),
    },
  }
  const verifyRes = await fetch(`${BASE}/api/auth/passkey-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential, mode: 'Login', flowId: optsJson.flowId }),
  })
  const verified = await verifyRes.json()
  if (!verified.token) throw new Error(`passkey login failed: ${verifyRes.status} ${JSON.stringify(verified).slice(0, 300)}`)
  return verified.token
}

try {
  step('①', 'fresh vault token via saved passkey…')
  const vaultToken = await freshVaultToken()
  ok(`vault token for ${msca.slice(0, 10)}…`)

  step('②', 'bootstrap connection token bound to the SAME wallet…')
  const boot = await (await fetch(`${BASE}/api/vault/agents/bootstrap-connection-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vaultToken}` },
    body: JSON.stringify({ clientName: 'hermes-realtx-e2e', ttlDays: 30 }),
  })).json()
  if (!boot.token) throw new Error(`bootstrap failed: ${JSON.stringify(boot).slice(0, 200)}`)
  ok(`agent ${boot.agentName} → wallet ${String(boot.walletAddress).slice(0, 10)}…`)

  let sessionId = ''
  let reqId = 1
  const mcpPost = async body => {
    const headers = { Authorization: `Bearer ${boot.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    const text = await res.text()
    try { return JSON.parse(text) } catch {
      const line = String(text).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n')
      try { return JSON.parse(line) } catch { return { raw: text } }
    }
  }
  const callTool = async (name, args) => {
    const res = await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'tools/call', params: { name, arguments: args } })
    const content = res?.result?.content || []
    const text = content.map(c => c.text || '').join('\n')
    try { return JSON.parse(text) } catch { return { raw: text, _res: res } }
  }

  step('③', 'MCP session…')
  await mcpPost({ jsonrpc: '2.0', id: reqId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'realtx-e2e', version: '1.0' } } })
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const status = await callTool('arcox_session_status', {})
  if (status.active !== true) throw new Error(`session_status: ${JSON.stringify(status).slice(0, 200)}`)
  ok(`session active, wallet ${String(status.walletAddress).slice(0, 10)}…`)

  const balances = await callTool('arcox_wallet_balances', {})
  const usdc = balances.chains?.['arc-testnet']?.USDC ?? balances.USDC
  ok(`Arc USDC balance: ${usdc}`)
  if (Number(usdc ?? 0) <= 0) {
    console.log('\n⚠️ Wallet has 0 USDC — fund it (Circle faucet / bridge) and re-run with RUN_TX=1.')
    process.exit(3)
  }

  step('④', 'quote swap 0.01 USDC → EURC…')
  const quote = await callTool('arcox_quote_swap', { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.01', source: 'session' })
  if (!quote.previewId) throw new Error(`quote failed: ${JSON.stringify(quote).slice(0, 260)}`)
  ok(`previewId ${String(quote.previewId).slice(0, 16)}… amountOut ${quote.amountOut}`)

  step('⑤', 'EXECUTE real swap…')
  const exec = await callTool('arcox_execute_swap', {
    tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.01', source: 'session',
    previewId: quote.previewId, confirmed: true, confirmationText: 'yes',
  })
  console.log('   result:', JSON.stringify(exec).slice(0, 400))
  if (!(exec.executed === true && exec.txHash)) throw new Error(`execute failed: ${JSON.stringify(exec).slice(0, 300)}`)
  ok(`REAL TX EXECUTED → ${exec.txHash}`)
  console.log('\n=== SUMMARY ===\nREAL-TX E2E: ✅ PASSED')
  process.exit(0)
} catch (e) {
  console.log('❌ FATAL:', e?.message || e)
  process.exit(20)
}
