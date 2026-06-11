# MCP Pay Tools

ARCOX MCP should expose invoice tools for AI agents:

- `arcox_create_payment_request`
- `arcox_get_payment_request`
- `arcox_quote_payment_request`
- `arcox_pay_payment_request`
- `arcox_check_payment_status`
- `arcox_simulate_circle_webhook`
- `arcox_quote_eco_route_payment`

Safety rules:

- Quote before execute.
- Human confirmation required before value movement.
- Reject expired invoices.
- Reject already paid invoices.
- Reject amount, token, or recipient mismatch after quote.
- Do not auto-execute from prompt.

Payment request example:

```json
{
  "amount": "10",
  "token": "USDC",
  "merchantAddress": "0xMerchant",
  "orderId": "ORDER-123",
  "memo": "AI agent setup service"
}
```
