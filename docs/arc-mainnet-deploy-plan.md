# Rencana Deploy Kontrak ARCOX ke Arc Mainnet

Dokumen ini adalah **rencana + checklist**. Tidak ada langkah di sini yang boleh
dijalankan sebagai broadcast sampai operator memberi konfirmasi eksplisit.

Prasyarat read-only sudah hijau: `npm run probe:mainnet` → **19 lulus / 0 blocker**
(chain 5042, Client Key LIVE, API Key LIVE, Gas Station policy LIVE, passkey
domain LIVE, Gateway mainnet `gateway-api.circle.com` dengan nama chain `Arc`).

## 1. Yang belum ada di mainnet

| Kontrak | Alamat testnet (referensi) | Status mainnet |
| --- | --- | --- |
| ARCOX Fee Router (`ArcoxRouter.sol`) | `0xDf800310443BEB589CEf91A09854203Ea36e43a7` | belum di-deploy |
| AMM Router | `0x9f2443691bddd8343590c68e2a2cdec5fd0b6124` | belum di-deploy |
| Swap Adapter | `0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b` | belum di-deploy |
| ERC-8183 Agentic Commerce | `0x0747EEf0706327138c69792bF28Cd525089e4583` | belum di-deploy |
| Treasury mainnet | — | belum dibuat |

Kontrak pihak Circle (USDC, EURC, USYC, Memo, ERC-8004, CCTP, Gateway) **sudah
live** dan tidak perlu di-deploy; alamatnya sudah ada di
`src/config/arcNetwork.mjs` (`MAINNET`).

## 2. Aturan yang tidak boleh dilanggar

- Alamat kontrak ARCOX mainnet **hanya** dibaca dari env berakhiran `_MAINNET`.
  Di mainnet tidak ada fallback ke alamat testnet: `arcContractAddress()` mengembalikan
  `null` kalau `*_MAINNET` belum diisi, sehingga fitur gagal-tertutup.
- Deployer mainnet memakai **key terpisah** dari testnet (`AGENT_PRIVATE_KEY`
  testnet tidak boleh dipakai). Simpan hanya di `.env` VPS (mode 600).
- Jalur swap/bridge SDK Circle (`@circle-fin/app-kit`, `@circle-fin/bridge-kit`)
  pada versi yang terpasang hanya mengenal Arc testnet. Di mainnet jalur itu
  sengaja mengembalikan `503` (`assertArcSdkPath`), bukan diam-diam ke testnet.
  Aktifkan kembali hanya setelah SDK mengekspor chain mainnet.
- Tidak menyalin private key, state, atau invoice antara testnet dan mainnet.
  State sudah terpisah oleh chain key (`arc-testnet` vs `arc-mainnet`).

## 3. Urutan deploy

### 3.1 Siapkan deployer key + gas

Arc memakai USDC sebagai gas.

- [ ] Buat key deployer mainnet baru (hardware/keystore, bukan hot key agent).
- [ ] Isi sedikit USDC native (mis. 1–2 USDC) untuk gas deploy + konfigurasi.
- [ ] Simpan sebagai `ARCOX_MAINNET_DEPLOYER_PRIVATE_KEY` di `.env` VPS.
- [ ] Catat alamat deployer di `MAINTENANCE.md` (tanpa key).

### 3.2 ARCOX Fee Router (`ArcoxRouter.sol`)

Sumber: `arcox-mcp/packages/contracts-evm/ArcoxRouter.sol`, script compile/deploy
`arcox-mcp/packages/runtime/scripts/{compile-router,deploy-router}.mjs`.

Script deploy saat ini hardcode `TOKEN_MESSENGER` **testnet** dan `chains` map
testnet-only. Sebelum dipakai untuk mainnet:

- [ ] Tambah entri chain `Arc_Mainnet` (id `5042`, `domain 26`,
      `usdc 0x3600…0000`, `rpc https://rpc.mainnet.arc.io`).
- [ ] `TOKEN_MESSENGER` → mainnet `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`.
- [ ] Output deployment jangan menimpa `deployments/arcox-router.testnet.json`
      (pakai file `-mainnet.json`).
- [ ] Constructor: `[owner, treasury, usdc, tokenMessenger, domain=26, feeBps=ARCOX_ROUTER_FEE_BPS]`.
- [ ] Setelah deploy, `setSupportedDestinationDomain(domain, true)` hanya untuk
      domain tujuan yang benar-benar dipakai (jangan meniru daftar testnet).
- [ ] Verifikasi bytecode + source di `https://explorer.arc.io`.

### 3.3 AMM Router, Swap Adapter, ERC-8183

Sumber ketiga kontrak ini **tidak ada** di `arc-dex` maupun `arcox-mcp`
(hanya alamat hasil deploy testnet yang tercatat). Sebelum menjadwalkan deploy:

- [ ] Temukan repo/artefak sumber (legacy `arcox-agent/archive/arc-dex-agent-legacy/contracts/`
      atau arsip lain) dan konfirmasi bytecode-nya cocok dengan alamat testnet.
- [ ] Kalau sumber tidak ditemukan: jangan deploy alamat tiruan — jalankan
      fitur terkait sebagai "belum tersedia di mainnet" (fail-closed) dan
      dokumentasikan sebagai pekerjaan lanjutan.
- [ ] `ArcoxApiPass.sol` (API pass) juga perlu keputusan: dipakai atau tidak.

### 3.4 Treasury mainnet

- [ ] Buat wallet treasury mainnet **baru** (bukan testnet).
- [ ] `ARCOX_TREASURY_WALLET_ADDRESS_MAINNET` → alamat treasury.
- [ ] Deposit USDC sesuai `X402_MIN_TREASURY_USDC` + buffer fee Gateway.
- [ ] `AI_ROUTER_DELEGATE_PRIVATE_KEY_MAINNET` → delegate signer mainnet terpisah.
- [ ] Verifikasi `/api/x402/treasury-health` → `healthy: true`.

## 4. Env yang harus diisi setelah deploy

```text
# jaringan aktif (default testnet bila kosong)
ARC_NETWORK=mainnet

# kontrak ARCOX mainnet — hanya dari *_MAINNET
ARCOX_FEE_ROUTER_ADDRESS_MAINNET=
ARCOX_AMM_ROUTER_MAINNET=
ARCOX_SWAP_ADAPTER_MAINNET=
ARCOX_ERC8183_ADDRESS_MAINNET=
ARCOX_API_PASS_ADDRESS_MAINNET=

# Circle mainnet
CIRCLE_API_KEY_MAINNET=
CIRCLE_CLIENT_KEY_LIVE=
CIRCLE_ENTITY_SECRET=
CIRCLE_ENV=live
# CIRCLE_BASE_URL=https://api.circle.com   # opsional, sandbox diabaikan di mainnet
# CIRCLE_GATEWAY_BASE_URL=https://gateway-api.circle.com  # opsional (default mainnet)

# treasury + delegate mainnet
ARCOX_TREASURY_WALLET_ADDRESS_MAINNET=
AI_ROUTER_DELEGATE_PRIVATE_KEY_MAINNET=

# x402
X402_MODE=arc_mainnet
```

`ARC_RPC_URL`, `CANTEEN_RPC_URL`, dan `ARC_RPC_DRPC` **diabaikan** saat mainnet:
RPC diambil dari `ARC_MAINNET_RPC_URL` bila diset, kalau tidak dari
`https://rpc.mainnet.arc.io`. MSCA mainnet hanya mendukung chain `arc-mainnet`.

## 5. Verifikasi berjenjang (tanpa broadcast dulu)

1. **Statis** — `npm test` (340 tes) hijau; `npm run check` hijau.
2. **Read-only** — `npm run probe:mainnet` → 19 lulus / 0 blocker.
3. **Konfigurasi** — jalankan satu instance di port uji (`PORT=3999 node --env-file=.env server.mjs`)
   dengan `ARC_NETWORK=mainnet`, lalu cek `/health`, `/api/x402/config`
   (`network: arc-mainnet`, `chainId: 5042`), dan `/api/agents/status`.
4. **Eth_call** — baca `owner()`, `treasury()`, `usdc()`, `tokenMessenger()`,
   `supportedDestinationDomains(26)` pada router mainnet (tanpa transaksi).
5. **Satu pembayaran kecil** — 0.005–0.02 USDC via MSCA (invoice → pay →
   reconcile → unlock data) + jalur refund.
6. **Baru kemudian** restart unit produksi dengan `ARC_NETWORK=mainnet`.

## 6. Rollback

- Hapus `ARC_NETWORK=mainnet` (atau set `ARC_NETWORK=testnet`) lalu restart
  `arc-dex-api.service` → semua jalur kembali ke testnet.
- Tidak ada migrasi data: session/binding/invoice terpisah per chain key.
- Kontrak mainnet yang sudah di-deploy tidak perlu dihapus; kalau perlu
  dinonaktifkan, cukup hapus `*_MAINNET` dari `.env` (fitur kembali fail-closed).

## 7. Setelah deploy

- [ ] `npm run probe:mainnet` diulang (harus tetap 0 blocker).
- [ ] `docs/mainnet-x402-readiness.md` dan `arc-dex/docs/mainnet-readiness.md`
      diperbarui: alamat mainnet + bukti tx.
- [ ] Catat tx hash deploy di `MAINTENANCE.md`.
- [ ] Pantau `/api/x402/stats` dan treasury harian di minggu pertama.
