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
- `challenges.*` dan `rampSession.*` dicatat sebagai status, bukan sebagai bukti
  settlement.
- Route gateway (`gateway.*`) punya handler terpisah di
  `docs/circle-gateway-webhooks.md`.
