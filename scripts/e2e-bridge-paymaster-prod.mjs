// e2e-bridge-paymaster-prod.mjs — REAL Base→Arc bridge E2E on production data.
//
// Runs on the VPS inside /home/ubuntu/arc-dex-api (same code + data as the
// live systemd service). Uses the ACTIVE production session key of
// 0xdc0240df…1769 (the user's Agent Wallet, authorized on all 3 chains) and
// executes the exact MCP bridge handler (arcox_execute_bridge) that Claude
// calls, with the new Circle Gas Station paymaster profile for inbound
// Base→Arc bridges. Then it polls:
//   - bridge status (attestation readiness)
//   - /api/auto-mint/status for the registered auto-mint job
//   - destination mint via the MCP bridge-status handler
//
// This sends REAL testnet UserOperations (testnet USDC, no mainnet value).
//
// Usage: node --env-file=.env scripts/e2e-bridge-paymaster-prod.mjs [base|arbitrum] [amount]
import { readFileSync, writeFileSync } from 'node:fs'

const ROUTE_FROM = (process.argv[2] || 'base').toLowerCase() // 'base' | 'arbitrum'
const AMOUNT = process.argv[3] || '0.05'

const { createMcpServer } = await import('../src/services/mcpServer.mjs')
const { getSessionKey } = await import('../src/services/sessionKeyService.mjs')

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769'
const BASE_URL = process.env.SERVER_URL || 'https://arcoxdex.vercel.app'
const OWNER_ALIAS = '0x19d0730c4a4b1c509eba5d59b6dc0d46bd3ac807' // EOA alias → WALLET in production store

// ── Preflight: the active session must exist in the production store ──
const entry = getSessionKey(WALLET, { sweep: false })
if (!entry || entry.active !== true) {
  console.error('❌ session not active for', WALLET, '->', JSON.stringify(entry && { active: entry.active, reason: entry.statusReason }))
  process.exit(2)
}
console.log('✅ active session:', WALLET)
console.log('   delegate:', entry.delegateAddress)
console.log('   authorized chains:', Object.keys(entry.authorizationUserOpHashes || {}))

const fromKey = ROUTE_FROM === 'arbitrum' ? 'Arbitrum_Sepolia' : 'Base_Sepolia'
const toKey = 'Arc_Testnet'
const route = { fromKey, toKey }

// The MCP handler needs a userId that resolves to this wallet. The store has
// an alias for the EOA owner 0x19d0730c… → this MSCA, so we use that alias.
const server = createMcpServer(OWNER_ALIAS, {})

// ── 1. Quote (preview) ──
console.log(`\n① quote ${fromKey} → ${toKey} amount=${AMOUNT} USDC…`)
const quote = await server._registeredTools.arcox_quote_bridge.handler({
  fromChain: fromKey,
  toChain: toKey,
  amount: AMOUNT,
  token: 'USDC',
  source: 'session',
})
const quoteText = JSON.parse(quote.content[0].text)
console.log('   quote:', JSON.stringify(quoteText, null, 1).slice(0, 900))
if (!quoteText.preview || quoteText.rejected) {
  console.error('❌ quote rejected:', JSON.stringify(quoteText))
  process.exit(3)
}
const previewId = quoteText.previewId

// ── 2. Execute bridge (approve → burn) via session + paymaster ──
console.log(`\n② execute bridge (approve → router burn, paymaster)…`)
const exec = await server._registeredTools.arcox_execute_bridge.handler({
  fromChain: fromKey,
  toChain: toKey,
  amount: AMOUNT,
  token: 'USDC',
  source: 'session',
  previewId,
  confirmed: true,
  confirmationText: 'ya',
})
const execText = JSON.parse(exec.content[0].text)
console.log('   result:', JSON.stringify(execText, null, 1).slice(0, 1200))

if (execText.status === 'session_failed' || execText.status === 'bridge_error' || execText.executed === false && !['settlement_pending', 'burn_submitted'].includes(execText.status)) {
  console.error('❌ bridge execute failed')
  process.exit(4)
}
const burnTx = execText.burnTxHash || execText.txHash
console.log('   burnTx:', burnTx || '(pending)')

// ── 3. Poll bridge status until attestation ready / mint ──
console.log(`\n③ polling bridge status (attestation → mint)…`)
const deadline = Date.now() + 5 * 60 * 1000
let last = ''
while (Date.now() < deadline) {
  const st = await server._registeredTools.arcox_bridge_status.handler({
    fromChain: fromKey,
    toChain: toKey,
    burnTxHash: burnTx || execText.userOpHash || '',
  })
  const stText = JSON.parse(st.content[0].text)
  const key = JSON.stringify({ status: stText.status, verified: stText.verified, autoMintQueued: stText.autoMintQueued, mint: stText.mint?.success, destinationUserOpHash: stText.destinationUserOpHash })
  if (key !== last) { last = key; console.log('   ', new Date().toISOString().slice(11, 19), JSON.stringify(stText).slice(0, 700)) }
  if (stText.status === 'minted' || stText.mint?.success) { console.log('   ✅ destination minted'); break }
  if (stText.status === 'rejected') { console.error('   ❌ bridge rejected:', stText.reason); process.exit(5) }
  await new Promise(r => setTimeout(r, 5000))
}

// ── 4. Auto-mint job monitoring ──
console.log('\n④ auto-mint jobs on production:')
const jobs = JSON.parse(readFileSync('./auto-mint-jobs.json', 'utf8'))
for (const [jobId, job] of Object.entries(jobs)) {
  console.log(`   ${jobId.slice(0, 18)}… ${job.fromChain}→${job.toChain} status=${job.status} owner=${String(job.owner).slice(0, 10)}… readyAt=${job.readyAt ? new Date(job.readyAt).toISOString() : '-'}`)
}
if (burnTx) writeFileSync('/tmp/arcox-e2e-bridge-last.json', JSON.stringify({ fromChain: fromKey, toChain: toKey, burnTx, at: new Date().toISOString() }, null, 2))
console.log('\nDone. burn:', burnTx, '| route:', fromKey, '→', toKey)
