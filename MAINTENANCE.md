# Maintenance

- `server.mjs` owns HTTP wiring; reusable logic belongs in `src/routes`, `src/services`, or `src/middleware`.
- Runtime JSON databases and their `.bak` files are state. Do not delete active databases while the API is running.
- Run `npm run maintenance:prune -- --apply` to retain the newest runtime backups per database.
- Validate changes with `npm test`. Secrets belong only in `.env` and must never be logged or committed.

## Per-agent MSCA operations

A single owner identity may have multiple Agent Wallets. Each connection is isolated by `agentKey = <clientId>|<ownerId>`; the OAuth token's `mscaWalletAddress` is the source of truth. Do not use a global owner alias to select an agent wallet.

Owner-only management uses a passkey/SIWE vault session (`arx_vs_*`):

- `GET /api/vault/agents`
- `GET /api/vault/agents/:agentKey/activity`
- `POST /api/vault/agents/:agentKey/connection-token`
- `DELETE /api/vault/agents/:agentKey`
- card link/list/unlink routes under `/api/vault/agents/:agentKey/cards` and `/api/vault/cards`

An MCP bearer token must receive `403 owner_authentication_required` on these routes. Card links contain only masked metadata and limits; never log or persist PAN/CVV in agent state.

## Verification gates

Run in order: L0 unit/regression → L1 HTTP staging → L2 two-Hermes device flow → L2B default Hermes header-token flow → L3 production read-only smoke → L4 live transaction only after explicit owner approval.

Staging uses the tracked `arc-dex-api-staging.service` with `SERVER_URL=http://localhost:3901` and separate `data-staging/*` files. It is intentionally not enabled at boot:

```bash
sudo systemctl daemon-reload
sudo systemctl start arc-dex-api-staging
curl -fsS http://127.0.0.1:3901/health
```

Never point E2E scripts at production. Confirm the URL is localhost/127.0.0.1 and confirm the process owns port 3901.

## Production deploy and rollback

Production is managed by `arc-dex-api.service`:

```bash
npm test
sudo systemctl restart arc-dex-api
curl -fsS http://127.0.0.1:3001/health
ss -ltnp | grep ':3001'
journalctl -u arc-dex-api -n 50 --no-pager
```

Deploy only after review and the staging gates. Roll back the code with a reviewed Git revert, restart the same systemd unit, and keep runtime JSON state unchanged because the agent-binding format is additive.

## OAuth test-state purge

`node scripts/purge-test-oauth-state.mjs` is dry-run by default and prints only masked token IDs. Review its complete candidate list before any apply. Apply is a separate production data operation requiring `--confirm PURGE` and explicit `--allow-client`/`--allow-token` flags; do not run it from automated tests or a deploy hook.
