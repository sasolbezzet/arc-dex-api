// Outbound payment executor for mirrored marketplace resources.
//
// ARCOX quotes every marketplace resource itself (see x402Marketplace.mjs), but
// actually buying one settles USDC with the provider's own x402 endpoint. That
// settlement runs through the Circle CLI's audited `circle services pay` flow
// with an agent wallet: ARCOX never sees the provider's key, and ARCOX's own
// treasury keys are not exposed to arbitrary caller-supplied URLs.
//
// Disabled by default. With X402_MARKETPLACE_EXECUTOR unset the marketplace is
// discovery + quoting only, so no caller can spend ARCOX funds by accident.
import { execFile } from 'child_process'

const EXECUTOR_MODES = new Set(['disabled', 'cli'])
const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const HEADER_NAME = /^[A-Za-z0-9-]+$/
const SHELL_METACHARS = /[;&|$`"'()<>\\\n\r\t]/

export function marketplaceExecutorConfig() {
  const raw = String(process.env.X402_MARKETPLACE_EXECUTOR || 'disabled').trim().toLowerCase()
  const mode = EXECUTOR_MODES.has(raw) ? raw : 'disabled'
  return {
    mode,
    bin: String(process.env.CIRCLE_CLI_BIN || 'circle'),
    payerAddress: String(process.env.X402_MARKETPLACE_PAYER_ADDRESS || '').trim(),
    defaultChain: String(process.env.X402_MARKETPLACE_PAYER_CHAIN || 'ARC').trim().toUpperCase(),
    timeoutMs: Number(process.env.X402_MARKETPLACE_PAY_TIMEOUT_MS || 120_000),
    maxUpstreamUsdc: Number(process.env.X402_MARKETPLACE_MAX_UPSTREAM_USDC || 5),
  }
}

/** What the route reports before it will accept a paid marketplace call. */
export function marketplaceExecutorStatus() {
  const config = marketplaceExecutorConfig()
  const addressValid = /^0x[0-9a-fA-F]{40}$/.test(config.payerAddress)
  const problems = []
  if (config.mode !== 'cli') problems.push('executor_disabled')
  if (config.mode === 'cli' && !addressValid) problems.push('payer_address_missing')
  return {
    mode: config.mode,
    configured: problems.length === 0,
    payerAddress: addressValid ? config.payerAddress : '',
    defaultChain: config.defaultChain,
    maxUpstreamUsdc: config.maxUpstreamUsdc,
    allowedChains: ['ARC', 'BASE', 'ARB', 'MATIC', 'ETH', 'OP', 'UNI', 'AVAX', 'MONAD', 'SOL'],
    problems,
    hint: problems.length
      ? 'Marketplace calls stay discovery/quote-only until X402_MARKETPLACE_EXECUTOR=cli and X402_MARKETPLACE_PAYER_ADDRESS are set to a funded agent wallet.'
      : '',
  }
}

/**
 * Caller-supplied values are provider metadata, so treat every one as hostile:
 * the URL must be plain http(s) with no shell metacharacters, the method has to
 * be in the HTTP whitelist, and header names/values must not be able to break
 * out of an argument.
 */
export function validateMarketplaceRequest({ resource, method = 'GET', headers = {} } = {}) {
  const url = String(resource || '').trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: 'resource must be an absolute http(s) URL' }
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: 'resource must use http or https' }
  if (SHELL_METACHARS.test(url)) return { ok: false, error: 'resource contains unsupported characters' }
  const verb = String(method || 'GET').toUpperCase()
  if (!SAFE_METHODS.has(verb)) return { ok: false, error: `unsupported method ${verb}` }
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HEADER_NAME.test(String(name))) return { ok: false, error: `invalid header name: ${name}` }
    const text = String(value ?? '')
    if (SHELL_METACHARS.test(text) || /[^\x20-\x7e]/.test(text)) return { ok: false, error: `invalid header value for ${name}` }
  }
  return { ok: true, url, method: verb }
}

export function buildMarketplacePayArgs({ config, resource, method, data, headers = {}, chain, maxAmountUsdc }) {
  const args = [
    'services', 'pay', resource,
    '-X', method,
    '--address', config.payerAddress,
    '--chain', String(chain || config.defaultChain).toUpperCase(),
    '--output', 'json',
    '--max-amount', String(maxAmountUsdc),
    '--timeout', String(Math.max(5, Math.ceil(config.timeoutMs / 1000) - 5)),
  ]
  if (data !== undefined && data !== null && data !== '') args.push('--data', typeof data === 'string' ? data : JSON.stringify(data))
  for (const [name, value] of Object.entries(headers || {})) args.push('-H', `${name}: ${value}`)
  return args
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch { /* fall through to the first JSON object in the output */ }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Pay a marketplace provider and return its response body. Never throws on a
 * provider/CLI failure — the caller records the outcome against the ARCOX
 * invoice so a failed delivery stays refund-review-eligible.
 */
export async function payMarketplaceEndpoint({
  resource, method = 'GET', data, headers = {}, chain = '', maxAmountUsdc,
  timeoutMs, spawnImpl,
} = {}) {
  const config = marketplaceExecutorConfig()
  const status = marketplaceExecutorStatus()
  if (!status.configured) return { ok: false, reason: 'executor_not_configured', executor: status }
  const validation = validateMarketplaceRequest({ resource, method, headers })
  if (!validation.ok) return { ok: false, reason: 'invalid_request', error: validation.error }
  const cap = Number(maxAmountUsdc)
  if (!Number.isFinite(cap) || cap <= 0) return { ok: false, reason: 'invalid_max_amount' }
  if (cap > config.maxUpstreamUsdc) {
    return { ok: false, reason: 'upstream_price_above_cap', error: `upstream price ${cap} USDC exceeds X402_MARKETPLACE_MAX_UPSTREAM_USDC ${config.maxUpstreamUsdc}` }
  }
  const args = buildMarketplacePayArgs({
    config, resource: validation.url, method: validation.method, data, headers, chain, maxAmountUsdc: cap,
  })
  const runner = spawnImpl || execFile
  const result = await new Promise(resolve => {
    runner(config.bin, args, { timeout: Number(timeoutMs || config.timeoutMs), maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
  const payload = parseCliJson(result.stdout)
  const cliError = payload?.error?.message || payload?.error?.code || null
  const ok = !result.error && !cliError
  return {
    ok,
    reason: ok ? '' : (result.error?.code === 'ETIMEDOUT' ? 'upstream_timeout' : 'upstream_payment_failed'),
    exitCode: result.error?.code ? String(result.error.code) : 0,
    providerPayload: ok ? (payload?.data ?? payload) : null,
    error: ok ? '' : String(cliError || result.error?.message || result.stderr || 'payment failed').slice(0, 300),
    method: validation.method,
    resource: validation.url,
    chain: String(chain || config.defaultChain).toUpperCase(),
    command: [config.bin, ...args.slice(0, 3), '-X', validation.method, '--address', config.payerAddress, '--chain', String(chain || config.defaultChain).toUpperCase()],
  }
}
