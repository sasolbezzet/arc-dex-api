# Sandbox Testing

1. Start API locally.
2. Start DEX locally.
3. Open `/pay/sandbox`.
4. Create invoice.
5. Open payment link.
6. Check invoice status.
7. Simulate `gateway.deposit.finalized`.
8. Simulate `gateway.mint.forwarded`.
9. Simulate `gateway.mint.finalized`.
10. Confirm invoice becomes `paid`.
11. Send duplicate webhook and confirm it does not double-process.
12. Test expired invoice.
13. Test Eco route preview in mock mode.
14. Confirm x402 middleware is disabled by default.
15. Read privacy roadmap and confirm it does not claim live privacy.

Dev webhook simulator requires:

```text
ENABLE_DEV_TOOLS=true
```
