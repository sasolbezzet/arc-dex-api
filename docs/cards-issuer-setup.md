# Cards — Setup Issuer Test Mode (Stripe / Lithic)

Dokumen ini menjelaskan apa yang perlu dilakukan **sekarang** untuk mengaktifkan
kartu Visa nyata (test mode) di ARCOX, di mana membuat API key, dan link
pendaftaran. Kode adapter sudah siap; yang dibutuhkan tinggal **test keys** dari
provider.

---

## Ringkasan: urutan yang harus dikerjakan

```
1. Daftar Stripe (atau Lithic)        ← 5–15 menit
2. Aktifkan Issuing / sandbox         ← dashboard
3. Ambil TEST API key                 ← dashboard, gratis
4. Kirim key ke developer ARCOX       ← setenv + deploy (saya yang pasang)
5. Uji: provision kartu test → belanja → webhook
```

> ⚠️ **Syarat akun** (penting!): **Stripe Issuing hanya tersedia untuk
> business di negara tertentu (US, UK, EU, CA, AU, SG, dsb.)**. Jika akun Stripe
> kamu terdaftar di Indonesia, Issuing **tidak muncul** di dashboard — gunakan
> **Lithic sandbox** sebagai jalur alternatif (tidak butuh riwayat, developer
> first, sandbox langsung aktif).

---

## Opsi A — Stripe Issuing (test mode)

### 1. Daftar akun Stripe (baru / pakai akun lama)
- Link pendaftaran: **https://dashboard.stripe.com/register**
- Konfirmasi email → dashboard terbuka.

### 2. Aktifkan Issuing
- Masuk **Dashboard → Settings → Issuing**:
  `https://dashboard.stripe.com/settings/issuing`
- Klik **Enable Issuing** (aktifkan program; untuk test mode tidak perlu
  approval bisnis yang lama — bisa langsung pakai test keys).
- Nanti di dashboard akan ada menu **Issuing** sidebar.
- ⚠️ Jika API mengembalikan `Your account is not set up to use Issuing`,
  berarti langkah ini belum selesai — buka
  `https://dashboard.stripe.com/issuing/overview` dan klik **Get started**
  sampai sidebar **Issuing** muncul, lalu ulangi test provision.

### 3. Ambil API keys (TEST MODE)
- **Developer → API keys**: `https://dashboard.stripe.com/apikeys`
- Pastikan toggle **"Test mode"** AKTIF (terlihat di pojok kanan atas).
- Salin **Secret key**: `sk_test_51...`
- (Public key `pk_test_...` tidak perlu untuk test card issuing via server;
  tapi tidak salah juga disalin.)

> Struktur:
> - Test keys: `sk_test_...`
> - Live keys: `sk_live_...` — **JANGAN** pernah berikan ke ARCODES test.

### 4. Kirim ke developer
- Berikan `STRIPE_SECRET_KEY` (test) → kami set di `.env` VPS & deploy.
- Opsional: `STRIPE_FUNDING_ACCOUNT` jika sudah punya funding account di
  Stripe Issuing (untuk top-up balance). Default cukup.

---

## Opsi B — Lithic (sandbox)

### 1. Buat akun
- Daftar: **https://www.lithic.com** → **Get started / Contact**
  (sandbox bisa dibuat langsung di dashboard setelah email terverifikasi)
- Dashboard sandbox: **https://sandbox.lithic.com**

### 2. Ambil API key (sandbox)
- Sandbox → **API Keys** (`sandbox-dashboard → Settings → API Keys`):
  kunci bentuk `lithic_test_...`
- Key ini bekerja langsung di `https://sandbox.lithic.com/v1` (sudah di adapter).

### 3. Kirim ke backend
- `LITHIC_API_KEY=lithic_test_...` (+ opsional `LITHIC_BIN=`) — set & deploy.

---

## Setelah key masuk (dilakukan oleh developer)

1. Set di `.env` VPS:
   ```
   CARD_PROVIDER=stripe          # atau lithic
   STRIPE_SECRET_KEY=sk_test_...
   # LITHIC_API_KEY=lithic_test_...
   ```
2. Restart systemd (`sudo systemctl restart arc-dex-api`).
3. Verifikasi: `GET /api/cards/config` → `issuer.configured: true`,
   `provider: "stripe"`.

---

## Alur uji setelah aktif

```
1. UI /cards → Create Card (masih kartu simulator lokal)
2. API POST /api/cards/:cardId/provision  → provider terbitkan kartu test nyata
   (PAN/CVV/exp asli provider, disimpan masked)
3. Belanja di merchant simulator → otomatis otorisasi via provider (test mode
   virtual network) atau langsung webhook event dari dashboard Stripe/Lithic
4. Webhook POST /api/cards/webhook → event auth/settlement/refund → timeline
```

> Catatan: di Stripe test mode, kartu test yang diterbitkan lewat API bisa
> disimulasikan langsung pada dashboard (Transaction → Simulate) untuk
> authorization/refund tanpa merchant luar.

---

## Checklist singkat sebelum live
- [ ] Akun Stripe/Lithic terdaftar (negara didukung)
- [ ] Issuing enabled (Stripe) / sandbox aktif (Lithic)
- [ ] Test keys disalin & sudah di-set di VPS
- [ ] `GET /api/cards/config` menampilkan issuer configured
- [ ] 1 kartu test di-issue → belanja kecil → webhook update timeline