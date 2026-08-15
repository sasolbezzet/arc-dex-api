import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, toHex } from 'viem'
import { readFileSync } from 'node:fs'
import { paymentLogMatches, ARCOX_USDC_ADDRESS } from '../src/services/invoiceVerify.mjs'

const MERCHANT = '0x19D0730C4A4B1C509eBa5d59b6dc0D46BD3AC807'
const PAYER = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769'
const AMOUNT = 10000n // 0.01 USDC in 6-decimal units

// Build an ERC-20 Transfer log without viem's encodeEventLog (not exported in viem 2.54).
function usdcTransferLog({ from = PAYER, to = MERCHANT, value = AMOUNT } = {}) {
  return {
    address: ARCOX_USDC_ADDRESS,
    topics: [
      keccak256(toHex('Transfer(address,address,uint256)')),
      encodeAbiParameters([{ type: 'address' }], [from]),
      encodeAbiParameters([{ type: 'address' }], [to]),
    ],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  }
}

test('paymentLogMatches: accepts a matching USDC Transfer log', () => {
  const log = usdcTransferLog()
  assert.equal(paymentLogMatches({ log, expectedAmount: AMOUNT, merchantAddress: MERCHANT, payerAddress: PAYER }), true)
})

test('paymentLogMatches: rejects wrong recipient', () => {
  const log = usdcTransferLog({ to: '0x1111111111111111111111111111111111111111' })
  assert.equal(paymentLogMatches({ log, expectedAmount: AMOUNT, merchantAddress: MERCHANT, payerAddress: PAYER }), false)
})

test('paymentLogMatches: rejects wrong amount', () => {
  const log = usdcTransferLog({ value: 5000n })
  assert.equal(paymentLogMatches({ log, expectedAmount: AMOUNT, merchantAddress: MERCHANT, payerAddress: PAYER }), false)
})

test('paymentLogMatches: rejects wrong payer when payer specified', () => {
  const log = usdcTransferLog({ from: '0x2222222222222222222222222222222222222222' })
  assert.equal(paymentLogMatches({ log, expectedAmount: AMOUNT, merchantAddress: MERCHANT, payerAddress: PAYER }), false)
})

test('paymentLogMatches: accepts when payer is omitted', () => {
  const log = usdcTransferLog()
  assert.equal(paymentLogMatches({ log, expectedAmount: AMOUNT, merchantAddress: MERCHANT }), true)
})

test('paymentLogMatches: rejects non-USDC log', () => {
  const log = { ...usdcTransferLog(), address: '0xffffffffffffffffffffffffffffffffffffffff' }
  assert.equal(paymentLogMatches({ log, expectedAmount: AMOUNT, merchantAddress: MERCHANT, payerAddress: PAYER }), false)
})

test('paymentLogMatches: rejects malformed log without throwing', () => {
  assert.equal(paymentLogMatches({ log: { address: ARCOX_USDC_ADDRESS, data: '0x', topics: [] }, expectedAmount: AMOUNT, merchantAddress: MERCHANT, payerAddress: PAYER }), false)
})

test('server.mjs uses the extracted helper (guards missing-import regressions)', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ paymentLogMatches \} from '\.\/src\/services\/invoiceVerify\.mjs'/)
  // The verification path must reference the helper instead of calling decodeEventLog inline,
  // otherwise a missing viem import silently breaks every invoice payment confirmation.
  assert.doesNotMatch(source, /decodeEventLog is not defined/)
  assert.match(source, /receipt\.logs\.some\(\(log\) => paymentLogMatches/)
})
