# Circle Gateway Nanopayments Readiness

ARCOX Pay currently supports public USDC invoices/payment links on Arc Testnet. Circle Gateway Nanopayments are prepared as an x402-ready future rail for premium API calls, not as a hidden fee on merchant invoices.

## Circle Model

Circle Gateway Nanopayments use x402 and batched settlement:

1. Buyer deposits USDC into a Gateway Wallet contract.
2. Buyer requests a paid API/resource.
3. Seller API responds with `402 Payment Required`.
4. Buyer signs an offchain EIP-3009 authorization.
5. Buyer retries with the authorization proof.
6. Seller verifies the proof and serves the resource.
7. Gateway settles signed authorizations in batches.

## ARCOX Current Implementation

- `withX402PaymentRequired` can return a request-bound HTTP `402`.
- The response includes `protocol: "x402"`, `paymentRail: "circle-gateway-nanopayments"`, and `authorizationType: "EIP-3009"`.
- Proofs are bound to amount, token, network, recipient, resource, and requestId.
- Used proof/requestId values are stored to reduce replay risk.
- `X402_ENABLED=false` by default.
- `GET /api/nanopayments/capabilities` reports current readiness and safety notes.

## Not Live Yet

The API does not yet perform production Circle Gateway Nanopayments settlement. Do not claim gas-free nanopayments are live until a production verifier/settler is wired and tested.

## Safety Rules

- ARCOX Pay invoice endpoints stay free/basic.
- Merchant invoice payment amounts are never reduced by x402 fees.
- Private keys are never requested or stored by the API.
- Payment proofs must be request-bound and replay protected.
