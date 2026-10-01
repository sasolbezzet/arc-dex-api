// Keeps the x402 marketplace mirror fresh.
//
// The discovery directory is cached publicly for an hour and its resources
// churn, so a mirror that is never refreshed would quote prices that no longer
// exist. The worker refreshes on a long interval (6h by default) and only when
// the mirror is actually stale, which also makes the first boot populate an
// empty catalogue without a synchronous HTTP burst in the request path.
import { loadMarketplaceCatalog, syncMarketplaceCatalog } from './x402Marketplace.mjs'

export function marketplaceSyncEnabled() {
  return String(process.env.X402_MARKETPLACE_SYNC_ENABLED || 'true').toLowerCase() !== 'false'
}

export function marketplaceSyncIntervalMs() {
  const configured = Number(process.env.X402_MARKETPLACE_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000)
  return Number.isFinite(configured) && configured > 0 ? configured : 6 * 60 * 60 * 1000
}

/** Sync only when the mirror is missing or older than its max age. */
export async function syncMarketplaceIfStale(options = {}) {
  if (!marketplaceSyncEnabled() && !options.force) return { ok: true, skipped: 'disabled' }
  const catalog = loadMarketplaceCatalog()
  if (catalog.items.length && !catalog.stale) return { ok: true, skipped: 'fresh', items: catalog.items.length, syncedAt: catalog.syncedAt }
  return syncMarketplaceCatalog(options)
}

export function startMarketplaceSyncWorker() {
  if (globalThis.__arcoxMarketplaceSyncInterval) return globalThis.__arcoxMarketplaceSyncInterval
  if (!marketplaceSyncEnabled()) {
    console.log('[marketplace] sync worker disabled (X402_MARKETPLACE_SYNC_ENABLED=false)')
    return null
  }
  const interval = marketplaceSyncIntervalMs()
  const refresh = () => {
    void syncMarketplaceIfStale()
      .then(summary => {
        if (summary?.skipped) return
        if (summary?.ok) console.log(`[marketplace] mirror refreshed: ${summary.items} resource(s) in ${summary.pages} page(s)`)
        else console.error('[marketplace] refresh failed:', summary?.error || 'unknown error')
      })
      .catch(error => console.error('[marketplace] refresh error:', error?.message || error))
  }
  // Boot pass (populates an empty mirror) and then a steady interval.
  refresh()
  const intervalId = setInterval(refresh, interval)
  if (typeof intervalId.unref === 'function') intervalId.unref()
  globalThis.__arcoxMarketplaceSyncInterval = intervalId
  console.log(`[marketplace] sync worker started (interval=${interval}ms, maxAge=${process.env.X402_MARKETPLACE_MAX_AGE_MS || 'default'})`)
  return intervalId
}
