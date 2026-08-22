import { cacheTtlForPath } from './intelCatalog.mjs'

const cache = globalThis.__arcoxArkhamCache || new Map()
globalThis.__arcoxArkhamCache = cache

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
        throw error
      }
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
