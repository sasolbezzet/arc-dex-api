# Circle Wallets & Contracts Webhooks

Endpoint:

```text
POST /api/webhooks/circle-wallet
```

Satu endpoint ini menerima seluruh notifikasi Circle Wallets, Modular Wallets,
dan Contracts (Smart Contract Platform) yang dipakai ARCOX, sehingga tidak perlu
subscription terpisah per produk.

Referensi resmi:

- Daftar `notificationTypes` + envelope:
  `developers.circle.com/api-reference/contracts/common/create-subscription`
- Payload `contracts.eventLog` (Arc):
  `docs.arc.io/arc/tutorials/monitor-contract-events`
- Verifikasi signature (`X-Circle-Signature` + `X-Circle-Key-Id`, public key dari
  `/v2/notifications/publicKey/{id}`).

## Notification types yang didukung

| Family | Event |
| --- | --- |
| `transactions` | `transactions.inbound`, `transactions.outbound` |
| `challenges` | `challenges.accelerateTransaction`, `challenges.cancelTransaction`, `challenges.changePin`, `challenges.contractExecution`, `challenges.createTransaction`, `challenges.createWallet`, `challenges.initialize`, `challenges.restorePin`, `challenges.setPin`, `challenges.setSecurityQuestions` |
| `contracts` | `contracts.eventLog` |
| `modularWallet` | `modularWallet.userOperation`, `modularWallet.inboundTransfer`, `modularWallet.outboundTransfer` |
| `travelRule` | `travelRule.statusUpdate`, `travelRule.deny`, `travelRule.approve` |
| `rampSession` | `rampSession.completed`, `rampSession.depositReceived`, `rampSession.expired`, `rampSession.failed`, `rampSession.kycApproved`, `rampSession.kycRejected`, `rampSession.kycSubmitted` |
| test | `webhooks.test` |

Alias yang juga diterima (dipakai Console/Wildcard Circle): `*`,
`<family>.*`, dan nama family tanpa titik (`transactions`, `challenges`,
`contracts`, `modularWallet`, `travelRule`, `rampSession`).

Catatan: `webhooks.test` diterima di endpoint, tetapi **tidak boleh** dimasukkan ke
`notificationTypes` — API LIVE menolaknya dengan `API parameter invalid`. Event uji
itu dipicu lewat operasi `POST /v2/notifications/subscriptions/{id}/test` milik
subscription sendiri.

Sumber kebenaran ada di `src/services/circleWalletWebhookService.mjs`
(`CIRCLE_NOTIFICATION_CATALOG`). `GET /api/webhooks/circle-wallet` mempublikasikan
daftar yang harus dicentang di Circle Console.

## Envelope

```json
{
  "subscriptionId": "uuid",
  "notificationId": "uuid",
  "notificationType": "transactions.inbound",
  "notification": { "…": "bentuk bergantung notificationType" },
  "timestamp": "2023-11-07T05:31:56Z",
  "version": 2
}
```

`contracts.eventLog` membawa `contractAddress`, `blockchain`, `txHash`,
`userOpHash`, `blockHash`, `blockHeight`, `eventSignature`, `eventSignatureHash`,
`topics[]`, `data`, `logIndex`, dan `firstConfirmDate`.

## Cara memproses

1. Verifikasi signature; gagal → `401`.
2. `notificationId` wajib ada; kalau tidak → `400`.
3. Cek tipe lewat `isSupportedCircleNotificationType`; tipe di luar catalog →
   `400` (+ daftar tipe yang didukung).
4. Normalisasi envelope (`normalizeCircleNotification`) → `family`, `subtype`,
   `status`, hash, alamat, dan field per-family.
5. Simpan raw payload + ringkasan lebih dulu (`saveGenericWebhookEvent`), lalu
   dedupe berdasarkan `notificationId`.
6. Rekonsiliasi hash tx/userOp ke approval bridge
   (`reconcileCircleWalletWebhook`). Webhook hanya petunjuk: status akhir tetap
   ditentukan receipt + attestation CCTP, bukan notifikasi ini.
7. Balas `200` walau tidak ada approval yang cocok.

Response `POST` memuat `family`, `status`, `txHash`, `userOpHash`, `walletAddress`,
`notification` (ringkasan ternormalisasi), `reconciliation`, dan `autoMint`.

## Inbox & status (`GET /api/webhooks/events`)

Owner-authenticated. Query: `family`, `type`, `status`, `limit` (maks 200),
`provider` (default `circle-wallets`).

```json
{
  "ok": true,
  "total": 12,
  "families": { "challenges": 4, "rampSession": 2, "transactions": 6 },
  "state": {
    "challenges":   [{ "challengeId": "…", "status": "failed", "failed": true, "succeeded": false, "occurrences": 2, "updatedAt": "…" }],
    "rampSessions": [{ "sessionId": "…", "kycStatus": "APPROVED", "failed": false, "succeeded": true, "occurrences": 2, "updatedAt": "…" }],
    "failures":     [{ "eventType": "rampSession.kycRejected", "family": "rampSession", "status": null, "subjectId": "…", "createdAt": "…" }]
  },
  "events": [ { "eventType": "…", "family": "…", "subtype": "…", "status": "…", "processed": true, "reference": { "txHash": "…", "challengeId": null, "sessionId": null } } ]
}
```

Aturan:

- `state` dihitung dari **seluruh** event provider ini, bukan hasil filter, supaya
  ringkasan tetap utuh saat UI memfilter satu family.
- `state` adalah status TERKINI per `challengeId`/`sessionId`; `failed`/`succeeded`
  mengikuti event terbaru (bukan sticky), plus jumlah `occurrences`.
- Hasil negatif dibaca dari subtype (`rampSession.kycRejected`, `…expired`,
  `…failed`) **atau** dari `status` payload (`FAILED`, `REVERTED`, `DENIED`, …).
- `failures` = event negatif terbaru, dipakai UI untuk menampilkan peringatan.
- Payload mentah dan alamat wallet **tidak pernah** ikut di response.

UI-nya adalah kartu “🔔 Webhook Inbox” di halaman Info
(`src/components/WebhookInboxPanel.tsx`): filter per family, banner merah saat ada
kegagalan, dan daftar status challenge + ramp session.

## Aksi saat event gagal (alert)

Event bernilai negatif diproses lewat `handleCircleNotificationOutcome`
(`src/services/circleNotificationOutcome.mjs`) — jalur yang sama dipakai endpoint
asli maupun simulasi:

1. Alert tersimpan di vault, terikat **owner** (`vault.webhookFailures`):
   `family`, `eventType`, `status`, `subjectId`, `count`, `ts`, `simulated`,
   `addressSource`, `acknowledged`. Dedupe 30 menit per
   `(family, subjectId|eventType)` — event ulangan menaikkan `count`, bukan
   menambah baris.

   Atribusi owner memakai `walletAddress`. Ramp session biasanya hanya membawa
   `depositAddress`, jadi field itu dipakai sebagai fallback **hanya** untuk
   family `rampSession` dan asalnya dicatat di `addressSource`. Tanpa alamat yang
   sah, event tetap tersimpan di inbox tetapi tidak menghasilkan alert milik
   siapa pun.
2. `webhook_failure` ditulis ke log aktivitas owner.
3. Notifikasi eksternal dikirim (lihat bawah).

Endpoint owner-scoped:

| Endpoint | Fungsi |
| --- | --- |
| `GET /api/webhooks/alerts` | daftar alert belum di-ack (`?includeAcknowledged=true` untuk semua) |
| `POST /api/webhooks/alerts/:id/ack` | tandai alert sudah ditangani |

UI: blok merah “⚠ N alert wallet perlu tindakan” di kartu Webhook Inbox, lengkap
 dengan tombol **Acknowledge**.

Batas tegas: helper ini **tidak memindahkan dana** dan **tidak membatalkan
approval**. Rekonsiliasi approval tetap hanya lewat hash tx/userOp yang cocok.

## Notifikasi eksternal

`src/services/webhookAlertNotifier.mjs` mengirim ringkasan kegagalan ke semua
target yang aktif:

- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` → pesan Telegram.
- `WEBHOOK_ALERT_URL` → `POST` JSON generik (Slack/Discord/n8n), body
  `{ text, alert }`.

Sifatnya best-effort: tidak pernah melempar error (jalur webhook tetap balas
`200`), timeout 8 detik, dan di-throttle 10 menit per `(family, subjectId)` agar
retry Circle tidak membanjiri chat. Tanpa target dikonfigurasi ⇒ no-op.

## Menguji dengan event tiruan

Circle memegang private key-nya, jadi event tiruan **tidak bisa** ditandatangani
seperti event asli — mengirim payload buatan ke endpoint webhook akan ditolak
`401`. Dua jalur simulasi:

```bash
# Jalan pintas di VPS: tulis ke WEBHOOK_DB lewat jalur normalisasi + alert yang
# sama dengan endpoint asli (tanpa env tambahan).
npm run webhook:simulate -- --local
npm run webhook:simulate -- --local --purge

# Lewat HTTP: sekaligus menguji auth/token, butuh WEBHOOK_SIMULATION_SECRET.
npm run webhook:simulate -- --http --url https://arcoxdex.vercel.app
```

Event tiruan selalu ditandai `simulated: true` sehingga terlihat di inbox
(“· simulasi”) dan bisa dibersihkan dengan `--purge`. Endpoint
`POST/DELETE /api/webhooks/simulate` digerbangi `WEBHOOK_SIMULATION_SECRET`
(dinonaktifkan secara default, terpisah dari `ENABLE_DEV_TOOLS`).

## Mendaftarkan subscription

```bash
npm run webhook:register -- --list               # lihat subscription aktif
npm run webhook:register -- --dry                # cetak request tanpa memanggil Circle
npm run webhook:register                          # buat subscription baru
npm run webhook:register -- --update <id>         # sinkronkan notificationTypes
npm run webhook:register -- --test <id>           # kirim test notification
npm run webhook:register -- --endpoint https://…/api/webhooks/circle-wallet
```

Endpoint diambil dari `CIRCLE_WEBHOOK_ENDPOINT`, `WEBHOOK_PUBLIC_URL`, atau
`SERVER_URL` (ditambah path `/api/webhooks/circle-wallet`). Endpoint harus HTTPS
dan publik. Script memakai API key sesuai jaringan aktif
(`CIRCLE_API_KEY` / `CIRCLE_API_KEY_MAINNET`) dan tidak pernah mencetak nilainya.

`notificationTypes` yang didaftarkan adalah wildcard per family
(`transactions.*`, `challenges.*`, `contracts.*`, `modularWallet.*`,
`travelRule.*`, `rampSession.*`). Wildcard `*` (unrestricted) ditolak karena
Circle mencoba memverifikasi endpoint lebih dulu dan verifikasi itu gagal
(`Failed to verify endpoint … because response timeout`, 29 Sep 2026). Selain
itu `*` juga mengirim family di luar handler ini (mis. `gateway.*`), yang akan
dijawab `400`. Karena itu daftar wildcard per family dipakai.

## Batasan

- Route ini sengaja tidak mengeksekusi transaksi apa pun; ia hanya mencatat,
  mencocokkan, dan membangunkan worker attestation auto-mint.
- `challenges.*` dan `rampSession.*` dicatat sebagai status terkini per challenge/
  ramp session (lihat `state` di inbox), bukan sebagai bukti settlement. Status
  akhir transaksi tetap ditentukan receipt + attestation.
- Aksi per-event yang tersedia sejauh ini adalah pelaporan status + rekonsiliasi
  hash ke approval bridge. Belum ada efek samping lain (mis. mengubah saldo).
- Route gateway (`gateway.*`) punya handler terpisah di
  `docs/circle-gateway-webhooks.md`.
