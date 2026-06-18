const cache = globalThis.__arcoxArkhamCache || new Map()
globalThis.__arcoxArkhamCache = cache

export class ArkhamService {
  constructor() {
    this.baseUrl = (process.env.ARKHAM_BASE_URL || 'https://api.arkm.com').replace(/\/$/, '')
    this.apiKey = process.env.ARKHAM_API_KEY || ''
    this.ttlMs = Number(process.env.ARCOX_INTEL_CACHE_TTL_SECONDS || 600) * 1000
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
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.createdAt < this.ttlMs) return { ...hit.data, cached: true }

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'API-Key': this.apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    })
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

  async reportAddress(address) {
    const sections = {
      intelligence: `/intelligence/address/${encodeURIComponent(address)}`,
      enriched: `/intelligence/address_enriched/${encodeURIComponent(address)}`,
      balances: `/balances/address/${encodeURIComponent(address)}`,
      counterparties: `/counterparties/address/${encodeURIComponent(address)}`,
      flows: `/flow/address/${encodeURIComponent(address)}`,
      volume: `/volume/address/${encodeURIComponent(address)}`,
    }
    const report = {}
    const errors = []
    for (const [section, path] of Object.entries(sections)) {
      try {
        report[section] = await this.get(path)
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
