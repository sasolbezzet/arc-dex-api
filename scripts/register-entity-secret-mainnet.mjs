#!/usr/bin/env node
// Daftarkan entity secret Circle untuk environment LIVE (Arc mainnet).
//
// Entity secret terdaftar PER ENVIRONMENT: entity secret sandbox tidak dikenal
// oleh LIVE, dan Circle menolak dengan "The entity secret has not been set yet"
// — persis error yang membuat swap/bridge lewat Circle Wallet gagal di mainnet.
// Skrip ini melakukan setup satu kali sesuai dokumentasi resmi Circle
// (developers.circle.com/wallets/dev-controlled/register-entity-secret):
//
//   1. membuat entity secret acak 32 byte (64 hex) di mesin ini dan menulisnya
//      ke berkas lokal (mode 0600) SEBELUM memanggil Circle — registrasi tidak
//      idempotent, jadi secret tidak boleh hanya hidup di memori,
//   2. mendaftarkannya ke akun LIVE memakai CIRCLE_API_KEY_MAINNET,
//   3. menyimpan salinan entity secret + recovery file DI LUAR repo (mode 0600),
//   4. (opsional) menulis CIRCLE_ENTITY_SECRET_MAINNET ke .env dengan backup.
//
// Catatan SDK: `recoveryFileDownloadPath` harus berupa DIREKTORI (SDK menulis
// `recovery_file_<timestamp>.dat` di dalamnya). Mengirim path berkas membuat
// SDK melempar error setelah Circle sudah mendaftarkan secret, sehingga
// operator dapat merotasi ulang dengan aman (registrasi ulang = rotasi).
//
// Nilai entity secret TIDAK pernah dicetak ke stdout.
//
// Pemakaian:
//   node --env-file=.env scripts/register-entity-secret-mainnet.mjs --confirm [--write-env]
//
// Tanpa --confirm skrip hanya menjelaskan dan keluar (dry run).

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const ENV_FILE = join(PROJECT_ROOT, '.env')
const OUT_DIR = process.env.ENTITY_SECRET_OUT_DIR || join(homedir(), '.arcox')

const confirmed = process.argv.includes('--confirm')
const writeEnv = process.argv.includes('--write-env')
const apiKey = String(process.env.CIRCLE_API_KEY_MAINNET || '').trim()

if (!apiKey) {
  console.error('CIRCLE_API_KEY_MAINNET belum diset. Jalankan dengan --env-file=.env.')
  process.exit(1)
}
if (!apiKey.startsWith('LIVE_API_KEY:')) {
  // Kunci testnet tidak boleh dipakai untuk setup produksi.
  console.error('CIRCLE_API_KEY_MAINNET harus API key LIVE (prefix LIVE_API_KEY:). Dibatalkan.')
  process.exit(1)
}
if (!confirmed) {
  console.log('Dry run. Skrip ini akan:')
  console.log('  • membuat entity secret acak 32 byte (64 hex)')
  console.log(`  • mendaftarkannya ke akun Circle LIVE dan mengunduh recovery file ke ${OUT_DIR}`)
  console.log('  • menyimpan salinan entity secret (mode 0600) di folder yang sama')
  if (writeEnv) console.log('  • menulis CIRCLE_ENTITY_SECRET_MAINNET ke .env (dengan backup .env.bak-*)')
  console.log('\nJalankan ulang dengan --confirm untuk mengeksekusi.')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(OUT_DIR, { recursive: true })
const secretNotePath = join(OUT_DIR, `circle-entity-secret-live-${stamp}.txt`)

// 32 byte acak → 64 karakter hex (format entity secret Circle).
const entitySecret = randomBytes(32).toString('hex')

// Tulis secret lebih dulu: kalau proses mati di tengah jalan (mis. kegagalan
// unduh recovery file) nilai ini tetap bisa diselamatkan operator.
writeFileSync(secretNotePath, [
  `Circle LIVE entity secret (CIRCLE_ENTITY_SECRET_MAINNET) — dibuat ${new Date().toISOString()}`,
  `Status awal: PENDING (belum dikonfirmasi terdaftar).`,
  '',
  entitySecret,
  '',
  `Recovery file ditulis SDK ke ${OUT_DIR}/recovery_file_<timestamp>.dat`,
  'Simpan berkas ini dan recovery file di tempat aman. Jangan commit ke repo.',
  '',
].join('\n'), { mode: 0o600 })
chmodSync(secretNotePath, 0o600)

let response
let failed = false
try {
  response = await registerEntitySecretCiphertext({
    apiKey,
    entitySecret,
    // SDK menulis `recovery_file_<timestamp>.dat` di dalam direktori ini.
    recoveryFileDownloadPath: OUT_DIR,
  })
} catch (error) {
  failed = true
  console.error('❌ Registrasi entity secret gagal:', error?.message || error)
  console.error(`   Secret yang dibuat tersimpan di: ${secretNotePath}`)
  console.error('   Registrasi tidak idempotent: cukup jalankan ulang skrip ini untuk merotasi.')
  process.exit(1)
}

const recoveryFile = response?.data?.data?.recoveryFile || response?.data?.recoveryFile || ''
writeFileSync(secretNotePath, [
  `Circle LIVE entity secret (CIRCLE_ENTITY_SECRET_MAINNET) — dibuat ${new Date().toISOString()}`,
  'Status: TERDAFTAR di environment LIVE.',
  '',
  entitySecret,
  '',
  `Recovery file: ${OUT_DIR}/ (recovery_file_<timestamp>.dat)`,
  'Simpan berkas ini dan recovery file di tempat aman. Jangan commit ke repo.',
  '',
].join('\n'), { mode: 0o600 })

if (!failed && !recoveryFile) console.warn('⚠️  Circle tidak mengembalikan recovery file; entity secret tetap tersimpan lokal.')
console.log('✅ Entity secret LIVE terdaftar.')
console.log(`   recovery file : ${OUT_DIR} (recovery_file_<timestamp>.dat)`)
console.log(`   salinan secret: ${secretNotePath}`)
console.log('   (nilai entity secret tidak pernah dicetak di sini)')

if (writeEnv) {
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const backup = `${ENV_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  writeFileSync(backup, current, { mode: 0o600 })
  const line = `CIRCLE_ENTITY_SECRET_MAINNET=${entitySecret}`
  const next = /^CIRCLE_ENTITY_SECRET_MAINNET=/m.test(current)
    ? current.replace(/^CIRCLE_ENTITY_SECRET_MAINNET=.*$/m, line)
    : `${current.replace(/\s*$/, '')}\n# Entity secret LIVE (didaftarkan ${new Date().toISOString()}); berbeda dari CIRCLE_ENTITY_SECRET sandbox.\n${line}\n`
  writeFileSync(ENV_FILE, next, { mode: 0o600 })
  chmodSync(ENV_FILE, 0o600)
  console.log(`\n✅ .env diperbarui (backup: ${backup}) → CIRCLE_ENTITY_SECRET_MAINNET diset.`)
  console.log('   Restart service agar nilai baru dipakai: sudo systemctl restart arc-dex-api')
}
