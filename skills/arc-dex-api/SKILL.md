---
name: arc-dex-api
version: 1.0.0
description: Operate and verify the ARCOX DEX API per-agent MSCA isolation model safely.
---

# ARCOX DEX API — Per-agent MSCA

## Model

- One owner identity may have multiple Agent Wallets (MSCA).
- Every agent binding is keyed by `agentKey = <clientId>|<ownerId>`.
- The OAuth token is authoritative for `mscaWalletAddress`; never infer an agent wallet from a global owner alias.
- `clientId`, wallet address, activity labels, daily spend, cards, and revoke state are scoped to that agent.
- Legacy aliases remain for compatibility with old tokens; never delete them as part of an agent migration.

## Owner-only management

The following endpoints require a passkey/SIWE vault session (`arx_vs_*`), not an MCP bearer:

- `GET /api/vault/agents`
- `GET /api/vault/agents/:agentKey/activity`
- `GET /api/vault/cards`
- `GET /api/vault/agents/:agentKey/cards`
- `POST /api/vault/agents/:agentKey/cards`
- `DELETE /api/vault/cards/:cardId/agent-link`
- `POST /api/vault/agents/:agentKey/connection-token`
- `DELETE /api/vault/agents/:agentKey`

An OAuth/MCP token must receive `403 owner_authentication_required` on owner-management routes. Card links store only card metadata and limits; PAN/CVV must never enter an agent token or audit record.

## Agent connection choices

1. **Hermes device flow:** `hermes mcp login arcox`, approve the displayed code in the ARCOX web UI, then start a new Hermes session.
2. **Hermes default/header flow:** the owner creates a connection token in the plugin and gives the token message to the agent. The agent runs `hermes mcp add arcox --url <mcp-url> --auth header`, probes `initialize` and `tools/list`, and starts a new session.
3. **Local legacy EOA:** `EOA_PRIVATE_KEY` remains optional and local-only for the existing local agent path. An empty key must not create an EOA wallet block.

Never put an MSCA private key, session token, or connection token in a repository `.env`, a frontend build, or a shared log.

## Execution safety

- Value-moving MCP operations quote first and require explicit `confirmed: true`/`yes`/`ya`.
- `dailyLimit` is evaluated per `agentKey`; a rejection is `daily_limit_exceeded` and must not block another agent of the same owner.
- Successful spend is recorded in the per-agent ledger; failed or preview-only operations are not spend.
- Audit events should carry `agentClientId` (and, when available, `agentKey`).
- Revoke removes the binding and all access/refresh tokens for that client. A rotated connection token invalidates only the previous connection token for the same connection client.

## Safe verification order

1. L0: `npm test` in `arc-dex-api` and unit tests with temporary data paths.
2. L1: staging `:3901`, isolated `data-staging`, HTTP endpoint and revoke tests.
3. L2/L2B: two Hermes homes, two client IDs, two MSCA addresses, device flow and header-token tools/list.
4. L3: production read-only metadata/401/tools-list smoke only after an approved deploy.
5. L4: production transaction only after the owner explicitly says `ya` for that transaction.

Guard E2E scripts against production URLs. Use `BASE=http://localhost:3901` and verify the staging process owns port `3901` before running.

## Staging service

Install the tracked `arc-dex-api-staging.service` as `/etc/systemd/system/arc-dex-api-staging.service`. It uses separate data paths and `SERVER_URL=http://localhost:3901`; it is intentionally not enabled at boot.

```bash
sudo systemctl daemon-reload
sudo systemctl start arc-dex-api-staging
curl -fsS http://127.0.0.1:3901/health
```

## Production operations

Production runs under systemd (`arc-dex-api.service`), not an ad-hoc shell process. Deploy only after the L0–L2 gates are green; restart the service, verify health and the owning PID, then inspect recent journal output. Rollback is a code revert plus service restart; do not roll runtime JSON state backwards.

## OAuth purge

Run `node scripts/purge-test-oauth-state.mjs` without flags first. It is read-only. Review every candidate. Apply requires an explicit confirmation and whitelist, and is a production data operation; do not run apply automatically or during an E2E test.
