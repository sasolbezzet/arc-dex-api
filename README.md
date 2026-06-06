# ARCOX DEX API

Backend retail proxy untuk ARCOX DEX.

## Tanggung Jawab

- Circle proxy wallet lookup dan action.
- Quote/swap/send/bridge preparation untuk web UI dan agent.
- `wallets-db.json` sebagai mapping owner ke Circle wallet proxy.
- `tx-history-db.json` sebagai history transaksi web UI dan agent.

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
