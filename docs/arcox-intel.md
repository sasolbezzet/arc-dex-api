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
- `GET /api/intel/tx/:hash`
- `GET /api/intel/tx/:hash/transfers`
- `GET /api/intel/search?query=`
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
- `GET /api/intel/token/trending`
- `GET /api/intel/token/top`
- `GET /api/intel/report/address/:address`

MCP dedicated read-only tools:

- `arcox_intel_get_flows`
- `arcox_intel_get_history`
- `arcox_intel_get_volume`
- `arcox_intel_get_counterparties`
- `arcox_intel_get_transfers`

x402 example:

```bash
curl -i https://API_BASE/api/intel/address/0x...
curl -i https://API_BASE/api/intel/address/0x... -H "X-PAYMENT: mock-paid"
```
