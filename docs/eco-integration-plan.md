# Eco Integration Plan

Eco is useful for ARCOX Pay because it can eventually let a buyer pay from another chain while the merchant receives USDC on Arc.

Future flow:

1. Merchant creates Arc invoice.
2. Buyer selects source chain and token.
3. ARCOX requests an Eco route or programmable address.
4. Buyer pays on the source chain.
5. Eco orchestration routes value to Arc.
6. ARCOX updates invoice status through webhook/status checks.

Implemented now:

- `POST /api/eco/route-preview`
- `services/ecoAdapter.mjs`
- Structured route preview works without an Eco API key.
- Optional public no-auth Eco V3 quote call when `ECO_LIVE_ROUTES=true`.
- `dAppID` attribution through `ECO_DAPP_ID`.

Mock/future work:

- Live Eco route creation.
- Programmable address creation.
- Production status checks.
- Binding route id to invoice id, amount, token, and recipient.
- Wallet approval to `contracts.sourcePortal`.
- Portal `publishAndFund` execution with `quoteResponse.encodedRoute`.

Eco adapter must remain clearly labeled experimental until ARCOX supports full quote validation, wallet approval, Portal `publishAndFund`, intent tracking, and refund handling.
