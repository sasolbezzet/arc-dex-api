# x402 Monetization

x402 support is for premium ARCOX API endpoints. It is not for secretly taking funds from merchant payments.

Disabled by default:

```text
X402_ENABLED=false
X402_FEE_WALLET=
X402_DEFAULT_TOKEN=USDC
X402_DEFAULT_NETWORK=arc-testnet
```

Free endpoints:

- Basic invoice creation.
- Basic invoice status.
- Checkout page.

Potential premium endpoints:

- `POST /api/agent/action-plan`
- `POST /api/transaction/replay`
- `POST /api/eco/route-preview`
- `GET /api/webhook-events/:invoiceId`
- `POST /api/advanced-simulation`

Security design:

- Payment proof is bound to resource.
- Payment proof is bound to amount.
- Payment proof is bound to recipient.
- Payment proof is bound to request id.
- Used proof/request id is stored to prevent replay.

Current implementation is middleware-ready and disabled unless `X402_ENABLED=true`.

## Circle Gateway Nanopayments Alignment

ARCOX x402 responses are shaped for Circle Gateway Nanopayments:

- `protocol: "x402"`
- `paymentRail: "circle-gateway-nanopayments"`
- `authorizationType: "EIP-3009"`
- `settlement.mode: "batched"`

This is readiness metadata only. Production Gateway Nanopayments settlement is not live until ARCOX wires a real Circle-compatible verifier/settlement pipeline.

## Supabase Integration

### Session metadata — Supabase-primary reads

`GET /api/session/status` merges the Supabase `session_metadata` snapshot
(Supabase-primary) with the local record. Local activation state always wins;
a remote-only result is a display-only recovery view that is never surfaced
as active (without the local encrypted-key store the session cannot sign).
Auth-gating reads (`getSessionKeyInfo`) intentionally stay local-only and
never touch the network. Roll back with
`SUPABASE_SESSION_METADATA_READ_PRIMARY=false`.

### Refund audit log — Supabase-primary

Every refund decision (pending_review, refund_approved, refund_manual_review,
refund_executed, refund_execute_failed, refund_completed, skipped_*) is
written to `public.refund_audit_log` (migration:
`supabase/migrations/20260822000001_refund_audit_log.sql`) through the
dual-write queue, idempotent per (invoiceId, action, at).
`GET /api/x402/refunds/log` reads Supabase-primary with the in-memory log as
fallback (including before the table exists). The per-invoice `refundTimeline`
and the in-memory log remain the offline fallback.
