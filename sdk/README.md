# ARCOX x402 SDK

Pay-per-request, read-only access to Arkham intelligence through the ARCOX
backend. Every paid resource returns an x402 invoice (HTTP 402); after payment
you retry with the `paymentId` to unlock the data. All resources are
**read-only** — the SDK and the backend never execute swaps, bridges, sends,
approvals, or contract calls.

## Install

No build step. Copy `arcox-x402.mjs` and `index.d.ts` into your project, or
import directly from the repo:

```js
import { createX402Client } from './sdk/arcox-x402.mjs'
```

Works in Node.js 18+ (global `fetch`) and modern browsers.

## Quick start

```js
import { createX402Client } from './sdk/arcox-x402.mjs'

const client = createX402Client({
  baseUrl: 'https://43.134.14.43.nip.io',
  ownerWallet: '0xYourActiveMSCA...',
  authToken: 'owner bearer token from your session',
})

// 1. Create an invoice for a resource
const { data } = await client.createInvoice('/api/intel/risk/address/0x1234...')
const invoice = data.invoice

// 2. Pay it with YOUR wallet/signing layer (direct USDC transfer to invoice.recipient)
await client.pay(invoice, async inv => {
  return transferUsdc({ to: inv.recipient, amount: inv.amount, chain: 'Arc' })
})

// 3. Wait for on-chain reconciliation
const paid = await client.waitForInvoice(invoice.invoiceId)

// 4. Unlock the data
const { data: result } = await client.unlock('/api/intel/risk/address/0x1234...', invoice.paymentId)
console.log(result.unlockedResult || result.data)
```

## API

| Method | Description |
|---|---|
| `config()` | Public x402 configuration (asset, recipient, limits) |
| `catalog()` | Free structured catalog of all paid Intel services + degraded flags |
| `providerHealth()` | Free Arkham circuit-breaker state per service group |
| `createInvoice(resource, opts?)` | Create an x402 invoice (owner-authenticated) |
| `paymentRequest(resource, opts?)` | Alias of `createInvoice` |
| `getInvoice(invoiceId)` | Reconcile + read invoice state |
| `getPaymentRequest(paymentId)` | Read a payment request by paymentId |
| `unlock(resource, paymentId)` | Fetch the paid resource data |
| `waitForInvoice(invoiceId, opts?)` | Poll until paid/expired/failed |
| `pay(invoice, transfer)` | Pass the invoice to your transfer function |
| `stats()` | Usage analytics (owner-gated) |
| `treasuryHealth()` | Treasury unified-balance health |
| `approvedRefunds()` | List auto-approved refunds |
| `refundLog()` | Refund audit log |
| `openApi()` | OpenAPI document for the full surface |

## Auth headers

- `Authorization: Bearer <ownerToken>` — minted from your active MSCA session
- `X-Arcox-Owner: 0x...` — the active MSCA wallet address
- `X-Arcox-Agent-Id` — optional agent identity binding
- `X-Payment-Id` — set automatically by `unlock()` for paid retries

## Abuse limits

Invoice creation is guarded per owner: max open (unpaid) invoices and an
optional creation cooldown. `createInvoice` returns HTTP 429 when a limit is
hit — pay or wait for expiry before requesting more.

## Refunds

If the provider fails after payment (timeout/5xx = `provider_error`,
404 = `provider_not_found`), the invoice is marked refund-eligible. The
auto-refund worker approves it after a cooldown and executes the USDC refund
back to your wallet from the treasury Unified Balance. Track the pipeline via
`approvedRefunds()` / `refundLog()`.
