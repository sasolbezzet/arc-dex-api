import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// x402 pay + intel tools moved to src/services/mcp/intelTools.mjs during the
// repo split; keep both locations in scope so the guards survive future moves.
const sourceFiles = [
  '../src/services/mcp/intelTools.mjs',
  '../src/services/mcpServer.mjs',
].map(rel => readFileSync(new URL(rel, import.meta.url), 'utf8'))
const source = sourceFiles.join('\n')

test('x402 session payment uses arc-pay fee profile (bundler floor guard)', () => {
  // executeX402Pay must route through the same circle-gas-station envelope as
  // ARCOX Pay; without it Arc bundler can reject the paymaster tip (0.48 gwei
  // floor bug) and every x402 invoice payment becomes non-deterministic.
  // `chainKey` now comes from the network registry (ARC_CHAIN_KEY); the guard
  // that matters here is the Gas Station envelope: paymaster + arc-pay +
  // mandatory transaction hash and receipt.
  const match = source.match(/functionName: 'transfer',\n\s+args: \[getAddress\(invoice\.recipient\), amountUnits\],\n\s+\}\], \{ paymaster: true, chainKey: ARC_CHAIN_KEY, feeProfile: 'arc-pay', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true \}\)/)
  assert.ok(match, 'executeX402Pay must pass feeProfile arc-pay + receipt requirements')
})

test('x402 pay tool requires explicit confirmation before execution', () => {
  const block = source.slice(source.indexOf("registerTool('arcox_x402_pay_invoice'"), source.indexOf("registerTool('arcox_x402_invoice_status'"))
  assert.match(block, /if \(String\(params\.confirmationText \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'yes' && String\(params\.confirmationText \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'ya'\)/)
  assert.match(block, /confirmed === true|params\.confirmed/)
})
