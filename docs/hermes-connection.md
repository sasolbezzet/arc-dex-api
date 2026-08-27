# Koneksi Hermes ke ARCOX DEX (Token Koneksi)

Flow resmi untuk Hermes adalah **Agent Terhubung → Buat Token Koneksi** di web ARCOX. User tidak perlu menjalankan `hermes mcp login arcox`, OAuth login khusus, atau menyalin token Passkey.

## 1. Buat token di web ARCOX

1. Buka `https://arcoxdex.vercel.app` dan masuk ke menu **Plugin**.
2. Pastikan Agent Wallet sudah aktif dengan Passkey.
3. Pada bagian **Agent Terhubung**, buka agent yang ingin digunakan.
4. Klik **Buat Token Koneksi**.
5. Salin token atau seluruh pesan setup yang tampil. Token hanya ditampilkan sekali.

Token ini adalah kredensial akses MCP untuk **satu agent dan satu Agent Wallet**. Token bukan private key, bukan token Passkey, dan jangan digunakan untuk agent lain.

## 2. Tambahkan MCP di Hermes dengan konfigurasi default

Tambahkan server MCP ARCOX melalui mekanisme konfigurasi MCP bawaan Hermes:

```yaml
mcp_servers:
  arcox:
    url: https://arcoxdex.vercel.app/mcp
    auth: header
    enabled: true
```

Saat Hermes meminta token header, tempel token yang baru dibuat dari menu **Buat Token Koneksi**.

Jangan menaruh token di `~/.arcox/agent.env` atau mengirimkannya ke chat publik. Simpan menggunakan penyimpanan credential bawaan Hermes.

## 3. Verifikasi

Gunakan pemeriksaan MCP bawaan Hermes atau mulai sesi baru. Pastikan server berhasil melakukan `initialize` dan `tools/list`.

Jika Hermes tidak melihat tools:

- pastikan URL tepat: `https://arcoxdex.vercel.app/mcp`;
- pastikan token dimulai dengan `arx_at_`;
- pastikan token belum pernah dirotasi atau dicabut;
- buat token baru dari agent yang sama, lalu perbarui credential Hermes;
- mulai sesi Hermes baru setelah konfigurasi berubah.

## 4. Isolasi dan revoke

Token koneksi terikat ke satu agent dan Agent Wallet. Token agent A tidak dapat digunakan sebagai token agent B.

- **Buat Token Koneksi**: menerbitkan token baru untuk agent yang dipilih dan merotasi token koneksi lama agent tersebut.
- **Cabut akses**: mematikan token access/refresh dan binding agent yang dipilih saja.
- Agent lain tetap aktif dan tidak ikut terdampak.

## 5. Eksekusi transaksi

Setelah koneksi aktif, Hermes harus meminta quote terlebih dahulu. Semua transaksi membutuhkan preview dan konfirmasi eksplisit sebelum eksekusi. Private key tetap berada di backend/runtime yang dikonfigurasi dan tidak dikirim ke Hermes.

## Catatan implementasi

Endpoint OAuth/device tetap tersedia di backend untuk kompatibilitas protokol dan client lain, tetapi bukan flow onboarding Hermes yang ditampilkan atau direkomendasikan pada web ARCOX.
