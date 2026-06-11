# Circle Gateway Webhooks

Endpoint:

```text
POST /api/webhooks/circle-gateway
```

Supported event types:

- `gateway.deposit.finalized`
- `gateway.mint.forwarded`
- `gateway.mint.finalized`

Processing rules:

- Store raw payload before processing.
- Deduplicate by `notificationId`, `id`, or event id.
- Match invoice by `invoiceId`, `txHash`, `memo`, `reference`, or metadata.
- Return `200 OK` even when invoice matching fails.
- Never expose Circle API keys.

Status mapping:

- `gateway.deposit.finalized` -> `pending`
- `gateway.mint.forwarded` -> `pending`
- `gateway.mint.finalized` -> `paid`

TODO:

- Add Circle webhook signature verification once the exact Gateway signature header and secret format are configured.
