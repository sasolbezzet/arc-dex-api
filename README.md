# ARCOX DEX API

Backend retail + agent untuk ARCOX DEX: quote/swap/bridge/send, ARCOX Pay &
x402, ARCOX Intel, ARCOX AI Router, dan MCP server remote untuk agent
(Hermes, Grok, Claude, ChatGPT, Codex).

## Production

```text
Web            : https://arcoxdex.vercel.app
Public MCP     : https://arcoxdex.vercel.app/mcp
OpenAI-compat  : https://arcoxdex.vercel.app/v1
GitHub         : https://github.com/sasolbezzet/arc-dex-api
```

MCP selalu memakai URL web production di atas. Alamat VPS
(`https://43.134.14.43.nip.io`) hanya backend upstream internal dan jarang
dipakai langsung; Vercel me-rewrite `/api/*`, `/v1/*`, `/mcp`,
`/.well-known/*`, dan `/health` ke sana.

## Menjalankan

Service berjalan sebagai unit systemd `arc-dex-api` yang mengikat port 3001
(nginx di depannya). **Hanya satu proses boleh memegang port 3001** — proses
ganda adalah penyebab klasik jawaban 4xx "palsu" dari kode lama.

```bash
sudo systemctl status arc-dex-api
sudo systemctl restart arc-dex-api        # setelah update kode
curl -fsS http://127.0.0.1:3001/health    # {"ok":true,...}
```

Jalankan manual (untuk debugging):

```bash
cd /home/ubuntu/arc-dex-api
node --env-file=.env server.mjs           # hentikan service dulu agar port bebas
```

## Tanggung Jawab

- Circle proxy wallet lookup dan action, dan webhook Circle Gateway/Circle Wallets.
- Quote/swap/send/bridge preparation untuk web UI dan agent.
- **MCP server remote** (`/mcp`) untuk agent: OAuth 2.1 (DCR + PKCE), token
  koneksi Hermes, per-agent binding ke Agent Wallet (MSCA).
- **Session key service** untuk MSCA: generate key, otorisasi delegate
  on-chain (Arc + Base Sepolia + Arbitrum Sepolia), reconcile, revoke.
- ARCOX Pay: invoice/payment link USDC publik di Arc Testnet + reconcilasi memo.
- x402 middleware untuk endpoint berbayar (ARCOX Intel) dengan invoice internal.
- ARCOX AI Router (OpenAI-compatible) dengan pembayaran dari Unified Balance.
- Agent cards, agentic jobs (ERC-8004/ERC-8183), dan vault credential.

## Struktur Runtime

```text
.env                  konfigurasi server (jangan commit)
server.mjs            entry point + routing HTTP (76 route)
src/services/         mcpServer.mjs, sessionKeyService.mjs, vaultStore.mjs, dll
src/routes/           route group (aiRouter, arkham, treasury, x402, vault)
data/                 state runtime JSON (atomic write + .bak)
docs/                 dokumentasi teknis
test/                 unit/regresi (node --test)
scripts/              e2e nyata + diagnosa
```

State di `data/` (backup sebelum migrasi/reset):

```text
oauth-clients.json    klien OAuth terdaftar (Grok, Claude, ChatGPT, arcox_conn_*)
oauth-tokens.json     access/refresh token
oauth-state.json      authorization request + SIWE challenge
session-keys.json     session key per Agent Wallet (MSCA)
vault.json            credential, limit, approval, card link
vault-sessions.json   sesi owner/passkey + metadata session
vault-activity.json   audit aktivitas agent
agent-spend.json      pengeluaran harian per agent
```

Supabase dipakai sebagai persistence shadow/primary (transaksi, invoice,
aktivitas, metadata session); kegagalan dual-write tidak memblokir permintaan.

## MCP Server

Endpoint publik:

```text
POST/GET/DELETE /mcp
GET  /.well-known/oauth-authorization-server[/mcp]
GET  /.well-known/oauth-protected-resource[/mcp]
POST /api/auth/register      dynamic client registration (RFC 7591)
GET  /api/auth/authorize     authorization code + PKCE S256
POST /api/auth/token         authorization_code / refresh_token
GET  /api/auth/siwe-message  SIWE challenge untuk approval owner
POST /api/auth/siwe-verify   verifikasi SIWE + penerbitan authorization code
POST /api/auth/passkey-*     login/verify passkey di halaman approval
```

Karakteristik yang berlaku sekarang:

- Access token berlaku 24 jam, refresh token 30 hari; keduanya diikat ke
  `resource = <SERVER_URL>/mcp` dan hanya valid untuk resource itu.
- **Satu agent = satu `clientId` = satu binding** `<clientId>|<owner>` dengan
  Agent Wallet, limit harian, card link, dan state revoke sendiri.
- Agent Hermes-style boleh memakai **connection token** (`arcox_conn_*`) yang
  dibuat dari halaman Plugin, bukan OAuth penuh.
- Interoperabilitas transport:
  - Klien yang hanya menerima `application/json` (mis. runtime Grok, konfigurasi
    default Hermes) dilayani sebagai JSON, bukan SSE.
  - Klien yang menerima `text/event-stream` (Claude/ChatGPT) tetap SSE.
  - Permintaan tanpa `Mcp-Session-Id` (klien stateless) dilayani dengan server
    sekali pakai, sehingga `tools/list` tetap bisa dijawab.
  - `Mcp-Session-Id` yang sudah tidak dikenal proses ini (peta sesi in-memory
    kosong setelah restart, dan Grok menutup sesinya sendiri dengan
    `DELETE /mcp` di akhir setiap discovery) tetap dilayani untuk POST; GET dan
    DELETE dijawab `404 Session not found` agar klien melakukan initialize ulang.
    Tanpa aturan ini agent tampil "terhubung" tetapi tidak bisa membaca tool.
  - Field tasks-extension `execution` **tidak** dikirim, karena server tidak
    mengiklankan capability `tasks` dan klien dengan skema ketat gagal
    mem-parse seluruh daftar tool jika field asing ikut terkirim.
- 88 tool tersedia untuk semua agent (`arcox_wallet_balances`,
  `arcox_quote_bridge`/`arcox_execute_bridge`, `arcox_intel_*`, `arcox_card_*`,
  `arcox_x402_*`, `arcox_agent_*`, `call_ai_model`, …).
- Klien dengan kuota tool kecil (mis. connector penyedia AI) bisa meminta
  subset yang konsisten lewat URL atau header; default tetap daftar penuh:

  ```text
  https://arcoxdex.vercel.app/mcp?profile=lite    # 13 tool transaksi inti
  https://arcoxdex.vercel.app/mcp?profile=core    # 41 tool
  x-arcox-tool-profile: core                       # lewat header
  ```

  Nama profil tak dikenal jatuh kembali ke `full`. Setiap profil selalu memuat
  pasangan quote + execute agar agent tidak pernah bisa execute tanpa preview;
  profil aktif terlihat di output `arcox_mcp_info` (`tool_profile`,
  `tool_count`).

Diagnosa konektor (jawaban untuk "agent sudah terhubung tapi tool tidak
terbaca"):

```bash
npm run diag:mcp                      # semua agent
npm run diag:mcp -- --agent grok      # filter satu agent
```

Skrip ini mencocokkan klien OAuth + token yang benar-benar terbit, lalu
melakukan handshake `initialize` → `tools/list` → `tools/call` memakai token
tersebut, pada mode JSON-only dan SSE, plus sekali lagi memakai
`Mcp-Session-Id` yang sudah mati (kondisi yang membuat Grok tampak "terhubung
tanpa tool").

## Alur Agent Wallet (MSCA)

| Alur | Aturan backend |
|---|---|
| Buat Wallet Baru | butuh owner proof (SIWE) + passkey; `generate-key` membuat delegate & `addOwners` di Arc, lalu Base/Arbitrum Sepolia |
| Relogin setelah Revoke | passkey cukup; delegate dirotasi, binding lama diaktifkan kembali tanpa SIWE |
| Login Passkey setelah Hapus | passkey + owner proof; binding dibuat ulang |

Session key yang di-revoke atau di-clear tidak menyisakan
`authorizationUserOpHash` lama, sehingga permintaan berikutnya tidak terjebak
pada state basi. Detail policy sisi frontend ada di
`arc-dex/src/services/sessionProofPolicy.ts`.

Tombol passkey selalu menunjuk ke passkey milik agent itu sendiri. Frontend
mengirim namespace logis (`oauth:<clientId>` atau slug provider) sementara baris
binding tersimpan sebagai `<clientId>|<owner>`; `GET /api/auth/passkey-options`
me-resolve namespace tersebut lewat `listAgentBindingsForNamespace` dan mengirim
`allowCredentials`, sehingga dialog passkey tidak pernah berjalan discoverable
(yang bisa memilih wallet agent lain).

## ARCOX Pay, x402, Intel, AI Router

- **ARCOX Pay**: payment link/invoice USDC Arc Testnet, status timeline,
  reconciliation amount unik + Arc Transaction Memo. Lihat `docs/arcox-pay.md`.
- **x402**: endpoint berbayar mengembalikan `402 Payment Required` dengan
  invoice internal; setelah dibayar, hasil terbuka. Lihat
  `docs/x402-monetization.md` dan `docs/mcp-pay-tools.md`.
- **ARCOX Intel**: endpoint `/api/intel/*` (Arkham-backed, read-only) hanya
  dapat diakses lewat backend; `ARKHAM_API_KEY` tidak pernah dikirim ke
  frontend/MCP. Lihat `docs/arcox-intel.md`.
- **AI Router**: `/v1/chat/completions` + `/v1/models`, key `arx_sk_...`
  (disimpan sebagai hash), dibayar per request dari Unified Balance melalui
  Auto Pay. Provider key hanya di env backend.

```text
base_url = https://arcoxdex.vercel.app/v1
api_key  = arx_sk_...
model    = arcox/auto
```

## Testing

```bash
npm test                 # node --check + 315 test unit/regresi
npm run test:e2e:flows   # 3 alur agent: passkey + EOA virtual, UserOperation NYATA di Arc testnet
npm run test:e2e:ui      # 4 alur menu Plugin di Chrome nyata (virtual authenticator)
npm run diag:mcp         # diagnosa konektor/token MCP per agent
npm run probe:mainnet    # pre-flight Arc mainnet (read-only, tanpa transaksi)
```

`test:e2e:ui` dan `test:e2e:flows` butuh Chrome/jaringan dan menulis state uji,
jadi tidak dijalankan otomatis di `npm test`. Detail operasional:
`MAINTENANCE.md`.

## Env penting

```text
SERVER_URL=https://arcoxdex.vercel.app     # dipakai untuk issuer OAuth + resource MCP
AUTH_SECRET=
ALLOWED_ORIGINS=https://arcoxdex.vercel.app
SUPABASE_URL= / SUPABASE_SERVICE_KEY=
CIRCLE_API_KEY= / CIRCLE_CLIENT_KEY_LIVE= / CIRCLE_API_KEY_MAINNET=
CIRCLE_ENTITY_SECRET=
KIT_KEY=
ARKHAM_API_KEY=
X402_ENABLED=true
ARC_MEMO_CONTRACT=0x5294E9927c3306DcBaDb03fe70b92e01cCede505
ARCOX_TREASURY_WALLET_ADDRESS=
AI_ROUTER_DELEGATE_ADDRESS=
AI_PROVIDER_1_NAME= / AI_PROVIDER_1_BASE_URL= / AI_PROVIDER_1_API_KEY= / AI_PROVIDER_1_MODEL=
ENABLE_SERVER_SIGNED_MINT=false
```

- `ARCOX_TREASURY_WALLET_ADDRESS` adalah penerima tunggal fee backend, AI
  Router, dan x402. Setelah diganti, restart proses dan panggil
  `setTreasury(address)` pada router on-chain.
- Setelah mengubah `.env`, restart unit systemd agar env baru dimuat.

## Mainnet

- `docs/mainnet-security.md` — checklist keamanan mainnet.
- `docs/mainnet-x402-readiness.md` — kesiapan x402 di Arc mainnet.
- Ringkasan prasyarat frontend+backend: `arc-dex/docs/mainnet-readiness.md`.

## Catatan teknis

- RPC Arc publik yang sinkron: `rpc.testnet.arc.network`. Jangan pakai node
  tertinggal — nonce konflik pada x402/swap/bridge/send.
- Semua scan `eth_getLogs` Arc di-chunk konservatif (2.000–8.000 block).
- Invoice `expired` tetap di-reconcile bila ada bukti pembayaran on-chain.
- Jangan simpan private key user atau secret Circle di repo/frontend.
