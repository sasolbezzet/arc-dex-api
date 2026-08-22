# ARCOX x402 Mainnet Readiness

Checklist untuk memindahkan x402 monetization dari Arc Testnet ke Arc Mainnet.
Semua item di bawah bersifat persiapan/validasi; tidak ada yang men-deploy ke
mainnet sampai checklist ini lulus dan konfirmasi eksplisit diberikan.

## Status saat ini (testnet)

- Network: `Arc_Testnet` (chainId `5042002`), USDC `0x3600...`
- Payment: direct MSCA USDC transfer + Circle Unified Balance Gateway
- Treasury: `ARCOX_TREASURY_WALLET_ADDRESS` (testnet), balance di Gate way
- 25 tool Intel read-only, 62 service catalog, auto-refund, anti-abuse,
  circuit breaker, stats, treasury gate — semua teruji dengan real payment

## 1. Konfigurasi mainnet

- [ ] `X402_CHAIN_ID` / `ARC_CHAIN_ID` → chainId mainnet Arc (konfirmasi dari docs resmi Arc)
- [ ] `X402_USDC_ADDRESS` → alamat USDC mainnet Arc (bukan `0x3600...` testnet)
- [ ] `X402_MODE` → `arc_mainnet` (bukan `arc_real_testnet`)
- [ ] `X402_NETWORK` / `CIRCLE_X402_NETWORK` → network id Circle Gateway mainnet
- [ ] `CIRCLE_ENV` → `PROD` (bukan `TEST`); `CIRCLE_BASE_URL` → `https://api.circle.com`
- [ ] `CIRCLE_GATEWAY_BASE_URL` → gateway mainnet (`https://gateway-api.circle.com`)
- [ ] `ARKHAM_BASE_URL` tetap `https://api.arkm.com` (sama untuk kedua environment)
- [ ] `ALLOWED_ORIGINS` verifikasi tetap hanya `https://arcoxdex.vercel.app`
- [ ] `.env` production di VPS diperbarui + `arc-dex-api.service` direstart
- [ ] `.env.example` tidak pernah berisi secret mainnet

## 2. Treasury mainnet

- [ ] Buat wallet/Unified Balance treasury mainnet khusus (jangan pakai testnet)
- [ ] `ARCOX_TREASURY_WALLET_ADDRESS` → alamat treasury mainnet
- [ ] Deposit USDC mainnet minimal `X402_MIN_TREASURY_USDC` (default 2.0) + buffer biaya
- [ ] `AI_ROUTER_DELEGATE_PRIVATE_KEY` → delegate signer mainnet (terpisah dari testnet)
- [ ] Verifikasi `/api/x402/treasury-health` menampilkan `healthy: true` di mainnet
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
