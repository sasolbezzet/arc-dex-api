# Rencana Deploy Kontrak ARCOX ke Arc Mainnet

Dokumen ini adalah **rencana + checklist**. Tidak ada langkah di sini yang boleh
dijalankan sebagai broadcast sampai operator memberi konfirmasi eksplisit.

Prasyarat read-only sudah hijau: `npm run probe:mainnet` → **22 lulus / 0 blocker**
(chain 5042, Client Key LIVE, API Key LIVE, Gas Station policy LIVE, passkey
domain LIVE, Gateway mainnet `gateway-api.circle.com` dengan nama chain `Arc`).

## 1. Yang belum ada di mainnet

Snapshot terverifikasi (`npm run mainnet:sources` + `npm run mainnet:plan` di
`arcox-mcp`), status on-chain dicek read-only pada 25–26 Sep 2026:

| Kontrak | Alamat testnet | Bentuk on-chain | Status mainnet |
| --- | --- | --- | --- |
| ARCOX Fee Router | `0xDf80…43a7` | `ArcoxRouter` langsung (solc 0.8.35) | **Arc ✓, Base ✓, Arbitrum ✓** (25 Sep 2026) |
| AMM Router | `0x9f24…6124` | `ArcoxCirBTCRouterV2` langsung (solc 0.8.24) | belum di-deploy |
| AMM Pool USDC-cirBTC | `0xd4af…dc2d` | `ArcoxBTCPool` (solc 0.8.24) | belum di-deploy |
| AMM Pool EURC-cirBTC | `0xcca9…6bfa2` | `ArcoxBTCPool` (solc 0.8.24) | belum di-deploy |
| Swap Adapter | `0xBBD7…d40b` | **TransparentUpgradeableProxy** → impl `Adapter` `0xb4d0…c2d4`, admin `0x6a73…8b7a` (solc 0.8.28) | **Arc ✓** (26 Sep 2026); Base/Arbitrum belum (kurang dana gas) |
| ERC-8183 Agentic Commerce | `0x0747…e4583` | **ERC1967Proxy** → impl `AgenticCommerce` `0xa316…351a` (solc 0.8.28, optimizer OFF, evm cancun) | belum di-deploy |
| Treasury mainnet | — | — | belum dibuat |

Kontrak pihak Circle (USDC, EURC, USYC, Memo, ERC-8004, CCTP, Gateway) **sudah
live** dan tidak perlu di-deploy; alamatnya sudah ada di
`src/config/arcNetwork.mjs` (`MAINNET`).

Hal penting: Swap Adapter dan ERC-8183 adalah **proxy**, jadi deploy mainnet perlu
implementation + proxy (untuk Swap Adapter plus keputusan ProxyAdmin). Konstruktor
proxy Swap Adapter di testnet menyebut logic `0xCeA69a03…8751`, padahal slot
implementasi saat ini `0xb4d0…c2d4` — artinya adapter pernah di-upgrade. Yang harus
ditiru di mainnet adalah implementasi **terkini**, bukan alamat logic lama itu.

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

### 3.2 ARCOX Fee Router (`ArcoxRouter.sol`) — SUDAH DIJALANKAN

Script mainnet khusus ada di `arcox-mcp/packages/runtime/scripts/` (jangan pakai
`deploy-router.mjs` yang hardcode TokenMessenger testnet):

| Langkah | Perintah |
| --- | --- |
| Cek saldo deployer | `npm run mainnet:balances -- --key-file <file>:<VAR>` |
| Dry-run rencana | `npm run mainnet:fee-router:deploy -- --key-file … --treasury … --fee-bps 500 --chains arc,base` |
| Kirim | tambahkan `--broadcast` |
| Aktifkan domain tujuan | `npm run mainnet:fee-router:domains -- --key-file … --chains arc,base --broadcast` |
| Verifikasi state + bytecode | `npm run mainnet:fee-router:verify` |
| Verifikasi source publik | `npm run mainnet:fee-router:verify-sources` |

Hasil 25 Sep 2026 — owner/deployer `0xE34FF1D2…4569e` (key `EOA_PRIVATE_KEY` di
`~/.arcox/agent.env`), treasury `0x5d16E8Ef…DF40F`, `feeBps` **500** (5%):

| Chain | Alamat Fee Router | Domain aktif | Deploy tx |
| --- | --- | --- | --- |
| Arc Mainnet (5042) | `0x9Fd14A94bDbEFf73EDB22853cc77416B65E2A0c0` | 6 (Base), 3 (Arbitrum) | `0x97f717a8…a5b11` |
| Base Mainnet (8453) | `0xD858f073FA09834b1d64C165afC2757F1DF2f019` | 26 (Arc), 3 (Arbitrum) | `0x0411ca0c…af523` |
| Arbitrum One (42161) | `0xaF15a9fFdDB21A42Aa6175B8130aE69ce41C78F9` | 26 (Arc), 6 (Base) | `0x9ae11d17…7f5cd` |

Ketiga chain memakai `treasury` = `0x5d16E8Ef186d6D0d984f9A50C7ddb16C106DF40F`
dan `feeBps` = 500 — sudah diverifikasi on-chain, jadi **tidak perlu deploy ulang**
hanya untuk mengganti treasury.

Verifikasi yang sudah lulus: state on-chain (owner, treasury, feeBps, `usdc`,
`tokenMessenger` mainnet CCTP v2, `localDomain`, `supportedTokens`,
`quoteFee(1 USDC)` = 0.05), bytecode on-chain cocok dengan hasil kompilasi ulang
sumber (immutable di-mask), dan **source terverifikasi Sourcify `exact_match`**
(creation + runtime) untuk **ketiga chain**. Explorer Arc Mainnet memblokir API
dari server (Cloudflare), jadi Sourcify dipakai sebagai jalur verifikasi otomatis.

Dicek ulang 26 Sep 2026 (`mainnet:fee-router:verify`): ketiga router masih ada dan
lulus semua pemeriksaan (kode 4.653 byte di tiap chain, receipt sukses, treasury +
feeBps sesuai). **Tidak ada yang perlu di-deploy ulang.** Kalau kontrak "tidak
ditemukan" di explorer, hampir pasti alamat yang dicari alamat testnet —
`ARCOX_FEE_ROUTER_ADDRESS` di `.env` masih berisi `0xDf800310…` (kode ada di Arc
**testnet**, kosong di Arc mainnet). Pakai var `*_MAINNET` (bagian 4).

> ⚠️ **JANGAN DIPAKAI** — dua alamat ini hasil percobaan pertama yang salah dan
> sengaja dibiarkan tercatat: Arc `0xb9Fb801A5D1491E70A886800982CB80cdf98A174`,
> Base `0xc31F668B17A8A923d661F2fc16A89Cd0BD14a39b`. Keduanya ter-deploy dengan
> immutables **testnet** (feeBps 30, TokenMessenger testnet, di Base bahkan USDC
> Arc) akibat `creation_bytecode` dari ArcScan sudah menyertakan constructor args
testnet di ekornya. Detail audit: `packages/runtime/deployments/fee-router-mainnet.REJECTED-20260925-bad-constructor-args.json`.
> Deploy berikutnya wajib lewat skrip mainnet yang mengompilasi ulang sumber
> dengan solc lokal sebagai sumber kebenaran bytecode.

Catatan operasional:

- Aktifkan domain tujuan **hanya untuk chain yang router-nya sudah ada**. Kalau
  Arbitrum belum di-deploy, domain 3 sengaja belum diset di Arc/Base.
- `setSupportedDestinationDomain` pernah revert out-of-gas dengan limit default
  (22.026 gas), jadi skrip sekarang selalu memakai limit eksplisit 120.000 gas.
- `Arbitrum` sudah ter-deploy (25 Sep 2026), dan domain 3 sudah aktif di Arc +
  Base. Untuk chain baru di masa depan: kirim gas ke `0xE34FF1D2…4569e`, lalu
  `mainnet:fee-router:deploy --chains <chain> --broadcast` diikuti
  `mainnet:fee-router:domains --chains arc,base,arbitrum --broadcast`, lalu
  `mainnet:fee-router:verify`.

### 3.3 Swap Adapter — status & yang menghambat

Rencana deploy siap di `arcox-mcp/packages/runtime/scripts/deploy-swap-adapter-mainnet.mjs`
(dry-run default). Dua hal yang harus diketahui:

- **`Adapter` tidak punya parameter treasury maupun fee.** Yang bisa disetel saat
  init hanya `initialize(address owner_, address signer_, uint256 signerThreshold_)`.
  Jadi permintaan "swap adapter pakai alamat treasury" tidak punya padanan di
  kontrak ini — treasury 5% sudah ditangani Fee Router.
- Estimasi gas proxy tidak mungkin sebelum implementation ada (konstruktor OZ
  mendelegatecall `initialize` ke logic; delegatecall ke alamat tanpa kode selalu
  revert), jadi script memakai limit tetap 1,2 juta gas.

Keputusan operator (tercatat di `arcox-mcp/packages/runtime/deployments/swap-adapter-mainnet.json`):

| Peran | Alamat |
| --- | --- |
| `owner` adapter | `0x5d16E8Ef186d6D0d984f9A50C7ddb16C106DF40F` |
| Pemilik ProxyAdmin (hak upgrade) | `0x5d16E8Ef186d6D0d984f9A50C7ddb16C106DF40F` |
| Signer EIP-712 (threshold 1) | `0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e` |

> Owner + ProxyAdmin dipegang alamat treasury operator, sedangkan key signer ada di
> VPS. Konsekuensinya: eksekusi swap bisa jalan, tetapi penambahan signer dan
> upgrade proxy hanya bisa dilakukan oleh pemegang key `0x5d16E8Ef…`.

**Arc sudah ter-deploy 26 Sep 2026** (preflight `CUKUP`, gas impl ≈3,94 juta + proxy
1,2 juta limit):

| Peran | Alamat |
| --- | --- |
| Alamat aktif aplikasi (**proxy**) | `0x8bc25dB1feda8Fc5eB20d0117Ff1f965F2F4E29C` |
| Implementation (`Adapter`) | `0xA6EeE6c972825f7d746673D9a1E25Ca58BD11274` |
| ProxyAdmin (hak upgrade) | `0x881037816Da1Cd38Ebe1d88250d3ddaEA994a4EA` |
| Signer EIP-712 (threshold 1) | `0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e` |

Deploy tx: impl `0x624359d08f849eef15cf9613cc2477e02b0275c2f22f6c6b2de35709266ac92b`,
proxy `0xd46509ed6eb9a6e7601799ed5b942a05b406b0767360e2fcfef1dd46f1a21cf9`.

Verifikasi (`npm run mainnet:swap-adapter:verify -- --chains arc --sourcify`) lulus
semua: kode proxy 813 byte + impl 17.729 byte, slot EIP-1967 implementation & admin
benar, `ProxyAdmin.owner()` = `0x5d16E8Ef…`, state lewat proxy (`owner`
`0x5d16E8Ef…`, threshold 1, signer terdaftar, `paused` false, `pendingOwner` 0x0),
implementation mentah belum di-`initialize`, bytecode cocok dengan kompilasi ulang
snapshot (solc 0.8.28 / optimizer 200 / viaIR / paris), dan Sourcify `exact_match`
untuk impl + proxy.

Base & Arbitrum masih menunggu dana gas:

| Chain | Perkiraan biaya | Saldo terakhir | Kurang | Saran kirim |
| --- | --- | --- | --- | --- |
| Base | ≈0,0000293 ETH | 0,0000115 ETH | ≈0,000018 ETH | 0,0005 ETH |
| Arbitrum | ≈0,0000978 ETH | 0,0000051 ETH | ≈0,000093 ETH | 0,001 ETH |

Catatan: alamat proxy mainnet di atas **berbeda** dari alamat testnet
(`0xBBD7…d40b`), jadi env aplikasi harus diarahkan ke `ARCOX_SWAP_ADAPTER_MAINNET`.

### 3.4 AMM Router, ERC-8183

Sumber ketiga kontrak ini tidak ada di repo, **tetapi semuanya terverifikasi di
ArcScan**, jadi source-nya sudah disalin ke
`arcox-mcp/packages/runtime/mainnet-sources/` lewat `npm run mainnet:sources`
(read-only). Nama kontrak, compiler, dan constructor args aslinya tercatat di
`mainnet-sources/manifest.json`.

- AMM Router = `ArcoxCirBTCRouterV2`, args `[_treasury, _usdc, _eurc, _cirbtc]`.
- Pool = `ArcoxBTCPool`, args `[_token0, _token1]` (USDC-cirBTC dan EURC-cirBTC).
- Swap Adapter = `Adapter` (impl) di belakang `TransparentUpgradeableProxy`.
- ERC-8183 = `AgenticCommerce` (impl) di belakang `ERC1967Proxy`.

Langkah:

- [ ] Jalankan `npm run mainnet:plan` di `arcox-mcp` untuk cetakan rencana +
      pemeriksaan prasyarat (read-only; tidak ada broadcast).
- [ ] Selesaikan blocker yang dicetak: treasury mainnet, deployer key terpisah,
      alamat cirBTC mainnet, keputusan ProxyAdmin Swap Adapter, dan init data
      proxy (USDC + operator) — jangan menyalin init data testnet mentah.
- [ ] **AMM cirBTC terhalang**: token cirBTC mainnet belum terverifikasi, jadi
      `ArcoxCirBTCRouterV2` + dua pool cirBTC tidak bisa di-deploy dulu. Jalur
      swap cirBTC di mainnet harus tetap fail-closed.
- [ ] Seeding likuiditas pool cirBTC setelah deploy adalah langkah operasional
      terpisah (bukan bagian dari script).
- [ ] `ArcoxApiPass.sol` (API pass) juga perlu keputusan: dipakai atau tidak.

### 3.5 Treasury mainnet

- [x] Treasury mainnet = alamat fee treasury ARCOX `0x5d16E8Ef186d6D0d984f9A50C7ddb16C106DF40F` (26 Sep 2026), dipakai juga oleh testnet — tidak ada treasury terpisah.
- [x] `ARCOX_TREASURY_WALLET_ADDRESS_MAINNET` + `ARCOX_TREASURY_WALLET_ADDRESS` = alamat fee treasury; resolver (`src/config/treasury.mjs`) membaca var `_MAINNET` lebih dulu di mainnet.
- [x] Guard saldo minimum (`X402_MIN_TREASURY_USDC` / `X402_BLOCK_ON_LOW_TREASURY`) dihapus: saldo berapa pun tetap bisa membuat invoice dan refund.
- [ ] Deposit USDC ke alamat treasury untuk buffer biaya Gateway/CCTP (opsional, tidak lagi memblokir invoice).
- [ ] `AI_ROUTER_DELEGATE_PRIVATE_KEY_MAINNET` → delegate signer mainnet terpisah.
- [ ] Verifikasi `/api/x402/treasury-health` → `healthy: true`.

## 4. Env yang harus diisi setelah deploy

```text
# jaringan aktif (default testnet bila kosong)
ARC_NETWORK=mainnet

# kontrak ARCOX mainnet — hanya dari *_MAINNET
ARCOX_FEE_ROUTER_ADDRESS_MAINNET=0x9Fd14A94bDbEFf73EDB22853cc77416B65E2A0c0
ARCOX_ROUTER_FEE_BPS_MAINNET=500
# Router per chain (dibaca backend/frontend di luar resolver Arc)
ARCOX_BASE_FEE_ROUTER_ADDRESS=0xD858f073FA09834b1d64C165afC2757F1DF2f019
ARCOX_ARBITRUM_FEE_ROUTER_ADDRESS=0xaF15a9fFdDB21A42Aa6175B8130aE69ce41C78F9
ARCOX_AMM_ROUTER_MAINNET=
# Swap Adapter proxy Arc mainnet (impl 0xA6EeE6c9…1274, ProxyAdmin 0x88103781…a4EA)
ARCOX_SWAP_ADAPTER_MAINNET=0x8bc25dB1feda8Fc5eB20d0117Ff1f965F2F4E29C
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

Catatan: `mainnet-sources/` dan `mainnet:plan` adalah bagian dari release ini;
keduanya read-only.

`ARC_RPC_URL`, `CANTEEN_RPC_URL`, dan `ARC_RPC_DRPC` **diabaikan** saat mainnet:
RPC diambil dari `ARC_MAINNET_RPC_URL` bila diset, kalau tidak dari
`https://rpc.mainnet.arc.io`. MSCA mainnet hanya mendukung chain `arc-mainnet`.

## 5. Verifikasi berjenjang (tanpa broadcast dulu)

1. **Statis** — `npm test` (340 tes) hijau; `npm run check` hijau.
2. **Read-only** — `npm run probe:mainnet` → 22 lulus / 0 blocker (probe 26 Sep 2026).
3. **Konfigurasi** — jalankan satu instance di port uji (`PORT=3999 node --env-file=.env server.mjs`)
   dengan `ARC_NETWORK=mainnet`, lalu cek `/health`, `/api/x402/config`
   (`network: arc-mainnet`, `chainId: 5042`), dan `/api/agents/status`.
4. **Eth_call** — baca `owner()`, `treasury()`, `usdc()`, `tokenMessenger()`,
   `supportedDestinationDomains(26)` pada router mainnet (tanpa transaksi).
5. **Satu pembayaran kecil** — 0.005–0.02 USDC via MSCA (invoice → pay →
   reconcile → unlock data) + jalur refund.
6. **Baru kemudian** restart unit produksi dengan `ARC_NETWORK=mainnet`.

### 5.1 Status aktivasi env (26 Sep 2026)

- `.env` produksi VPS sudah mainnet: `ARC_NETWORK=mainnet`,
  `ARCOX_FEE_ROUTER_ADDRESS_MAINNET`, `ARCOX_ROUTER_FEE_BPS_MAINNET=500`,
  `ARCOX_SWAP_ADAPTER_MAINNET`, `CIRCLE_ENV=live`, `CIRCLE_BASE_URL=https://api.circle.com`,
  `X402_MODE=arc_mainnet`, `X402_NETWORK=arc-mainnet`, `X402_CHAIN_ID=5042`,
  `CIRCLE_X402_NETWORK=arc-mainnet`. Backup: `.env.bak-20260926-112802`.
- `npm run probe:mainnet` → **22 lulus / 0 blocker**. Instance uji (`PORT=3999`) dan
  produksi (`arc-dex-api.service`) start bersih; `npm test` 340/340 hijau.
- Bug boot mainnet ditemukan & diperbaiki: `BRIDGE_CHAIN_DEF.Arc_Testnet` memanggil
  `arcBridgeChain()` saat module load, padahal fungsi itu melempar 503 di mainnet →
  server crash sebelum listen. Nilainya kini getter lazy (error tetap jelas saat
  endpoint dipakai).
- `/api/x402/treasury-health` = `healthy:false` (`totalUsdc 0 < 2`) — fail-closed,
  sesuai rencana sampai treasury mainnet diisi.
- Catatan: kode belum membaca `ARCOX_TREASURY_WALLET_ADDRESS_MAINNET` /
  `AI_ROUTER_DELEGATE_PRIVATE_KEY_MAINNET` (treasury & delegate masih dibaca dari
  var non-suffixed) — perlu keputusan sebelum x402 mainnet diaktifkan penuh.
- Rollback: `cp .env.bak-20260926-112802 .env && sudo systemctl restart arc-dex-api`.

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
