# Mainnet Security Baseline

ARCOX uses separate trust domains:

- Backend/provider and delegated-spend credentials: `~/arc-dex-api/.env`, mode `600`.
- User wallet, device-session, and local API credentials: `~/.arcox/agent.env`, mode `600`.
- The backend must never receive a user wallet private key.

Controls implemented:

- API Pass SBT and owner/device session verification.
- Exact wallet and Agent Identity binding before MCP value-moving actions.
- Preview and explicit confirmation before local transactions.
- Fixed ARCOX treasury recipient for delegated AI payments.
- Per-request, total-debit, daily, monthly, and per-minute limits.
- Per-owner payment serialization and idempotent retries.
- Hash-only API/session credentials and short session TTLs.
- Runtime files created with owner-only permissions.

Production launch still requires an external contract audit, an HSM/KMS-backed delegate signer, durable encrypted storage, monitored reconciliation, and incident-response procedures.
