# Maintenance

- `server.mjs` owns HTTP wiring; reusable logic belongs in `src/routes`, `src/services`, or `src/middleware`.
- Runtime JSON databases and their `.bak` files are state. Do not delete active databases while the API is running.
- Run `npm run maintenance:prune -- --apply` to retain the newest runtime backups per database.
- Validate changes with `npm test`. Secrets belong only in `.env` and must never be logged or committed.

## Active Arc network (testnet ↔ mainnet)

`src/config/arcNetwork.mjs` is the single source of truth for the active Arc
network. Everything else (chain id, RPC, explorer, transport slug, tokens,
Circle contracts, Gateway base URL/chain name, MSCA chain support) is derived
from it:

```bash
ARC_NETWORK=mainnet   # atau ARC_CHAIN_ID=5042; default testnet bila kosong
```

Rules that must stay true when editing network code:

- Never read a mainnet ARCOX contract from a testnet value. `arcContractAddress(name)`
  only accepts `<NAME>_MAINNET` on mainnet and returns `null` otherwise, so features
  fail closed with `arcContractMissingMessage()` instead of sending a transaction to a
  testnet address.
- Never read a Circle key across environments: `arcCircleApiKey()`/`arcCircleClientKey()`
  return the LIVE key on mainnet with no sandbox fallback.
- State is separated by chain key (`arc-testnet` vs `arc-mainnet`); session keys,
  agent bindings, and invoices never mix between networks.
- The installed Circle SDK (`@circle-fin/app-kit`, `@circle-fin/bridge-kit`) only
  supports Arc testnet. On mainnet the swap/bridge paths fail with `503`
  (`assertArcSdkPath` in `server.mjs` and the AMM/swap guards in `mcpServer.mjs`)
  rather than silently using testnet. Do not remove those guards to "make it work".
- Gateway chain naming: the Circle Gateway API calls the Arc chain `Arc` on **both**
  networks (`/v1/info`); the `network` field (`Testnet`/`Mainnet`) is the
  discriminator. The internal app/MCP vocabulary stays `Arc_Testnet`/`Arc`
  (`ARC_GATEWAY_KEY`).

Verify before deploying a network change:

```bash
npm test                 # 340 unit/regression
npm run probe:mainnet    # read-only Arc mainnet pre-flight (19 lulus / 0 blocker)
PORT=3999 node --env-file=.env server.mjs   # boot smoke on a scratch port
```

Mainnet contract deployment is planned (not executed) in
`docs/arc-mainnet-deploy-plan.md`; nothing there is broadcast until the operator
confirms.

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

**Exactly one process may own port 3001.** A manually started `node server.mjs`
left running alongside the systemd unit keeps the old code alive behind nginx,
which produces 4xx answers that no longer match the current source (this has
caused false "reject" reports more than once). Before debugging a rejection,
confirm both the listening PID and the unit's `MainPID`:

```bash
ss -ltnp | grep ':3001'
systemctl show arc-dex-api -p MainPID -p ActiveState
```

If they differ, stop the manual process and `sudo systemctl restart arc-dex-api`.

## Plugin flow regression harnesses

The three Plugin flows that are easy to confuse (Create New Wallet, Relogin
after Revoke, Login Passkey after Clear) are covered by two real end-to-end
harnesses. Run them after touching session binding, proof, or clear/revoke
behaviour — the unit tests alone cannot catch a wiring mistake between them.

```bash
npm run test:e2e:flows                 # virtual EOA + passkey against the local backend
npm run test:e2e:ui                    # real Chrome UI: all five Plugin flows
E2E_UI_FLOWS=1,5 npm run test:e2e:ui   # subset: create + stale per-agent token
E2E_BASE_URL=https://arcoxdex.vercel.app npm run test:e2e:flows   # production path
```

Flow 5 covers the stale per-agent session token that produced "Sesi berakhir.
Masuk kembali dengan passkey." on every card action while the same page had a
healthy session: it seeds a dead `arx_oauth_vault_token:<clientId>` slot, then
requires Revoke and Clear to keep working and that rejected slot to be retired.
It depends on the card Flow 1 creates, hence the `E2E_UI_FLOWS=1,5` form.

The UI harness drives headless Chrome with a virtual EOA provider and a CDP
virtual WebAuthn authenticator, and also runs the real MCP OAuth approval
(DCR + PKCE) for the Grok card. It needs Chrome, network access, and performs
real `addOwners` UserOperations on Arc testnet, so it stays out of `npm test`.

## MCP connector diagnostics ("agent connected but no tools")

A provider can show a connector as connected while its OAuth exchange never
completed, so no access token exists and `tools/list` was never successfully
called. Diagnose from the backend instead of guessing:

```bash
npm run diag:mcp                    # every registered client
npm run diag:mcp -- --agent grok    # one provider
```

The script matches registered OAuth clients with the tokens actually issued,
prints token expiry and the bound MSCA, then performs a real
`initialize` → `tools/list` → `tools/call` handshake in JSON-only and SSE modes,
and finally repeats `tools/list` with a dead `Mcp-Session-Id`.
A client with no active token means the browser approval (passkey → Setujui on
`/plugin`) never finished; re-connect from the provider and complete that page.

Transport interoperability rules the server must keep:

- A client that only sends `Accept: application/json` must receive JSON, not SSE.
- Requests without `Mcp-Session-Id` are served statelessly instead of rejected.
- A request that carries a `Mcp-Session-Id` this process does not know must also
  work. The `sessions` map is in-memory, so it empties on every restart, and
  Grok's connector manager ends each discovery run with `DELETE /mcp` and then
  reuses that dead id. Such a POST is served statelessly; GET/DELETE get the
  protocol's `404` (`-32001 Session not found`) so the client re-initializes.
  Never let this surface as the SDK's `400 Bad Request: Server not initialized`
  — providers report that as "terhubung tetapi tanpa tool".
- The tasks-extension field `execution` must not appear in `tools/list` while the
  server does not advertise the `tasks` capability; strict clients fail to parse
  the whole list otherwise.

`test/mcpUnknownSession.test.mjs` locks the dead-session recovery above,
`test/mcpToolListCompat.test.mjs` locks the tool-list shape, and
`test/mcpToolProfile.test.mjs` locks the optional `?profile=lite|core` subsets
(`full` stays the default; every profile keeps quote+execute pairs together).

## Agent wallet rotation and the UI harness

An agent that already has an Agent Wallet cannot silently switch to a new one.
`POST /api/session/activate-binding` answers `403
agent_wallet_rotation_forbidden` with an actionable message; it must never be
reported as an owner-session problem, because the UI shows the backend text
directly.

`npm run test:e2e:ui` uses a fresh virtual owner each run. Reusing a previous
run's EOA makes Flow 1 fail on that guard, so the state file is per-run by
default; set `E2E_UI_REUSE_EOA=1` with `E2E_UI_STATE_PATH` only when resuming an
interrupted run.

### Passkey namespace resolution (why the prompt is never discoverable)

The browser only knows a logical namespace for some agents — the OAuth approval
card sends `oauth:<clientId>`, a provider placeholder sends its bare slug — while
the durable binding row is `<clientId>|<owner>`. `GET /api/auth/passkey-options`
resolves that namespace (`listAgentBindingsForNamespace`) and returns
`allowCredentials` for every install of that agent, so WebAuthn never falls back
to a discoverable ceremony that would offer every passkey on the device (which
could authenticate a different Agent Wallet). Revoked rows stay included on
purpose: Relogin after revoke must still be able to select its own passkey.
`bindPasskeyCredential` resolves to the same durable row, so a passkey used for
the first time through a namespace key is bound there and offered on the next
login. `test/agentNamespaceCredentials.test.mjs` locks this down — cross-agent
namespaces must stay separate.

### Per-agent vault sessions expire independently (frontend rule)

The dashboard keeps one session per agent client in
`arx_oauth_vault_token:<clientId>` plus the global `arx_vault_token` family.
Every card action must retry the next candidate after a `401`/`403 forbidden`
and then retire the rejected token (`forgetVaultToken`); a fresh passkey Relogin
also rewrites that agent's own slot. Skipping either half is what made Revoke
and Clear answer "Sesi berakhir" forever after the 24h session expired, even
though the passkey had just been re-authenticated.
`src/services/agentTokenSelection.ts` (+ its test) owns the ordering, retirement
and retry policy; Flow 5 in the UI harness locks the wiring.

## OAuth test-state purge

`node scripts/purge-test-oauth-state.mjs` is dry-run by default and prints only masked token IDs. Review its complete candidate list before any apply. Apply is a separate production data operation requiring `--confirm PURGE` and explicit `--allow-client`/`--allow-token` flags; do not run it from automated tests or a deploy hook.
