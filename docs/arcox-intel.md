# ARCOX Intel

ARCOX Intel exposes Arkham API-backed intelligence through `arc-dex-api` and ARCOX x402. All Intel and transaction-lookup tools are read-only; they never submit swaps, bridges, sends, buys, sells, or contract transactions.

Important:

- `ARKHAM_API_KEY` is stored only in `arc-dex-api` environment.
- Frontend and MCP never receive or store `ARKHAM_API_KEY`.
- MCP calls ARCOX API routes, not Arkham directly.
- x402 is the payment gate for paid intelligence routes.
- If `X402_VERIFY_PAYMENT=false`, development/testnet can use `X-PAYMENT: mock-paid`.
- Results are informational only and not financial advice.

Endpoints:

- `GET /api/intel/address/:address`
- `GET /api/intel/address/:address/all`
- `GET /api/intel/address/:address/enriched`
- `GET /api/intel/address/:address/balances`
- `GET /api/intel/address/:address/counterparties`
- `GET /api/intel/address/:address/flows`
- `GET /api/intel/address/:address/history`
- `GET /api/intel/address/:address/volume`
- `GET /api/intel/address/:address/portfolio`
- `GET /api/intel/risk/address/:address`
- `GET /api/intel/risk/address/:address/paths`
- `GET /api/intel/loans/address/:address`
- `GET /api/intel/loans/entity/:entity`
- `GET /api/intel/risk/entity/:entity`
- `GET /api/intel/intelligence/entity/:entity/predictions`
- `GET /api/intel/chains`
- `GET /api/intel/networks/status`
- `GET /api/intel/networks/history/:chain`
- `GET /api/intel/arkm/circulating`
- `GET /api/intel/marketdata/altcoin-index`
- `GET /api/intel/cluster/:id/summary`
- `GET /api/intel/tx/:hash`
- `GET /api/intel/tx/:hash/transfers`
- `GET /api/intel/transfers`
- `GET /api/intel/transfers/unenriched`
- `GET /api/intel/transfers/histogram`
- `GET /api/intel/swaps` (historical data only)
- `GET /api/intel/search?query=`
- `GET /api/intel/portfolio/time-series/address/:address`
- `GET /api/intel/portfolio/time-series/entity/:entity`
- `GET /api/intel/contract/:chain/:address`
- `GET /api/intel/entity/:entity`
- `GET /api/intel/entity/:entity/summary`
- `GET /api/intel/entity/:entity/balances`
- `GET /api/intel/entity/:entity/counterparties`
- `GET /api/intel/entity/:entity/flows`
- `GET /api/intel/entity/:entity/history`
- `GET /api/intel/entity/:entity/volume`
- `GET /api/intel/entity/:entity/portfolio`
- `GET /api/intel/token/:id`
- `GET /api/intel/token/:id/market`
- `GET /api/intel/token/:id/holders`
- `GET /api/intel/token/:id/top-flow`
- `GET /api/intel/token/:id/price-history`
- `GET /api/intel/token/:id/price-change`
- `GET /api/intel/token/:id/volume`
- `GET /api/intel/token/:chain/:address/price-history`
- `GET /api/intel/token/:chain/:address/volume`
- `GET /api/intel/token/trending`
- `GET /api/intel/token/trending/:id`
- `GET /api/intel/token/top`
- `GET /api/intel/token/addresses/:id`
- `GET /api/intel/token/balance/:id`
- `GET /api/intel/token/balance/:chain/:address`
- `GET /api/intel/token/arkham-exchange-tokens`
- `GET /api/intel/balances/solana/subaccounts/address/:addresses`
- `GET /api/intel/balances/solana/subaccounts/entity/:entities`
- `GET /api/intel/tag/:id/params`
- `GET /api/intel/tag/:id/summary`
- `GET /api/intel/hypercore/*` (market, account, entity, position, and trade reads)
- `GET /api/intel/polymarket/*` (market, wallet, position, and activity reads)
- `GET /api/intel/report/address/:address`

Service catalog (free, no x402 payment required):

- `GET /api/intel/catalog` — structured list of all Intel services, prices, cache tiers, required parameters, defaults, and circuit-breaker `degraded` flags.
- `GET /api/intel/provider-health` — per-service Arkham circuit-breaker state (closed/open/half-open) with failure counts.

Provider circuit breaker:

- A service that fails at the provider (5xx/timeout) `ARCOX_INTEL_CIRCUIT_FAILURES` times inside the window is opened; fresh requests return 503 (refund-eligible for paid invoices) instead of charging again.
- After the cooldown the service is probed half-open; success closes it, another failure reopens it. 404s never trip the breaker.
- The catalog marks degraded services `degraded: true` so agents can check before paying.

Cache TTL per service:

- `static` (1 hour): chains, ARKM circulating, tag params/summary
- `slow` (30 min): network status, altcoin index, risk score
- `default` (10 min): balances, portfolio, token intelligence
- `dynamic` (2 min): flows, transfers, swaps, HyperCore trades, Polymarket activity

Auto-refund worker:

- Paid invoices with `provider_not_found` or `provider_error` are automatically marked `refund_approved` after a cooling-off period.
- Approved refunds are then **executed automatically**: USDC is sent back to the payer from the treasury Unified Balance via the delegated spend path (no raw treasury private key), then the invoice is marked `refunded` with the tx hash.
- Guards: `X402_REFUND_EXECUTE_ENABLED`, daily cap `X402_REFUND_DAILY_CAP_USDC`, max per-refund `X402_MAX_AUTO_REFUND_USDC`, and max attempts before `refund_failed_manual`.
- Refund-farming guard: when one owner accumulates `X402_REFUND_FARM_LIMIT` provider-failure refunds in a window, further refunds go to `manual_review` instead of auto-approval.
- `GET /api/x402/refunds/approved` — list approved refunds
- `GET /api/x402/refunds/log` — audit log of refund decisions
- `POST /api/x402/refunds/scan` — trigger a manual scan
- `POST /api/x402/refunds/:invoiceId/execute` — execute an approved refund immediately (owner-gated)
- `POST /api/x402/refunds/:invoiceId/complete` — mark a refund as completed manually with txHash

Anti-abuse per owner:

- `X402_MAX_UNPAID_PER_OWNER` (default 10) caps open invoices per wallet; `X402_INVOICE_COOLDOWN_MS` optionally adds a minimum delay between invoice creations. Violations return HTTP 429.

Analytics + treasury:

- `GET /api/x402/stats` (owner-gated) — revenue, invoices by status, per-service usage, provider errors, refund pipeline state.
- `GET /api/x402/treasury-health` — treasury Unified Balance across chains vs `X402_MIN_TREASURY_USDC`; when degraded and `X402_BLOCK_ON_LOW_TREASURY=true`, new invoice creation returns 503 until the balance recovers. `monitor.sh` alerts on the same endpoint.
- `GET /api/x402/openapi.json` — OpenAPI 3.0 document for the whole x402 + Intel surface.

Client SDK:

- `sdk/arcox-x402.mjs` + `sdk/index.d.ts` — invoice lifecycle, unlock, wait-for-paid, stats, refunds, catalog. See `sdk/README.md`.

MCP dedicated read-only tools:

- `arcox_intel_get_flows`
- `arcox_intel_get_history`
- `arcox_intel_get_volume`
- `arcox_intel_get_counterparties`
- `arcox_intel_get_transfers`
- `arcox_intel_get_risk`
- `arcox_intel_get_loans`
- `arcox_intel_get_network`
- `arcox_intel_get_global_transfers`
- `arcox_intel_get_swaps`
- `arcox_intel_get_portfolio_series`
- `arcox_intel_get_market`
- `arcox_intel_get_solana_subaccounts`
- `arcox_intel_get_hypercore`
- `arcox_intel_get_polymarket`

Excluded by design: Arkham alert/entity/label mutations and WebSocket session lifecycle. Historical swap/transfer analytics are read-only and do not execute blockchain actions.

x402 example:

```bash
curl -i https://API_BASE/api/intel/address/0x...
curl -i https://API_BASE/api/intel/address/0x... -H "X-PAYMENT: mock-paid"
```
