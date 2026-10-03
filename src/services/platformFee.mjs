// ARCOX platform fee policy in one place: the fee an x402 buyer pays on top of
// the underlying service price. The same maths backs ARCOX's own resources
// (opt-in through X402_PLATFORM_FEE_SERVICES_ENABLED) and the x402 marketplace
// resale layer, so an invoice, a quote, and the public config can never
// disagree about what the buyer owes and what ARCOX keeps.
//
// The fee is charged on top of the price, never carved out of it: the seller
// side (or the upstream marketplace provider) still receives the full amount,
// which keeps marketplace accounting honest (cost vs. margin).

const PERCENT_DENOMINATOR = 10_000n

/** Fee in basis points. 50 = 0.5% (kebijakan platform ARCOX saat ini). */
export function platformFeeBps() {
  const raw = Number(process.env.X402_PLATFORM_FEE_BPS ?? 50)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.floor(raw), 10_000)
}

/** Flat fee in USDC added to every paid call. Defaults to 0. */
export function platformFeeFixedUsdc() {
  const raw = String(process.env.X402_PLATFORM_FEE_FIXED_USDC ?? '0').trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) return '0'
  return raw
}

/**
 * Whether the platform fee is also added to ARCOX's own paid resources
 * (Intel, marketplace proxy invoices are always fee-quoted). Off by default so
 * enabling the fee on existing services is an explicit business decision.
 */
export function platformFeeEnabledForServices() {
  return String(process.env.X402_PLATFORM_FEE_SERVICES_ENABLED || 'false').toLowerCase() === 'true'
}

/** Fixed-fee-only mode: fee collected even when bps is 0. */
export function platformFeeConfigured(config = {}) {
  const bps = config.bps ?? platformFeeBps()
  const fixed = String(config.fixedUsdc ?? platformFeeFixedUsdc())
  return Number(bps) > 0 || Number(fixed) > 0
}

/** USDC amount (6 decimals) to base units. Throws on a malformed amount. */
export function toUsdcBaseUnits(amount, { allowZero = false } = {}) {
  const raw = String(amount ?? '').trim()
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error('Invalid USDC amount')
  const [whole, fraction = ''] = raw.split('.')
  const units = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (units < 0n || (units === 0n && !allowZero)) throw new Error('Invalid USDC amount')
  return units
}

/** Base units back to a fixed 6-decimal USDC string. */
export function fromUsdcBaseUnits(units) {
  const value = BigInt(units)
  if (value < 0n) throw new Error('Invalid USDC base units')
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`
}

/**
 * Split a service price into net amount, ARCOX fee, and what the buyer pays.
 * The percentage part is rounded down (in the buyer's favour) so the fee can
 * never round a sub-cent price up past the seller's cut.
 */
export function applyPlatformFee(amount, config = {}) {
  const baseUnits = toUsdcBaseUnits(amount)
  const bps = Number(config.bps ?? platformFeeBps()) || 0
  const fixedUsdc = String(config.fixedUsdc ?? platformFeeFixedUsdc())
  const fixedUnits = toUsdcBaseUnits(fixedUsdc, { allowZero: true })
  const percentUnits = bps > 0 ? (baseUnits * BigInt(bps)) / PERCENT_DENOMINATOR : 0n
  const feeUnits = percentUnits + fixedUnits
  const applied = feeUnits > 0n && config.enabled !== false
  const chargedFeeUnits = applied ? feeUnits : 0n
  return {
    applied,
    bps: applied ? bps : 0,
    fixedUsdc: applied ? fixedUsdc : '0',
    netAmount: fromUsdcBaseUnits(baseUnits),
    feeAmount: fromUsdcBaseUnits(chargedFeeUnits),
    totalAmount: fromUsdcBaseUnits(baseUnits + chargedFeeUnits),
    netBaseUnits: baseUnits.toString(),
    feeBaseUnits: chargedFeeUnits.toString(),
    totalBaseUnits: (baseUnits + chargedFeeUnits).toString(),
  }
}

/** Public, non-secret fee policy for /api/x402/config and quotes. */
export function publicPlatformFee(config = {}) {
  const bps = Number(config.bps ?? platformFeeBps()) || 0
  const fixedUsdc = String(config.fixedUsdc ?? platformFeeFixedUsdc())
  return {
    asset: 'USDC',
    bps,
    percent: Number((bps / 100).toFixed(4)),
    fixedUsdc,
    chargedOn: 'top-of-price',
    servicesEnabled: config.servicesEnabled ?? platformFeeEnabledForServices(),
    marketplaceEnabled: true,
    minChargeUsdc: Number(process.env.X402_PLATFORM_FEE_MIN_USDC || 0) || 0,
    example: applyPlatformFee(config.exampleAmount || '0.05', { bps, fixedUsdc }),
  }
}
