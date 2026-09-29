#!/usr/bin/env node
// Daftarkan webhook Circle (Programmable/Modular Wallets + Contracts) ke endpoint
// ARCOX di `POST /api/webhooks/circle-wallet`.
//
// Referensi resmi:
//  - developers.circle.com/api-reference/contracts/common/create-subscription
//  - docs.arc.io/arc/tutorials/monitor-contract-events (payload contracts.eventLog)
//
// Pemakaian:
//   npm run webhook:register                 # buat subscription baru
//   npm run webhook:register -- --list       # lihat subscription yang ada
//   npm run webhook:register -- --dry        # cetak request saja, tanpa memanggil Circle
//   npm run webhook:register -- --update <id>
//   npm run webhook:register -- --test <id>
//   npm run webhook:register -- --delete <id>
//   npm run webhook:register -- --endpoint https://contoh/api/webhooks/circle-wallet
//   npm run webhook:register -- --types transactions.*,challenges.*
//
// API key TIDAK pernah dicetak. Endpoint harus HTTPS dan publik.
//
// Catatan: satu endpoint boleh menerima campuran event Wallets, Contracts, dan
// Modular Wallet — itulah yang dipakai ARCOX supaya semua event mendarat di
// handler yang sama.

import { arcCircleApiKey, arcCircleBaseUrl } from '../src/config/arcNetwork.mjs'
import { CIRCLE_NOTIFICATION_CATALOG, CIRCLE_SUBSCRIPTION_NOTIFICATION_TYPES } from '../src/services/circleWalletWebhookService.mjs'

const WEBHOOK_PATH = '/api/webhooks/circle-wallet'

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value && !value.startsWith('--') ? value : true
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function resolveEndpoint() {
  const explicit = argValue('--endpoint')
  if (typeof explicit === 'string') return explicit
  const fromEnv = String(process.env.CIRCLE_WEBHOOK_ENDPOINT || process.env.WEBHOOK_PUBLIC_URL || '').trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '').endsWith(WEBHOOK_PATH) ? fromEnv.replace(/\/+$/, '') : `${fromEnv.replace(/\/+$/, '')}${WEBHOOK_PATH}`
  const serverUrl = String(process.env.SERVER_URL || '').trim()
  if (serverUrl) return `${serverUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`
  return ''
}

function resolveTypes() {
  const types = argValue('--types')
  if (typeof types === 'string') return types.split(',').map(type => type.trim()).filter(Boolean)
  return [...CIRCLE_SUBSCRIPTION_NOTIFICATION_TYPES]
}

async function circleFetch(path, { method = 'GET', body } = {}) {
  const apiKey = arcCircleApiKey()
  if (!apiKey) throw new Error('Circle API key tidak tersedia untuk jaringan aktif (CIRCLE_API_KEY / CIRCLE_API_KEY_MAINNET)')
  const response = await fetch(`${arcCircleBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  let payload = {}
  try { payload = text ? JSON.parse(text) : {} } catch { payload = { raw: text } }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `HTTP ${response.status}`
    throw new Error(`Circle API ${method} ${path} gagal: ${message}`)
  }
  return payload?.data ?? payload
}

function printCatalog() {
  console.log('Notification types yang akan disubscribe:')
  for (const [family, types] of Object.entries(CIRCLE_NOTIFICATION_CATALOG)) {
    console.log(`  ${family}:`)
    for (const type of types) console.log(`    - ${type}`)
  }
}

async function main() {
  const base = process.argv.slice(2)
  const endpoint = resolveEndpoint()
  const types = resolveTypes()

  if (hasFlag('--list')) {
    const data = await circleFetch('/v2/notifications/subscriptions')
    const subscriptions = data?.subscriptions || (Array.isArray(data) ? data : [])
    console.log(`Subscription Circle (${subscriptions.length}):`)
    for (const subscription of subscriptions) {
      console.log(`  ${subscription.id}  ${subscription.enabled === false ? 'disabled' : 'enabled'}  ${subscription.restricted ? 'restricted' : 'unrestricted'}  ${subscription.endpoint}`)
      console.log(`    types: ${(subscription.notificationTypes || []).join(', ') || '(unrestricted)'}`)
    }
    return
  }

  const deleteId = argValue('--delete')
  if (typeof deleteId === 'string') {
    await circleFetch(`/v2/notifications/subscriptions/${encodeURIComponent(deleteId)}`, { method: 'DELETE' })
    console.log(`🗑️  Subscription ${deleteId} dihapus.`)
    return
  }

  const testId = argValue('--test')
  if (typeof testId === 'string') {
    await circleFetch(`/v2/notifications/subscriptions/${encodeURIComponent(testId)}/test`, { method: 'POST' })
    console.log(`🧪 Test notification dikirim untuk subscription ${testId}. Cek log endpoint.`)
    return
  }

  const updateId = argValue('--update')
  const payload = { endpoint: endpoint || undefined, notificationTypes: types }
  if (!endpoint && typeof updateId !== 'string') {
    throw new Error('Endpoint belum diketahui. Set WEBHOOK_PUBLIC_URL / SERVER_URL / CIRCLE_WEBHOOK_ENDPOINT atau pakai --endpoint.')
  }

  console.log(`Endpoint : ${endpoint || '(tetap)'}`)
  console.log(`Types    : ${types.join(', ')}`)
  printCatalog()

  if (hasFlag('--dry')) {
    console.log('\n--dry: request tidak dikirim. Body yang akan dipakai:')
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (typeof updateId === 'string') {
    const updated = await circleFetch(`/v2/notifications/subscriptions/${encodeURIComponent(updateId)}`, { method: 'PUT', body: { notificationTypes: types } })
    console.log(`\n✅ Subscription ${updated?.id || updateId} diperbarui (types: ${(updated?.notificationTypes || types).join(', ')}).`)
    return
  }

  const created = await circleFetch('/v2/notifications/subscriptions', { method: 'POST', body: payload })
  console.log(`\n✅ Subscription dibuat: ${created?.id}. restricted=${created?.restricted} enabled=${created?.enabled}`)
  console.log('   Verifikasi URL di: Developer Console → Webhooks, lalu kirim test notification.')
}

main().catch((error) => {
  console.error(`❌ ${error.message}`)
  process.exitCode = 1
})
