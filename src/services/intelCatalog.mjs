// ARCOX Intel structured service catalog. Maps each Intel route to its
// Arkham provider path, price (env var + fallback), default query params,
// cache TTL tier, required parameters, and a human description. Used by
// /api/intel/catalog and by ArkhamService for per-service cache TTL.

const CACHE_TIERS = {
  static: 3600,        // 1 hour — rarely changes (chains, arkm circulating)
  slow: 1800,          // 30 min — semi-static (network status, altcoin index)
  default: 600,         // 10 min — standard
  dynamic: 120,        // 2 min — frequently updated (flows, transfers, swaps)
}

const catalog = [
  // Address intelligence
  { route: '/address/:address', provider: '/intelligence/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_ADDRESS', fallback: '0.005', cacheTier: 'default', service: 'Address Intelligence', description: 'Basic on-chain intelligence for an address.', required: ['address'] },
  { route: '/address/:address/all', provider: '/intelligence/address/:address/all', priceEnv: 'ARCOX_INTEL_PRICE_ADDRESS_ALL', fallback: '0.01', cacheTier: 'default', service: 'Address Intelligence (All)', description: 'Full intelligence aggregate for an address.', required: ['address'] },
  { route: '/address/:address/enriched', provider: '/intelligence/address_enriched/:address', priceEnv: 'ARCOX_INTEL_PRICE_ADDRESS_ENRICHED', fallback: '0.01', cacheTier: 'default', service: 'Address Intelligence (Enriched)', description: 'Enriched intelligence for an address.', required: ['address'] },
  { route: '/address/:address/balances', provider: '/balances/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_BALANCES', fallback: '0.01', cacheTier: 'default', service: 'Address Balances', description: 'Token balances for an address.', required: ['address'] },
  { route: '/address/:address/counterparties', provider: '/counterparties/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_COUNTERPARTIES', fallback: '0.02', cacheTier: 'default', service: 'Address Counterparties', description: 'Top counterparties for an address.', required: ['address'], defaults: { limit: '100' } },
  { route: '/address/:address/flows', provider: '/flow/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_FLOWS', fallback: '0.03', cacheTier: 'dynamic', service: 'Address Flows', description: 'Fund flows for an address.', required: ['address'], defaults: { timeLast: '24h' } },
  { route: '/address/:address/history', provider: '/history/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_HISTORY', fallback: '0.03', cacheTier: 'dynamic', service: 'Address History', description: 'Historical transactions for an address.', required: ['address'], defaults: { timeLast: '24h' } },
  { route: '/address/:address/volume', provider: '/volume/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_VOLUME', fallback: '0.03', cacheTier: 'dynamic', service: 'Address Volume', description: 'Volume metrics for an address.', required: ['address'], defaults: { timeLast: '24h' } },
  { route: '/address/:address/portfolio', provider: '/portfolio/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_BALANCES', fallback: '0.01', cacheTier: 'default', service: 'Address Portfolio', description: 'Portfolio snapshot for an address.', required: ['address'] },

  // Risk
  { route: '/risk/address/:address', provider: '/risk/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_RISK', fallback: '0.03', cacheTier: 'slow', service: 'Risk Score', description: 'Compliance risk score for an address.', required: ['address'] },
  { route: '/risk/address/:address/paths', provider: '/risk/address/:address/paths', priceEnv: 'ARCOX_INTEL_PRICE_RISK_PATHS', fallback: '0.05', cacheTier: 'slow', service: 'Risk Paths', description: 'Traced transaction risk paths for an address.', required: ['address'] },
  { route: '/risk/entity/:entity', provider: '/risk/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_RISK_ENTITY', fallback: '0.03', cacheTier: 'slow', service: 'Entity Risk Score', description: 'Compliance risk score for an entity.', required: ['entity'] },

  // Loans
  { route: '/loans/address/:address', provider: '/loans/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_LOANS', fallback: '0.03', cacheTier: 'default', service: 'Address Loans', description: 'Lending and borrowing positions for an address.', required: ['address'] },
  { route: '/loans/entity/:entity', provider: '/loans/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_LOANS_ENTITY', fallback: '0.03', cacheTier: 'default', service: 'Entity Loans', description: 'Lending and borrowing positions for an entity.', required: ['entity'] },

  // Entity intelligence
  { route: '/entity/:entity', provider: '/intelligence/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_ENTITY', fallback: '0.02', cacheTier: 'default', service: 'Entity Intelligence', description: 'Basic intelligence for an entity.', required: ['entity'] },
  { route: '/entity/:entity/summary', provider: '/intelligence/entity/:entity/summary', priceEnv: 'ARCOX_INTEL_PRICE_ENTITY', fallback: '0.02', cacheTier: 'default', service: 'Entity Summary', description: 'Summary for an entity.', required: ['entity'] },
  { route: '/entity/:entity/balances', provider: '/balances/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_ENTITY', fallback: '0.02', cacheTier: 'default', service: 'Entity Balances', description: 'Token balances for an entity.', required: ['entity'] },
  { route: '/entity/:entity/counterparties', provider: '/counterparties/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_COUNTERPARTIES', fallback: '0.02', cacheTier: 'default', service: 'Entity Counterparties', description: 'Top counterparties for an entity.', required: ['entity'], defaults: { limit: '100' } },
  { route: '/entity/:entity/flows', provider: '/flow/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_FLOWS', fallback: '0.02', cacheTier: 'dynamic', service: 'Entity Flows', description: 'Fund flows for an entity.', required: ['entity'], defaults: { timeLast: '24h' } },
  { route: '/entity/:entity/history', provider: '/history/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_HISTORY', fallback: '0.02', cacheTier: 'dynamic', service: 'Entity History', description: 'Historical transactions for an entity.', required: ['entity'], defaults: { timeLast: '24h' } },
  { route: '/entity/:entity/volume', provider: '/volume/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_VOLUME', fallback: '0.02', cacheTier: 'dynamic', service: 'Entity Volume', description: 'Volume metrics for an entity.', required: ['entity'], defaults: { timeLast: '24h' } },
  { route: '/entity/:entity/portfolio', provider: '/portfolio/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_BALANCES', fallback: '0.02', cacheTier: 'default', service: 'Entity Portfolio', description: 'Portfolio snapshot for an entity.', required: ['entity'] },
  { route: '/intelligence/entity/:entity/predictions', provider: '/intelligence/entity_predictions/:entity', priceEnv: 'ARCOX_INTEL_PRICE_ENTITY_PREDICTIONS', fallback: '0.03', cacheTier: 'default', service: 'Entity Predictions', description: 'Predicted entity labels for an entity.', required: ['entity'] },

  // Network & market metadata
  { route: '/chains', provider: '/chains', priceEnv: 'ARCOX_INTEL_PRICE_NETWORK', fallback: '0.005', cacheTier: 'static', service: 'Supported Chains', description: 'List of Arkham-supported chains.', required: [] },
  { route: '/networks/status', provider: '/networks/status', priceEnv: 'ARCOX_INTEL_PRICE_NETWORK', fallback: '0.005', cacheTier: 'slow', service: 'Network Status', description: 'Current Arkham network status.', required: [] },
  { route: '/networks/history/:chain', provider: '/networks/history/:chain', priceEnv: 'ARCOX_INTEL_PRICE_NETWORK_HISTORY', fallback: '0.02', cacheTier: 'slow', service: 'Network History', description: 'Historical network status for a chain.', required: ['chain'] },
  { route: '/arkm/circulating', provider: '/arkm/circulating', priceEnv: 'ARCOX_INTEL_PRICE_ARKM_CIRCULATING', fallback: '0.005', cacheTier: 'static', service: 'ARKM Circulating Supply', description: 'Circulating supply of ARKM token.', required: [] },
  { route: '/marketdata/altcoin-index', provider: '/marketdata/altcoin_index', priceEnv: 'ARCOX_INTEL_PRICE_ALTCOIN_INDEX', fallback: '0.01', cacheTier: 'slow', service: 'Altcoin Index', description: 'Arkham altcoin index data.', required: [] },
  { route: '/cluster/:id/summary', provider: '/cluster/:id/summary', priceEnv: 'ARCOX_INTEL_PRICE_CLUSTER', fallback: '0.02', cacheTier: 'default', service: 'Cluster Summary', description: 'Statistics for an Arkham address cluster.', required: ['id'] },

  // Transfers & swaps
  { route: '/transfers', provider: '/transfers', priceEnv: 'ARCOX_INTEL_PRICE_TRANSFERS', fallback: '0.03', cacheTier: 'dynamic', service: 'Global Transfers', description: 'Enriched global transfer feed.', required: [] },
  { route: '/transfers/unenriched', provider: '/transfers/unenriched', priceEnv: 'ARCOX_INTEL_PRICE_TRANSFERS_UNENRICHED', fallback: '0.03', cacheTier: 'dynamic', service: 'Unenriched Transfers', description: 'Raw unenriched transfer feed.', required: [] },
  { route: '/transfers/histogram', provider: '/transfers/histogram', priceEnv: 'ARCOX_INTEL_PRICE_TRANSFERS_HISTOGRAM', fallback: '0.03', cacheTier: 'dynamic', service: 'Transfer Histogram', description: 'Aggregated transfer histogram.', required: ['base', 'granularity'] },
  { route: '/swaps', provider: '/swaps', priceEnv: 'ARCOX_INTEL_PRICE_SWAPS', fallback: '0.03', cacheTier: 'dynamic', service: 'Historical Swaps', description: 'Historical DEX swap activity.', required: [] },

  // Portfolio
  { route: '/portfolio/time-series/address/:address', provider: '/portfolio/timeSeries/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_PORTFOLIO_SERIES', fallback: '0.02', cacheTier: 'default', service: 'Portfolio Time Series (Address)', description: 'Daily portfolio time-series for an address.', required: ['address', 'pricingId'] },
  { route: '/portfolio/time-series/entity/:entity', provider: '/portfolio/timeSeries/entity/:entity', priceEnv: 'ARCOX_INTEL_PRICE_PORTFOLIO_SERIES', fallback: '0.02', cacheTier: 'default', service: 'Portfolio Time Series (Entity)', description: 'Daily portfolio time-series for an entity.', required: ['entity', 'pricingId'] },

  // Transaction
  { route: '/tx/:hash', provider: '/tx/:hash', priceEnv: 'ARCOX_INTEL_PRICE_TX', fallback: '0.005', cacheTier: 'default', service: 'Transaction Intelligence', description: 'Intelligence for a transaction hash.', required: ['hash'] },
  { route: '/tx/:hash/transfers', provider: '/transfers/tx/:hash', priceEnv: 'ARCOX_INTEL_PRICE_TX', fallback: '0.005', cacheTier: 'default', service: 'Transaction Transfers', description: 'Transfers within a transaction.', required: ['hash'], defaults: { chain: 'ethereum' } },

  // HyperCore
  { route: '/hypercore/markets', provider: '/hypercore/markets', priceEnv: 'ARCOX_INTEL_PRICE_HYPERCORE_MARKETS', fallback: '0.02', cacheTier: 'slow', service: 'HyperCore Markets', description: 'HyperCore/Hyperliquid market data.', required: [] },
  { route: '/hypercore/account/:address/:service', provider: '/hypercore/account/:address/:service', priceEnv: 'ARCOX_INTEL_PRICE_HYPERCORE_ACCOUNT', fallback: '0.03', cacheTier: 'default', service: 'HyperCore Account', description: 'HyperCore account analytics (summary, perp-positions, trades, etc.).', required: ['address', 'service'] },
  { route: '/hypercore/entity/:entity/:service', provider: '/hypercore/entity/:entity/:service', priceEnv: 'ARCOX_INTEL_PRICE_HYPERCORE_ENTITY', fallback: '0.03', cacheTier: 'default', service: 'HyperCore Entity', description: 'HyperCore entity analytics.', required: ['entity', 'service'] },
  { route: '/hypercore/token/:pricingId/positions', provider: '/hypercore/token/:pricingId/positions', priceEnv: 'ARCOX_INTEL_PRICE_HYPERCORE_POSITIONS', fallback: '0.03', cacheTier: 'default', service: 'HyperCore Token Positions', description: 'HyperCore perp positions for a token.', required: ['pricingId'] },
  { route: '/hypercore/trades', provider: '/hypercore/trades', priceEnv: 'ARCOX_INTEL_PRICE_HYPERCORE_TRADES', fallback: '0.03', cacheTier: 'dynamic', service: 'HyperCore Trades', description: 'Historical HyperCore trades.', required: [] },
  { route: '/hypercore/trades/aggregate', provider: '/hypercore/trades/aggregate', priceEnv: 'ARCOX_INTEL_PRICE_HYPERCORE_TRADES', fallback: '0.03', cacheTier: 'dynamic', service: 'HyperCore Trades Aggregate', description: 'Aggregated HyperCore trade volume.', required: [] },

  // Polymarket
  { route: '/polymarket/events', provider: '/polymarket/events', priceEnv: 'ARCOX_INTEL_PRICE_POLYMARKET', fallback: '0.03', cacheTier: 'default', service: 'Polymarket Events', description: 'Active Polymarket prediction events.', required: [] },
  { route: '/polymarket/activity', provider: '/polymarket/activity', priceEnv: 'ARCOX_INTEL_PRICE_POLYMARKET', fallback: '0.03', cacheTier: 'dynamic', service: 'Polymarket Activity', description: 'Recent Polymarket trading activity.', required: [] },
  { route: '/polymarket/positions/:addr', provider: '/polymarket/positions/:addr', priceEnv: 'ARCOX_INTEL_PRICE_POLYMARKET', fallback: '0.03', cacheTier: 'default', service: 'Polymarket Positions', description: 'Polymarket positions for a wallet.', required: ['addr'] },
  { route: '/polymarket/wallet/:addr/summary/:metric', provider: '/polymarket/wallet/:addr/summary/:metric', priceEnv: 'ARCOX_INTEL_PRICE_POLYMARKET', fallback: '0.03', cacheTier: 'default', service: 'Polymarket Wallet Summary', description: 'Polymarket wallet summary (pnl, balance, portfolio, etc.).', required: ['addr', 'metric'] },

  // Token
  { route: '/token/:id', provider: '/intelligence/token/:id', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_BASIC', fallback: '0.005', cacheTier: 'default', service: 'Token Intelligence', description: 'Basic intelligence for a token.', required: ['id'] },
  { route: '/token/:id/market', provider: '/token/market/:id', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_BASIC', fallback: '0.005', cacheTier: 'default', service: 'Token Market', description: 'Market data for a token.', required: ['id'] },
  { route: '/token/:id/holders', provider: '/token/holders/:id', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_HOLDERS', fallback: '0.03', cacheTier: 'default', service: 'Token Holders', description: 'Top holders of a token.', required: ['id'] },
  { route: '/token/:id/price-history', provider: '/token/price/history/:id', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_HISTORY', fallback: '0.01', cacheTier: 'default', service: 'Token Price History', description: 'Price history for a token.', required: ['id'] },
  { route: '/token/:id/price-change', provider: '/token/price_change/:id', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_CHANGE', fallback: '0.005', cacheTier: 'default', service: 'Token Price Change', description: 'Price change for a token.', required: ['id', 'pastTime'] },
  { route: '/token/:id/volume', provider: '/token/volume/:id', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_VOLUME', fallback: '0.03', cacheTier: 'default', service: 'Token Volume', description: 'Volume data for a token.', required: ['id', 'granularity'] },
  { route: '/token/trending', provider: '/token/trending', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_BASIC', fallback: '0.005', cacheTier: 'default', service: 'Trending Tokens', description: 'Trending tokens.', required: [] },
  { route: '/token/top', provider: '/token/top', priceEnv: 'ARCOX_INTEL_PRICE_TOKEN_BASIC', fallback: '0.005', cacheTier: 'default', service: 'Top Tokens', description: 'Top tokens by volume.', required: [] },

  // Tag
  { route: '/tag/:id/params', provider: '/tag/:id/params', priceEnv: 'ARCOX_INTEL_PRICE_TAG', fallback: '0.02', cacheTier: 'static', service: 'Tag Parameters', description: 'Parameters for an Arkham tag.', required: ['id'] },
  { route: '/tag/:id/summary', provider: '/tag/:id/summary', priceEnv: 'ARCOX_INTEL_PRICE_TAG', fallback: '0.02', cacheTier: 'static', service: 'Tag Summary', description: 'Summary for an Arkham tag.', required: ['id'] },

  // Solana
  { route: '/balances/solana/subaccounts/address/:addresses', provider: '/balances/solana/subaccounts/address/:addresses', priceEnv: 'ARCOX_INTEL_PRICE_SOLANA_SUBACCOUNTS', fallback: '0.02', cacheTier: 'default', service: 'Solana Subaccounts (Address)', description: 'Solana subaccount balances for addresses.', required: ['addresses', 'pricingID'] },
  { route: '/balances/solana/subaccounts/entity/:entities', provider: '/balances/solana/subaccounts/entity/:entities', priceEnv: 'ARCOX_INTEL_PRICE_SOLANA_SUBACCOUNTS', fallback: '0.03', cacheTier: 'default', service: 'Solana Subaccounts (Entity)', description: 'Solana subaccount balances for entities.', required: ['entities', 'pricingID'] },

  // Search & contract
  { route: '/search', provider: '/intelligence/search', priceEnv: 'ARCOX_INTEL_PRICE_ADDRESS', fallback: '0.005', cacheTier: 'default', service: 'Search', description: 'Search Arkham entities, addresses, tokens, and more.', required: ['query'] },
  { route: '/contract/:chain/:address', provider: '/intelligence/contract/:chain/:address', priceEnv: 'ARCOX_INTEL_PRICE_CONTRACT', fallback: '0.01', cacheTier: 'default', service: 'Contract Intelligence', description: 'Intelligence for a smart contract.', required: ['chain', 'address'] },

  // Report
  { route: '/report/address/:address', provider: '/report/address/:address', priceEnv: 'ARCOX_INTEL_PRICE_REPORT_ADDRESS', fallback: '0.05', cacheTier: 'default', service: 'Full Wallet Report', description: 'Comprehensive wallet report (intelligence, balances, flows, volume, counterparties).', required: ['address'] },
]

/**
 * Resolve the cache TTL (seconds) for a given Arkham provider path.
 * Falls back to the default tier if no match is found.
 */
export function cacheTtlForPath(providerPath) {
  const base = String(providerPath || '').split('?')[0]
  const entry = catalog.find(item => base.startsWith(item.provider.split('/:')[0]))
  return CACHE_TIERS[entry?.cacheTier || 'default']
}

/**
 * Return the full structured catalog for public consumption.
 * Prices are resolved from env vars at call time.
 */
export function getIntelCatalog() {
  return catalog.map(entry => ({
    route: entry.route,
    service: entry.service,
    description: entry.description,
    price: String(process.env[entry.priceEnv] || entry.fallback),
    priceEnv: entry.priceEnv,
    cacheTier: entry.cacheTier,
    cacheTtlSeconds: CACHE_TIERS[entry.cacheTier],
    required: entry.required,
    defaults: entry.defaults || {},
    readOnly: true,
  }))
}

/**
 * Return a compact lookup map of provider-path → cache TTL seconds.
 */
export function getCacheTtlMap() {
  const map = {}
  for (const entry of catalog) {
    map[entry.provider] = CACHE_TIERS[entry.cacheTier]
  }
  return map
}
