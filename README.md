# ARCOX DEX API

Backend retail proxy untuk ARCOX DEX.

## Tanggung Jawab

- Circle proxy wallet lookup dan action.
- Quote/swap/send/bridge preparation untuk web UI dan agent.
- ARCOX Pay invoice/payment request API untuk public USDC payment link di Arc Testnet.
- Circle Gateway webhook foundation dan dev simulator.
- Eco route preview mock mode untuk future cross-chain stablecoin invoice.
- x402-ready middleware untuk premium API endpoint, disabled by default.
- `wallets-db.json` sebagai mapping owner ke Circle wallet proxy.
- `tx-history-db.json` sebagai history transaksi web UI dan agent.
- `invoices-db.json` sebagai invoice/payment request runtime storage.
- `webhook-events-db.json` sebagai webhook raw event/idempotency storage.

## Bukan Tanggung Jawab

- Frontend React ada di `/home/ubuntu/arc-dex`.
- MCP, terminal agent, CLI, router deploy tooling ada di `/home/ubuntu/arcox-mcp`.
- Jangan simpan private key user browser wallet di API.

## File Runtime Penting

```text
.env
wallets-db.json
tx-history-db.json
```

File DB JSON adalah state runtime lokal. Backup sebelum migrasi atau reset server.

## ARCOX Pay

ARCOX Pay adalah USDC payment request dan invoice layer untuk Arc. Fitur yang disiapkan:

- Payment links dan checkout page.
- Invoice status/timeline.
- Circle Gateway webhook foundation.
- Sandbox/API viewer di `/pay/sandbox`.
- Eco adapter mock mode.
- MCP compatibility.
- Future x402 monetization.

Yang real sekarang: public USDC invoice/payment link di Arc Testnet.

Yang mock/future: production Eco routing, x402 berbayar aktif, dan privacy/private payment.

## Env Tambahan

```text
ARCOX_PAY_BASE_URL=https://arc-dex-bice.vercel.app
ENABLE_DEV_TOOLS=false
CIRCLE_API_KEY=
CIRCLE_WEBHOOK_SECRET=
CIRCLE_ENVIRONMENT=TEST
ECO_ENVIRONMENT=TEST
ECO_API_BASE_URL=
ECO_LIVE_ROUTES=false
ECO_DAPP_ID=arcox-pay
ECO_QUOTES_API_URL=https://quotes.eco.com/api/v3/quotes/single
X402_ENABLED=false
X402_FEE_WALLET=
X402_DEFAULT_TOKEN=USDC
X402_DEFAULT_NETWORK=arc-testnet
```

## Testing Singkat

1. Start API dan DEX.
2. Buka `/pay/sandbox`.
3. Create invoice.
4. Buka payment link.
5. Cek invoice status.
6. Simulate `gateway.deposit.finalized`.
7. Simulate `gateway.mint.forwarded`.
8. Simulate `gateway.mint.finalized`.
9. Pastikan invoice menjadi `paid`.
10. Kirim webhook duplikat dan pastikan tidak double-process.
