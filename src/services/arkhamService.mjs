import { cacheTtlForPath } from './intelCatalog.mjs'

const cache = globalThis.__arcoxArkhamCache || new Map()
globalThis.__arcoxArkhamCache = cache

// ── Per-service circuit breaker ──
// A service that repeatedly fails at the provider (5xx/timeout) is opened for
// a cooldown period instead of being sold to the next payer. Half-open state
// lets one probe through; success closes, failure reopens. 404s never trip
// the breaker (they mean the data does not exist, which is a refund path, not
// a provider fault).
const circuits = globalThis.__arcoxArkhamCircuits || new Map()
globalThis.__arcoxArkhamCircuits = circuits

function circuitKey(path) {
  const segments = String(path || '').split('?')[0].split('/').filter(Boolean)
  // Drop value-like path parameters (0x-hashes, hex ids, big numbers) so a
  // failing endpoint is treated as one degraded service, not one circuit per
  // address. Keep the remaining significant segments (max 3) as the key.
  const significant = segments.filter(segment => !/^(?:0x[0-9a-f]{2,}|[0-9]{4,}|[0-9a-f]{32,})$/i.test(segment))
  return significant.slice(0, 3).join('/')
}

function circuitConfig() {
  return {
    failures: Number(process.env.ARCOX_INTEL_CIRCUIT_FAILURES || 3),
    windowMs: Number(process.env.ARCOX_INTEL_CIRCUIT_WINDOW_MS || 5 * 60 * 1000),
    cooldownMs: Number(process.env.ARCOX_INTEL_CIRCUIT_COOLDOWN_MS || 60 * 1000),
  }
}

function circuitState(key) {
  let state = circuits.get(key)
  if (!state) {
    state = { key, state: 'closed', failures: [], openedAt: 0, lastFailureAt: 0, lastSuccessAt: 0 }
    circuits.set(key, state)
  }
  return state
}

export function isCircuitOpen(path) {
  const key = circuitKey(path)
  const state = circuitState(key)
  if (state.state !== 'open') return false
  const { cooldownMs } = circuitConfig()
  if (Date.now() - state.openedAt >= cooldownMs) {
    state.state = 'half_open'
    circuits.set(key, state)
    return false
  }
  return true
}

export function recordCircuitFailure(path) {
  const key = circuitKey(path)
  const state = circuitState(key)
  const { failures, windowMs } = circuitConfig()
  const now = Date.now()
  state.failures = state.failures.filter(timestamp => now - timestamp < windowMs)
  state.failures.push(now)
  state.lastFailureAt = now
  if (state.state === 'half_open' || state.failures.length >= failures) {
    state.state = 'open'
    state.openedAt = now
  }
  circuits.set(key, state)
  return state
}

export function recordCircuitSuccess(path) {
  const key = circuitKey(path)
  const state = circuitState(key)
  state.failures = []
  state.lastSuccessAt = Date.now()
  if (state.state !== 'closed') {
    state.state = 'closed'
    state.openedAt = 0
  }
  circuits.set(key, state)
  return state
}

/** Current state of all circuit keys (for provider-health + catalog). */
export function circuitStatus() {
  return [...circuits.values()].map(state => ({
    key: state.key,
    state: state.state,
    failureCount: state.failures.length,
    openedAt: state.openedAt || undefined,
    lastFailureAt: state.lastFailureAt || undefined,
    lastSuccessAt: state.lastSuccessAt || undefined,
  }))
}

export function degradedForProviderPath(path) {
  return isCircuitOpen(path)
}

export class ArkhamService {
  constructor() {
    this.baseUrl = (process.env.ARKHAM_BASE_URL || 'https://api.arkm.com').replace(/\/$/, '')
    this.apiKey = process.env.ARKHAM_API_KEY || ''
    this.defaultTtlMs = Number(process.env.ARCOX_INTEL_CACHE_TTL_SECONDS || 600) * 1000
  }

  /** Resolve per-service cache TTL in milliseconds for a given provider path. */
  ttlMsForPath(path) {
    const tierSeconds = cacheTtlForPath(path)
    if (tierSeconds) return tierSeconds * 1000
    return this.defaultTtlMs
  }

  async get(path, query = {}) {
    if (!this.apiKey) {
      return {
        ok: false,
        mode: 'mock',
        error: 'ARKHAM_API_KEY is not configured on arc-dex-api.',
        path,
        query,
        disclaimer: disclaimer(),
      }
    }
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const cacheKey = url.toString()
    const ttlMs = this.ttlMsForPath(path)
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.createdAt < ttlMs) return { ...hit.data, cached: true }

    // Circuit breaker: refuse to sell a service that is failing at the
    // provider. Cached data is served above, so only fresh calls are gated.
    if (isCircuitOpen(path)) {
      const error = new Error('Arkham provider service is temporarily degraded; try again later')
      error.status = 503
      error.degraded = true
      error.circuitOpen = true
      throw error
    }

    // Heavy analytics endpoints (Solana subaccounts, entity counterparties,
    // global feeds) regularly exceed a 15s budget at the provider. Use a
    // generous per-call timeout and retry once on timeout / 5xx so a slow
    // Arkham response does not fail an already-paid request.
    const timeoutMs = Number(process.env.ARCOX_INTEL_ARKHAM_TIMEOUT_MS || 45_000)
    let lastError
    for (let attempt = 0; attempt <= 1; attempt++) {
      let response
      try {
        response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'API-Key': this.apiKey,
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (fetchError) {
        lastError = fetchError
        recordCircuitFailure(path)
        if (attempt === 0) continue // retry once on network/timeout error
        break
      }
      if (response.status >= 500 && response.status < 600 && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 1_000))
        continue // retry once on provider 5xx
      }
      const text = await response.text()
      let data = {}
      try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
      if (!response.ok) {
        const message = data?.message || data?.error || `Arkham HTTP ${response.status}`
        const error = new Error(message)
        error.status = response.status
        error.data = data
        if (response.status >= 500) recordCircuitFailure(path)
        throw error
      }
      recordCircuitSuccess(path)
      const wrapped = { ok: true, mode: 'arkham', data, disclaimer: disclaimer() }
      cache.set(cacheKey, { createdAt: Date.now(), data: wrapped })
      return wrapped
    }
    throw lastError || new Error('Arkham request failed')
  }

  async reportAddress(address) {
    const sections = {
      intelligence: `/intelligence/address/${encodeURIComponent(address)}`,
      enriched: `/intelligence/address_enriched/${encodeURIComponent(address)}`,
      balances: `/balances/address/${encodeURIComponent(address)}`,
      counterparties: `/counterparties/address/${encodeURIComponent(address)}`,
      flows: `/flow/address/${encodeURIComponent(address)}`,
      volume: { path: `/volume/address/${encodeURIComponent(address)}`, query: { timeLast: '24h' } },
    }
    const report = {}
    const errors = []
    for (const [section, path] of Object.entries(sections)) {
      try {
        report[section] = typeof path === 'string' ? await this.get(path) : await this.get(path.path, path.query)
      } catch (error) {
        errors.push({ section, message: error.message || `Arkham ${section} endpoint failed` })
      }
    }
    return { ok: true, mode: this.apiKey ? 'arkham' : 'mock', address, report, errors, disclaimer: disclaimer() }
  }
}

export function disclaimer() {
  return 'Informational only. Not financial advice.'
}
