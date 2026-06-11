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
