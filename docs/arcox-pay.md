# ARCOX Pay

ARCOX Pay is a public USDC invoice and payment-link layer for Arc Testnet.

Today it supports:

- Create invoice/payment request.
- Checkout link: `/pay?invoice=INVOICE_ID`.
- Public USDC payment from user EOA wallet to merchant address.
- Invoice status and timeline.
- Circle Gateway webhook foundation.
- Developer sandbox at `/pay/sandbox`.

Current payment flow:

1. Merchant creates invoice with `POST /api/invoices`.
2. Buyer opens `paymentUrl`.
3. Buyer connects wallet.
4. Checkout shows payment preview.
5. Buyer confirms wallet transaction.
6. Invoice becomes `pending` after tx submit.
7. Invoice becomes `paid` after receipt confirmation or sandbox/webhook finalization.

ARCOX Pay does not store user private keys and does not take hidden fees from merchant invoice payments.
