import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/services/mcpServer.mjs', import.meta.url), 'utf8')

const OWNER = '0x1111111111111111111111111111111111111111'
const GPT_MSCA = '0x2222222222222222222222222222222222222222'
const HERMES_MSCA = '0x3333333333333333333333333333333333333333'

test('bound MCP tokens use the explicit MSCA as the session lookup identity', async () => {
  const { resolveMcpSessionLookupId } = await import('../src/services/mcpServer.mjs?agent-context-' + Date.now() + '-' + Math.random())
  assert.equal(resolveMcpSessionLookupId(OWNER, HERMES_MSCA), HERMES_MSCA)
  assert.equal(resolveMcpSessionLookupId(OWNER, GPT_MSCA), GPT_MSCA)
  assert.equal(resolveMcpSessionLookupId(OWNER, ''), OWNER)
})

test('MCP value-moving paths do not pass the owner identity as the signer for bound agents', () => {
  assert.doesNotMatch(source, /executeViaSession\(userId, \[(?:approveCall|burnCall)/)
  assert.doesNotMatch(source, /sendViaSession\(userId, params\.to/)
  assert.doesNotMatch(source, /swapViaSession\(userId, \{/)
  assert.match(source, /executeViaSession\(info\.walletAddress, \[approveCall\]/)
  assert.match(source, /executeViaSession\(info\.walletAddress, \[burnCall\]/)
  assert.match(source, /sendViaSession\(activeSession\.walletAddress, params\.to/)
  assert.match(source, /swapViaSession\(activeSession\.walletAddress, \{/)
})

test('x402 invoice context mismatch is fail-closed for a sibling agent wallet', async () => {
  const { x402AgentWalletMismatch } = await import('../src/services/mcpServer.mjs?agent-x402-' + Date.now() + '-' + Math.random())
  const mismatch = x402AgentWalletMismatch(OWNER, { ownerWallet: GPT_MSCA }, HERMES_MSCA)
  assert.equal(mismatch?.status, 'rejected')
  assert.equal(mismatch?.executed, false)
  assert.equal(mismatch?.reason, 'agent_wallet_context_mismatch')
  assert.equal(mismatch?.payer, HERMES_MSCA.toLowerCase())
  assert.equal(mismatch?.invoiceOwner, GPT_MSCA)
  assert.equal(x402AgentWalletMismatch(OWNER, { ownerWallet: HERMES_MSCA }, HERMES_MSCA), null)
})
