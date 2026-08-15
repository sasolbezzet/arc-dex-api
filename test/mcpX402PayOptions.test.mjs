import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/services/mcpServer.mjs', import.meta.url), 'utf8')

test('x402 session payment uses arc-pay fee profile (bundler floor guard)', () => {
  // executeX402Pay must route through the same circle-gas-station envelope as
  // ARCOX Pay; without it Arc bundler can reject the paymaster tip (0.48 gwei
  // floor bug) and every x402 invoice payment becomes non-deterministic.
  const match = source.match(/functionName: 'transfer',\n\s+args: \[getAddress\(invoice\.recipient\), amountUnits\],\n\s+\}\], \{ paymaster: true, chainKey: 'arc-testnet', feeProfile: 'arc-pay', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true \}\)/)
  assert.ok(match, 'executeX402Pay must pass feeProfile arc-pay + receipt requirements')
})

test('x402 pay tool requires explicit confirmation before execution', () => {
  const block = source.slice(source.indexOf("registerTool('arcox_x402_pay_invoice'"), source.indexOf("registerTool('arcox_x402_invoice_status'"))
  assert.match(block, /if \(String\(params\.confirmationText \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'yes' && String\(params\.confirmationText \|\| ''\)\.trim\(\)\.toLowerCase\(\) !== 'ya'\)/)
  assert.match(block, /confirmed === true|params\.confirmed/)
})
