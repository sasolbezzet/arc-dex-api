# ARCOX x402 Mainnet Readiness

Checklist untuk memindahkan x402 monetization dari Arc Testnet ke Arc Mainnet.
Semua item di bawah bersifat persiapan/validasi; tidak ada yang men-deploy ke
mainnet sampai checklist ini lulus dan konfirmasi eksplisit diberikan.

## Status 26 Sep 2026 (hasil `npm run probe:mainnet`, read-only)

**22 lulus / 0 blocker** (probe diperluas: kontrak ARCOX mainnet Arc ikut diperiksa). Blocker Console yang tersisa pada 24 Sep (aktivasi Gas
Station policy LIVE) sudah selesai: `pm_getPaymasterStubData` sekarang menerima
`paymaster + paymasterData`.

- ✅ Arc mainnet hidup: `eth_chainId = 0x13b2` (5042), blok > 22,5 juta, `https://rpc.mainnet.arc.io`
- ✅ Semua kontrak pihak Circle sudah ada di mainnet: USDC, EURC, USYC, Memo,
  ERC-8004 IdentityRegistry, CCTP TokenMessengerV2 + MessageTransmitterV2,
  Gateway Wallet + Minter
- ✅ Client Key LIVE: `arc` (0x13b2), `base` (0x2105), `arbitrum` (0xa4b1),
  EntryPoint v0.7 — jadi MSCA + passkey + bundler mainnet memakai key yang sama
- ✅ API Key LIVE (`CIRCLE_API_KEY_MAINNET`) diterima: `appId 7e9205d2-…`
- ✅ **Gas Station policy LIVE aktif** — sponsorship mainnet bisa dipakai
- ✅ Passkey domain LIVE sudah terdaftar: `rp_getRegistrationOptions` (LIVE) →
  `rp.name = arcoxdex.vercel.app` + challenge. Catatan probe: `rp_*` dilayani di
  base path `…/v1/rpc/w3s/buidl` **tanpa** slug chain; menambahkan `/arc`
  menghasilkan `Method not found`, dan memakai `/v1/rpc` dijawab edge `Lockout`
- ✅ Gateway mainnet terverifikasi: `https://gateway-api.circle.com` → domain 26,
  chain **`Arc`**, network `Mainnet`, Gateway Wallet `0x7777…00eE`,
  Minter `0x2222…C205` (testnet juga memakai nama chain `Arc`, dibedakan field
  `network`)
- ⏳ Kontrak ARCOX (Fee Router, AMM Router, Swap Adapter, ERC-8183) masih alamat
  testnet → **pekerjaan berikutnya, bukan kegagalan probe**. Rencana lengkap:
  `docs/arc-mainnet-deploy-plan.md`
- ⏳ Treasury mainnet belum dibuat.

Gunakan `npm run probe:mainnet` untuk mengulang seluruh pemeriksaan di atas
(read-only, aman, tanpa transaksi) setiap kali konfigurasi Console berubah.

## Status saat ini (testnet)

- Network: `Arc_Testnet` (chainId `5042002`), USDC `0x3600...`
- Payment: direct MSCA USDC transfer + Circle Unified Balance Gateway
- Treasury: `ARCOX_TREASURY_WALLET_ADDRESS` (testnet), balance di Gateway
- 25 tool Intel read-only, 62 service catalog, auto-refund, anti-abuse,
  circuit breaker, stats, treasury gate — semua teruji dengan real payment

## 1. Konfigurasi mainnet

Perpindahan jaringan sekarang dilakukan lewat **satu** saklar: `ARC_NETWORK=mainnet`
(atau `ARC_CHAIN_ID=5042`). Registry `src/config/arcNetwork.mjs` menurunkan chain id,
RPC, explorer, transport slug, token, kontrak Circle, dan nama chain Gateway dari
saklar itu — jadi env turunan di bawah **tidak perlu** diset satu per satu:

- ✅ `ARC_CHAIN_ID` / chain id → otomatis `5042` (`0x13b2`)
- ✅ `X402_USDC_ADDRESS` → otomatis USDC Arc mainnet (`0x3600...` sama di kedua jaringan)
- ✅ `CIRCLE_GATEWAY_BASE_URL` → otomatis `https://gateway-api.circle.com`
- ✅ `CIRCLE_BASE_URL` sandbox diabaikan di mainnet (otomatis `https://api.circle.com`)
- ✅ RPC → `ARC_MAINNET_RPC_URL` (opsional) lalu `https://rpc.mainnet.arc.io`;
  `ARC_RPC_URL`/`CANTEEN_RPC_URL` sengaja diabaikan di mainnet

Yang masih harus diset manual:

- [ ] `X402_MODE` → `arc_mainnet` (bukan `arc_real_testnet`)
- [ ] `CIRCLE_ENV` → `live` (bukan `TEST`)
- [ ] `CIRCLE_API_KEY_MAINNET` + `CIRCLE_CLIENT_KEY_LIVE` (kunci LIVE; di mainnet
      tidak ada fallback ke kunci sandbox)
- [ ] Kontrak ARCOX `*_MAINNET` + treasury mainnet (`docs/arc-mainnet-deploy-plan.md`)
- [ ] `ARKHAM_BASE_URL` tetap `https://api.arkm.com` (sama untuk kedua environment)
- [ ] `ALLOWED_ORIGINS` verifikasi tetap hanya `https://arcoxdex.vercel.app`
- [ ] `.env` production di VPS diperbarui + `arc-dex-api.service` direstart
- [ ] `.env.example` tidak pernah berisi secret mainnet

## 2. Treasury mainnet

- [ ] Buat wallet/Unified Balance treasury mainnet khusus (jangan pakai testnet)
- [ ] `ARCOX_TREASURY_WALLET_ADDRESS` → alamat treasury mainnet
- [x] Guard saldo minimum dihapus 26 Sep 2026 — pembayaran x402 jalan berapa pun saldo treasury; deposit hanya perlu buffer biaya Gateway/CCTP
- [ ] `AI_ROUTER_DELEGATE_PRIVATE_KEY` → delegate signer mainnet (terpisah dari testnet)
- [ ] Catatan: Auto Pay/Unified Balance mainnet saat ini hanya mendaftarkan chain
      `Arc` (satu-satunya yang terverifikasi lewat `/v1/info`). Chain mainnet lain
      sengaja belum didaftarkan supaya tidak diam-diam memakai nama chain testnet.
- [x] `/api/x402/treasury-health` selalu `healthy: true` di mainnet (informasional, tanpa gate)
- [ ] `X402_REFUND_DAILY_CAP_USDC` dan `X402_MAX_AUTO_REFUND_USDC` dikaji ulang
      (nilai testnet mungkin terlalu kecil/terlalu besar untuk mainnet)

## 3. Harga & ekonomi

- [ ] Kaji ulang semua `ARCOX_INTEL_PRICE_*` (0.005–0.05 testnet) untuk mainnet
- [ ] Pastikan harga >= biaya gas mainnet + fee Gateway per transaksi
- [ ] Hitung minimum deposit treasury agar N pembayaran dapat dilayani
- [ ] Putuskan apakah `X402_BASE_AMOUNT` tetap 0.005 atau dinaikkan

## 4. Pengujian mainnet (sebelum scale)

- [ ] Smoke test read-only tanpa payment: `/health`, `/api/x402/config`,
      `/api/intel/catalog`, `/api/intel/provider-health`, `/api/x402/openapi.json`
- [ ] 1–2 real payment kecil (0.005–0.02 USDC) via MSCA direct transfer:
      invoice → pay → reconcile → unlock → data Arkham
- [ ] 1 payment via Unified Balance Gateway (jika dipakai)
- [ ] Uji jalur refund: resource yang 404/5xx → `pending_review` →
      cooldown → `refund_approved` → execute → `refunded` + tx hash
- [ ] Verifikasi anti-abuse: cap invoice open per owner, cooldown (jika diset)
- [ ] Verifikasi circuit breaker: service 5xx berulang → `degraded` di catalog
- [ ] Verifikasi stats: `/api/x402/stats` menampilkan angka yang sesuai
- [ ] Cek webhook Circle mainnet (signature key mainnet) pada 1 payment

## 5. Rollback plan

- [ ] Simpan konfigurasi testnet terakhir (env + commit) untuk rollback cepat
- [ ] Jika mainnet gagal: kembalikan env testnet, restart service, verifikasi
      `/api/x402/config` kembali `arc_real_testnet`
- [ ] Tidak ada migrasi data yang diperlukan: invoice mainnet terpisah dari
      testnet (kolom network/chainId berbeda)

## 6. Operasional

- [ ] `monitor.sh` tetap aktif: alert down + treasury low balance
- [ ] Pantau `/api/x402/stats` setiap hari selama minggu pertama (refund rate,
      provider errors, revenue)
- [ ] Setelah stabil, pertimbangkan menaikkan `X402_MAX_UNPAID_PER_OWNER`
      jika ada keluhan legitimate user yang kena cap
- [ ] Update `sdk/README.md` dan OpenAPI spec dengan network mainnet

## Catatan

- Jangan pernah menyalin private key testnet ke mainnet (atau sebaliknya).
- Semua harga dan batas diverifikasi satu kali di mainnet dengan jumlah kecil
  sebelum mengumumkan layanan.
- Deployment mainnet dilakukan hanya setelah konfirmasi eksplisit operator.
