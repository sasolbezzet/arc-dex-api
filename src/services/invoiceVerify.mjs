// ARCOX Pay invoice payment verification.
// Extracted from server.mjs so the receipt-log matching logic is unit-testable.
// A missing viem import here (e.g. decodeEventLog) breaks invoice payment
// confirmation for every session-key payment, so keep imports explicit.
import { decodeEventLog, erc20Abi } from 'viem'

export const ARCOX_USDC_ADDRESS = '0x3600000000000000000000000000000000000000'

/**
 * Check a single receipt log against the invoice payment criteria.
 * @param {object} input
 * @param {object} input.log - receipt log ({ address, data, topics })
 * @param {bigint} input.expectedAmount - USDC units expected (6 decimals)
 * @param {string} input.merchantAddress - recipient (any case)
 * @param {string} [input.payerAddress] - optional expected payer
 * @returns {boolean}
 */
export function paymentLogMatches({ log, expectedAmount, merchantAddress, payerAddress = '' }) {
  if (String(log.address).toLowerCase() !== ARCOX_USDC_ADDRESS.toLowerCase()) return false
  try {
    const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics })
    if (String(decoded.eventName || '') !== 'Transfer') return false
    const args = decoded.args || {}
    const from = String(args.from || '').toLowerCase()
    const to = String(args.to || '').toLowerCase()
    const value = BigInt(String(args.value || '0'))
    const payer = payerAddress ? String(payerAddress).toLowerCase() : ''
    return to === String(merchantAddress).toLowerCase() && value === expectedAmount && (!payer || from === payer)
  } catch {
    return false
  }
}
