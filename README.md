# ARCOX DEX API

Backend retail proxy untuk ARCOX DEX.

## Tanggung Jawab

- Circle proxy wallet lookup dan action.
- Quote/swap/send/bridge preparation untuk web UI dan agent.
- ARCOX Pay invoice/payment request API untuk public USDC payment link di Arc Testnet.
- Circle Gateway webhook foundation dan dev simulator.
- Eco route preview untuk future cross-chain stablecoin invoice.
- x402 middleware untuk premium API endpoint memakai real Arc Testnet USDC invoice.
- Arc Transaction Memo reconciliation untuk x402 payment dengan chunked `eth_getLogs` (8k block range per request) untuk menghormati batas 10k RPC.
- Reconcile invoice yang sudah `expired` tetap diproses jika ada bukti pembayaran on-chain (memo transfer atau Gateway record).
- `wallets-db.json` sebagai mapping owner ke Circle wallet proxy.
- `tx-history-db.json` sebagai history transaksi web UI dan agent.
- `invoices-db.json` sebagai invoice/payment request runtime storage.
- `webhook-events-db.json` sebagai webhook raw event/idempotency storage.
- Atomic JSON writes dengan `.bak` dan `runtime-backups/` untuk mengurangi risiko corrupt file saat crash.

## Bukan Tanggung Jawab

- Frontend React ada di `/home/ubuntu/arc-dex`.
- MCP, terminal agent, CLI, router deploy tooling ada di `/home/ubuntu/arcox-mcp`.
- Jangan simpan private key user browser wallet di API.

## File Runtime Penting

```text
.env
wallets-db.json
tx-history-db.json
invoices-db.json
webhook-events-db.json
runtime-backups/
```

File DB JSON adalah state runtime lokal. Backup sebelum migrasi atau reset server. Untuk production serius, migrasi berikutnya tetap disarankan ke PostgreSQL/SQLite managed migration; atomic JSON backup ini adalah mitigasi VPS testnet.

## VPS Deployment

PM2:

```bash
cd /home/ubuntu/arc-dex-api
npm install
mkdir -p logs runtime-backups
pm2 start ecosystem.config.cjs
pm2 save
```

Restart setelah update:

```bash
cd /home/ubuntu/arc-dex-api
git pull
pm2 restart arc-dex-api
```

Direct fallback:

```bash
node --env-file=.env server.mjs
```

## ARCOX Pay

ARCOX Pay adalah USDC payment request dan invoice layer untuk Arc. Fitur yang disiapkan:

- Payment links dan checkout page.
- Invoice status/timeline.
- Circle Gateway webhook foundation.
- Pay status console di `/pay/status`.
- Unified Balance / Circle Gateway payment readiness.
- MCP compatibility.
- x402 monetization memakai Arc Testnet USDC.
- ARCOX Intel API: selected Arkham-backed intelligence endpoints protected by x402.
- Future Circle Gateway Nanopayments readiness.

Yang real sekarang: public USDC invoice/payment link di Arc Testnet.

Yang future: production Eco routing penuh, gas-free nanopayments batch settlement, dan privacy/private payment.

ARCOX Intel:

- Backend only: `ARKHAM_API_KEY` belongs in `arc-dex-api` env.
- Frontend and MCP call `/api/intel/*`; they never call Arkham directly.
- x402 payment memakai exact USDC amount, 6 decimals, Arc Transaction Memo, dan on-chain reconciliation.
- See `docs/arcox-intel.md`.

## ARCOX AI Router

ARCOX AI Router adalah OpenAI-compatible API layer yang dibayar per request dari Unified Balance user melalui Auto Pay. Flow retail:

OpenAI-compatible `tools`, `tool_choice`, and `parallel_tool_calls` are forwarded unchanged to tool-capable upstream providers. When a provider rejects tool calling, the router can fall back to another configured provider without reducing the Hermes tool schema.

```text
Connect wallet -> Deposit USDC to Unified Balance -> Auto Pay ON -> Create API Key -> Use /v1/chat/completions
```

Endpoint:

```text
GET  /api/ai-router/status?ownerAddress=0x...
POST /api/ai-router/auto-pay
POST /api/ai-router/api-keys
POST /api/ai-router/api-keys/:id/revoke
POST /api/ai-router/api-keys/:id/rotate
GET  /api/ai-router/models
GET  /api/ai-router/usage?ownerAddress=0x...
GET  /v1/models
POST /v1/chat/completions
```

OpenAI-compatible config:

```text
base_url = https://arcoxdex.vercel.app/v1
api_key = arx_sk_...
model = arcox/auto
```

Security:

- API key format `arx_sk_...`.
- Backend stores only SHA-256 hash, never plain API key.
- Provider API keys stay only in backend env.
- AI Router charges only at request time through Auto Pay Unified Balance spend.
- User funds stay in user Unified Balance until each AI request is paid.
- If Unified Balance is insufficient, `/v1/chat/completions` returns HTTP 402 with “Please deposit more USDC to Unified Balance”.
- If Auto Pay is not ready, `/v1/chat/completions` returns HTTP 402 with “Enable Auto Pay first”.

Provider env example:

```text
AI_PROVIDER_1_NAME=NVIDIA
AI_PROVIDER_1_BASE_URL=https://integrate.api.nvidia.com/v1
AI_PROVIDER_1_API_KEY=
AI_PROVIDER_1_MODEL=openai/gpt-oss-120b
AI_PROVIDER_2_NAME=NVIDIA
AI_PROVIDER_2_BASE_URL=https://integrate.api.nvidia.com/v1
AI_PROVIDER_2_API_KEY=
AI_PROVIDER_2_MODEL=nvidia/nemotron-3-super-120b-a12b
```

Circle Gateway Nanopayments gas-free belum live. ARCOX memakai response `402 Payment Required`, invoice internal, dan Arc USDC memo payment:

```text
GET /api/nanopayments/capabilities
```

## Env Tambahan

```text
ARCOX_PAY_BASE_URL=https://arcoxdex.vercel.app
ENABLE_DEV_TOOLS=false
CIRCLE_API_KEY=
CIRCLE_WEBHOOK_SECRET=
CIRCLE_ENVIRONMENT=TEST
CIRCLE_BASE_URL=https://api-sandbox.circle.com
CIRCLE_ENV=TEST
ECO_ENVIRONMENT=TEST
ECO_API_BASE_URL=
ECO_LIVE_ROUTES=false
ECO_DAPP_ID=arcox-pay
ECO_QUOTES_API_URL=https://quotes.eco.com/api/v3/quotes/single
X402_ENABLED=true
X402_MODE=arc_real_testnet
X402_ASSET=USDC
X402_CHAIN_ID=5042002
X402_USDC_ADDRESS=0x3600000000000000000000000000000000000000
X402_BASE_AMOUNT=0.005
X402_PAYMENT_TTL_SECONDS=300
X402_RECONCILE_LOOKBACK_BLOCKS=8000
ARC_RPC_URL=https://rpc.testnet.arc.network
CIRCLE_X402_TREASURY_WALLET_ID=
CIRCLE_X402_NETWORK=arc-testnet
ARC_MEMO_CONTRACT=0x5294E9927c3306DcBaDb03fe70b92e01cCede505
ARCOX_TREASURY_WALLET_ADDRESS=
ARCOX_SOLANA_TREASURY_ADDRESS=
AI_ROUTER_DELEGATE_ADDRESS=
AI_ROUTER_DEFAULT_COST_USDC=0.001
AI_ROUTER_DEFAULT_MAX_PER_REQUEST_USDC=0.02
AI_PROVIDER_VALIDATE_MODELS=true
AI_PROVIDER_1_NAME=
AI_PROVIDER_1_BASE_URL=
AI_PROVIDER_1_API_KEY=
AI_PROVIDER_1_MODEL=
```

`ARCOX_TREASURY_WALLET_ADDRESS` adalah penerima tunggal untuk fee backend,
AI Router, dan x402. Setelah menggantinya, restart proses backend. Router EVM
yang sudah ter-deploy menyimpan treasury on-chain; owner juga harus memanggil
`setTreasury(address)` pada setiap router agar fee kontrak mengikuti alamat baru.

## Testing Singkat

1. Start API dan DEX.
2. Buka `/pay/status`.
3. Create invoice.
4. Bayar exact Arc USDC via wallet memo.
5. Cek invoice status sampai `paid`.
6. Retry Intel request memakai `X-PAYMENT-ID`.

Catatan teknis:

- RPC `rpc.testnet.arc.network` adalah RPC publik yang sinkron dan direkomendasikan. Jangan pakai `arc-node.thecanteenapp.com` karena tertinggal ~1 blok dan menyebabkan nonce konflik.
- `eth_getLogs` pada RPC publik dibatasi 10,000 block range per request. Backend memecah lookback menjadi chunk 8,000 block untuk menghindari error.
- Invoice yang sudah `expired` tetap di-reconcile jika ada bukti pembayaran on-chain (memo atau Gateway). Ini mencegah dana terkunci saat TTL 300 detik berlalu sebelum reconcile sempat berjalan.
- PM2 membutuhkan `--update-env` setelah mengubah `.env` agar env baru dimuat. Tanpa ini, process restart dengan env lama.
- Hati-hati zombie process: pastikan tidak ada process lama yang masih mendengarkan di port 3001 sebelum start backend baru.
# ARCOX API keys

AI Router uses standard `arx_sk_...` bearer keys with the OpenAI-compatible production base URL. Keys are shown once, stored only as hashes, and can be revoked from the connected owner wallet.

Set model prices only in `arc-dex-api/.env` with `AI_ROUTER_MODEL_PRICE_DEFAULT_USDC` and the JSON map `AI_ROUTER_MODEL_PRICES_USDC`. Client-provided prices are ignored. The local proxy supplies an idempotency key so a retried identical request is not charged twice.
