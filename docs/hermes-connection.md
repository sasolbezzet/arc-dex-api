# Koneksi Hermes Agent ke ARCOX DEX (MCP)

Panduan flow koneksi plugin/MCP client (Hermes, Claude, ChatGPT) ke ARCOX DEX,
berdasarkan implementasi di `src/services/mcpServer.mjs` dan hasil E2E
production terverifikasi.

## Endpoint Production

```text
Web        : https://arcoxdex.vercel.app
MCP        : https://arcoxdex.vercel.app/mcp          (Streamable HTTP)
Metadata   : https://arcoxdex.vercel.app/.well-known/oauth-authorization-server
Resource   : https://arcoxdex.vercel.app/mcp          (RFC 9728 protected resource)
Scope      : mcp:tools
```

## Ringkasan Arsitektur

- Auth layer: OAuth 2.1 (authorization code + PKCE S256), Dynamic Client
  Registration (DCR), refresh token, dan RFC 8628 device flow.
- Identity binding: token OAuth terikat ke EOA (SIWE signature) DAN Agent Wallet
  MSCA (passkey session aktif via `bindMcpIdentityToActiveSession`). Tanpa
  binding MSCA, execute tools tidak aktif (read-only).
- Hermes dikenali sebagai `hermes-mcp` oleh `resolveAgentName()` (client_name
  mengandung "hermes").

## Jalur A — Device Flow RFC 8628 (utama Hermes di VPS/headless)

```text
Hermes                                Browser user (device apa pun)
  │ POST /api/auth/device/authorize
  │   body: { client_name: 'Hermes Agent' }
  │ ◄─ { device_code, user_code "ARCX-XXX-XXX",
  │      verification_uri:  /activate,
  │      verification_uri_complete: /arc-dex/plugin?auth=device&user_code=…,
  │      expires_in: 600, interval: 5 }
  │                                     user buka verification_uri(_complete),
  │ poll POST /api/auth/token           login passkey + approve:
  │   grant_type=device_code            POST /api/auth/device/message → SIWE
  │   device_code=…                     sign → POST /api/auth/device/approve
  │ ◄─ 400 authorization_pending        (+ mscaWalletAddress + mscaSessionToken)
  │ …poll tiap ≥5 detik…
  │ ◄─ 200 { access_token arx_at_…, refresh_token arx_rt_… }   (single-use)
  │ POST /mcp (Bearer) → initialize → notifications/initialized → tools/list
```

Catatan:

- Headless client boleh skip DCR: server membuat internal client
  `arcox_device_flow`.
- Poll terlalu cepat → `slow_down`. Kode kedaluwarsa → `expired_token`.
- Approve tanpa MSCA valid untuk protocol test, tapi execute tools tetap
  nonaktif sampai Agent Wallet ter-bind.

## Jalur B — Authorization Code + PKCE via browser (loopback)

1. DCR: `POST /api/auth/register` `{ client_name, redirect_uris: ['http://127.0.0.1:<port>/callback'] }`
2. `GET /api/auth/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&resource=https://arcoxdex.vercel.app/mcp`
3. Redirect 302 ke `/arc-dex/plugin?auth=mcp&request_id=…` (params disimpan
   server-side; browser tidak bisa mengubah redirect/state/PKCE).
4. UI plugin: Login Passkey → WebAuthn → sesi MSCA ACTIVE.
5. SIWE: `GET /api/auth/siwe-message` → wallet sign → `POST /api/auth/siwe-verify`
   dengan `mscaWalletAddress` + `mscaSessionToken` → `{ code }`.
6. Browser redirect ke loopback callback `?code=…&state=…`.
7. `POST /api/auth/token` grant_type=authorization_code + code_verifier.
8. `POST /mcp` Bearer → initialize → tools/list.

## Setelah Terhubung — Eksekusi (dua langkah wajib)

Semua eksekusi hanya lewat Agent Wallet MSCA (`source: 'session'`).

```text
arcox_session_status                    → cek active + walletAddress
arcox_quote_send  { to, token, amount, fromChain, source:'session' }
                                        → preview + previewId (expired)
arcox_execute_send { to, amount, token, fromChain, source:'session',
                     previewId, confirmed:true, confirmationText:'ya'|'yes' }
                                        → { status:'executed', txHash, explorerUrl }
```

Guard yang ditegakkan server: previewId single-use dan terikat wallet/chain,
`confirmed=true` + confirmationText eksplisit, session key chain authorization
harus aktif, tidak ada fallback diam-diam ke transfer treasury.

## E2E Production (semua PASS, Agustus 2026)

| Script | Cakupan | Hasil |
|---|---|---|
| `scripts/e2e-mcp-connect-chrome.mjs` | Real Chrome + WebAuthn CDP: passkey login → SIWE → code → token → MCP → quote READY TO TX | ✅ PASSED (88 tools) |
| `scripts/e2e-device-flow.mjs` BASE=https://arcoxdex.vercel.app | RFC 8628 penuh: authorize, pending, status, SIWE, approve, token single-use, MCP authorized/401 | ✅ ALL PASS 16/16 |
| `scripts/e2e-execute-send-prod.mjs` | Loopback OAuth headless + MSCA binding → quote → **eksekusi nyata** send USDC Arc Testnet | ✅ PASSED (tx on-chain) |

Contoh konfigurasi Hermes:

```text
MCP URL   : https://arcoxdex.vercel.app/mcp
Auth      : Dynamic Client Registration (DCR), PKCE S256
Manual    : Auth URL = https://arcoxdex.vercel.app/api/auth/authorize
            Token URL = https://arcoxdex.vercel.app/api/auth/token
Headless  : device flow — POST https://arcoxdex.vercel.app/api/auth/device/authorize,
            user buka https://arcoxdex.vercel.app/activate, masukkan ARCX-XXX-XXX
```

Tidak perlu token MSCA di env Hermes: sesi OAuth sudah terikat ke MSCA saat
user approve di browser.
