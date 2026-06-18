# ARCOX Intel

ARCOX Intel exposes selected Arkham API-backed intelligence endpoints through `arc-dex-api`.

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
- `GET /api/intel/tx/:hash`
- `GET /api/intel/tx/:hash/transfers`
- `GET /api/intel/search?q=`
- `GET /api/intel/contract/:chain/:address`
- `GET /api/intel/entity/:entity`
- `GET /api/intel/token/:id`
- `GET /api/intel/report/address/:address`

x402 example:

```bash
curl -i https://API_BASE/api/intel/address/0x...
curl -i https://API_BASE/api/intel/address/0x... -H "X-PAYMENT: mock-paid"
```
