#!/usr/bin/env node
// Kirim event Circle TIRUAN (challenges / rampSession / contracts /
// modularWallet / transactions) untuk mengisi dan menguji tabel status inbox
// tanpa menunggu aktivitas nyata.
//
// Circle memegang private key-nya, jadi event tiruan tidak bisa ditandatangani
// seperti event asli. Karena itu ada dua mode:
//
//   --local   (default di VPS) tulis ke WEBHOOK_DB memakai normalisasi + jalur
//             alert yang sama dengan endpoint asli. Tidak butuh env tambahan.
//   --http    POST ke /api/webhooks/simulate. Butuh WEBHOOK_SIMULATION_SECRET
//             dan token owner, jadi sekaligus menguji lapisan HTTP-nya.
//
// Pemakaian:
//   npm run webhook:simulate -- --local
//   npm run webhook:simulate -- --local --purge
//   npm run webhook:simulate -- --http --url https://arcoxdex.vercel.app
//   npm run webhook:simulate -- --http --url http://127.0.0.1:3001 --purge
//
// Event yang disuntikkan selalu ditandai `simulated: true` supaya bisa
// dibedakan di inbox dan dibersihkan dengan --purge.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getAddress, isAddress } from 'viem'
import { isSupportedCircleNotificationType, normalizeCircleNotification } from '../src/services/circleWalletWebhookService.mjs'
import { handleCircleNotificationOutcome } from '../src/services/circleNotificationOutcome.mjs'
import { mintOwnerToken } from '../src/services/authToken.mjs'

const DEFAULT_OWNER = process.env.SIMULATE_OWNER || '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'

const args = process.argv.slice(2)
const hasFlag = name => args.includes(name)
function argValue(name, fallback = '') {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  const value = args[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const owner = argValue('--owner', DEFAULT_OWNER)
if (!isAddress(owner)) {
  console.error(`❌ Alamat owner tidak valid: ${owner}`)
  process.exit(1)
}
const wallet = getAddress(owner)

const DB_PATH = process.env.WEBHOOK_DB || './webhook-events-db.json'

/** Satu set contoh yang menyentuh semua family yang diminta. */
function cannedEvents() {
  const tx = `0x${'ab'.repeat(32)}`
  const userOp = `0x${'cd'.repeat(32)}`
  return [
    { notificationType: 'transactions.inbound', notification: { id: 'sim-tx-in', amounts: ['12.5'], blockchain: 'ARC-TESTNET', state: 'CONFIRMED', walletAddress: wallet, txHash: tx } },
    { notificationType: 'transactions.outbound', notification: { id: 'sim-tx-out', amounts: ['1.25'], blockchain: 'ARC-TESTNET', state: 'COMPLETE', walletAddress: wallet, txHash: tx, userOpHash: userOp } },
    { notificationType: 'challenges.createWallet', notification: { id: 'sim-ch-create', status: 'COMPLETE', walletId: 'sim-wallet-1', walletAddress: wallet } },
    { notificationType: 'challenges.contractExecution', notification: { id: 'sim-ch-contract', status: 'COMPLETE', walletId: 'sim-wallet-1', walletAddress: wallet, txHash: tx } },
    { notificationType: 'challenges.createTransaction', notification: { id: 'sim-ch-tx', status: 'COMPLETE', walletId: 'sim-wallet-1', walletAddress: wallet } },
    { notificationType: 'challenges.setPin', notification: { id: 'sim-ch-fail', status: 'FAILED', walletId: 'sim-wallet-1', walletAddress: wallet } },
    { notificationType: 'contracts.eventLog', notification: { contractAddress: `0x${'11'.repeat(20)}`, blockchain: 'ARC-TESTNET', txHash: tx, eventSignature: 'Transfer(address,address,uint256)', topics: [`0x${'22'.repeat(32)}`], data: '0x', blockHeight: 23000000 } },
    { notificationType: 'modularWallet.userOperation', notification: { walletAddress: wallet, userOpHash: userOp, status: 'COMPLETE' } },
    { notificationType: 'modularWallet.inboundTransfer', notification: { walletAddress: wallet, txHash: tx, state: 'COMPLETE' } },
    { notificationType: 'modularWallet.outboundTransfer', notification: { walletAddress: wallet, txHash: tx, state: 'COMPLETE' } },
    { notificationType: 'rampSession.kycSubmitted', notification: { id: 'sim-ramp-1', kycStatus: 'SUBMITTED', depositAddress: wallet, amount: '25', currency: 'USDC' } },
    { notificationType: 'rampSession.kycApproved', notification: { id: 'sim-ramp-1', kycStatus: 'APPROVED', depositAddress: wallet, amount: '25', currency: 'USDC' } },
    { notificationType: 'rampSession.depositReceived', notification: { id: 'sim-ramp-1', status: 'DEPOSIT_RECEIVED', depositAddress: wallet, amount: '25', currency: 'USDC' } },
    { notificationType: 'rampSession.completed', notification: { id: 'sim-ramp-1', status: 'COMPLETED', depositAddress: wallet, amount: '25', currency: 'USDC' } },
    { notificationType: 'rampSession.failed', notification: { id: 'sim-ramp-2', status: 'FAILED', depositAddress: wallet, errorReason: 'simulated failure' } },
    { notificationType: 'rampSession.expired', notification: { id: 'sim-ramp-3', status: 'EXPIRED', depositAddress: wallet } },
  ]
}

function readDb() {
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDb(db) {
  // Read-modify-write singkat lalu rename atomik. Tidak memakai lock milik
  // server karena skrip ini dijalankan manual; jalankan saat trafik webhook
  // sedang sepi.
  const tmp = `${DB_PATH}.sim-${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(db, null, 2))
  renameSync(tmp, DB_PATH)
}

async function runLocal({ purge }) {
  const db = readDb()
  if (purge) {
    let removed = 0
    for (const [key, event] of Object.entries(db)) {
      if (event && typeof event === 'object' && event.simulated) { delete db[key]; removed += 1 }
    }
    writeDb(db)
    console.log(`🗑️  ${removed} event tiruan dihapus dari ${DB_PATH}`)
    return
  }
  const results = []
  for (const item of cannedEvents()) {
    if (!isSupportedCircleNotificationType(item.notificationType)) {
      results.push({ notificationType: item.notificationType, ok: false, error: 'unsupported' })
      continue
    }
    const notificationId = `sim_${item.notificationType}_${randomUUID().slice(0, 8)}`
    const payload = { subscriptionId: 'simulated', notificationId, notificationType: item.notificationType, notification: item.notification, timestamp: new Date().toISOString(), version: 2 }
    const normalized = normalizeCircleNotification(payload)
    db[notificationId] = {
      id: `wh_sim_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      provider: 'circle-wallets',
      notificationId,
      eventType: item.notificationType,
      rawPayload: payload,
      processed: true,
      matched: false,
      simulated: true,
      family: normalized.family,
      subtype: normalized.subtype || undefined,
      status: normalized.status || undefined,
      notification: normalized,
      createdAt: new Date().toISOString(),
    }
    const alert = await handleCircleNotificationOutcome(normalized, { simulated: true })
    results.push({ notificationType: item.notificationType, family: normalized.family, status: normalized.status || null, alertId: alert?.id || null })
  }
  writeDb(db)
  console.log(`✅ ${results.length} event tiruan ditulis ke ${DB_PATH}`)
  for (const result of results) {
    console.log(`   ${result.notificationType.padEnd(36)} ${result.family.padEnd(16)} ${result.status || '-'}${result.alertId ? '  ⚠ alert' : ''}`)
  }
  console.log('\nHapus kembali dengan: npm run webhook:simulate -- --local --purge')
}

async function runHttp({ url, purge }) {
  const secret = String(process.env.WEBHOOK_SIMULATION_SECRET || '')
  if (!secret) throw new Error('WEBHOOK_SIMULATION_SECRET belum di-set di environment')
  const token = mintOwnerToken(owner)
  if (!token) throw new Error('AUTH_SECRET tidak tersedia; jalankan dengan --env-file=.env')
  const endpoint = `${String(url).replace(/\/+$/, '')}/api/webhooks/simulate`
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Simulation-Secret': secret }
  if (purge) {
    const response = await fetch(endpoint, { method: 'DELETE', headers })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`Purge gagal (${response.status}): ${JSON.stringify(body)}`)
    console.log(`🗑️  ${body.removed} event tiruan dihapus via ${endpoint}`)
    return
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ events: cannedEvents() }) })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Simulasi gagal (${response.status}): ${JSON.stringify(body)}`)
  console.log(`✅ ${body.results.length} event tiruan dikirim ke ${endpoint}`)
  for (const result of body.results) {
    console.log(`   ${String(result.notificationType).padEnd(36)} ${result.family.padEnd(16)} ${result.status || '-'}${result.alertId ? '  ⚠ alert' : ''}`)
  }
}

const mode = hasFlag('--http') ? 'http' : 'local'
const url = argValue('--url', process.env.SERVER_URL || process.env.WEBHOOK_PUBLIC_URL || 'https://arcoxdex.vercel.app')
const purge = hasFlag('--purge')

const run = mode === 'http' ? runHttp({ url, purge }) : runLocal({ purge })
run.catch(error => {
  console.error(`❌ ${error.message}`)
  process.exitCode = 1
})
