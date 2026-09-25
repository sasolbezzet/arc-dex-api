#!/usr/bin/env node
// Pre-flight Arc Mainnet — HANYA baca (read-only). Tidak ada transaksi, tidak
// ada wallet baru, tidak ada perubahan state. Aman dijalankan kapan saja.
//
// Menjawab: "apakah Arc mainnet sudah siap dipakai, dan apa yang masih
// memblokir?" — supaya persiapan mainnet terukur, bukan dugaan.
//
// Pemakaian:
//   npm run probe:mainnet
//
// Nilai key tidak pernah dicetak.

const ARC_MAINNET_RPC = process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io'
const ARC_MAINNET_CHAIN_ID = '0x13b2' // 5042
const MODULAR_RPC = (process.env.CIRCLE_CLIENT_URL || 'https://modular-sdk.circle.com/v1/rpc/w3s/buidl').replace(/\/+$/, '')
// rp_* (passkey) dilayani di base path TANPA slug chain; menambahkan `/arc`
// menghasilkan `Method not found`. Jadi base = URL `buidl` tanpa slug.
const MODULAR_BASE = MODULAR_RPC
const CIRCLE_API_BASE = 'https://api.circle.com'
const APP_INFO = 'platform=web;version=1.0.15;uri=arcoxdex.vercel.app'
const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032'

// Kontrak pihak Circle: harus sudah ada di Arc mainnet.
const CIRCLE_CONTRACTS = [
  ['USDC', '0x3600000000000000000000000000000000000000'],
  ['EURC', '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'],
  ['USYC', '0x8a5D989Bbb96929F689B0200f435f53dA42bF490'],
  ['Memo', '0x5294E9927c3306DcBaDb03fe70b92e01cCede505'],
  ['ERC-8004 IdentityRegistry', '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'],
  ['CCTP TokenMessengerV2', '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'],
  ['CCTP MessageTransmitterV2', '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'],
  ['Gateway Wallet', '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'],
  ['Gateway Minter', '0x2222222d7164433c4C09B0b0D809a9b52C04C205'],
]

// Kontrak ARCOX sendiri: saat ini hanya ada di testnet, wajib deploy ulang.
const ARCOX_CONTRACTS = [
  ['ARCOX Fee Router', '0xDf800310443BEB589CEf91A09854203Ea36e43a7'],
  ['ARCOX AMM Router', '0x9f2443691bddd8343590c68e2a2cdec5fd0b6124'],
  ['ARCOX Swap Adapter', '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b'],
  ['ERC-8183 Agentic Commerce', '0x0747EEf0706327138c69792bF28Cd525089e4583'],
]

const results = []
function record(ok, label, detail = '') {
  results.push({ ok, label, detail })
  console.log(`  ${ok === null ? '•' : ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function jsonRpc(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'probe', ...body }),
  })
  const text = await res.text()
  try { return { status: res.status, payload: JSON.parse(text) } }
  catch { return { status: res.status, payload: null, text: text.slice(0, 120) } }
}

async function checkArcRpc() {
  console.log('\n── Arc mainnet RPC')
  try {
    const chain = await jsonRpc(ARC_MAINNET_RPC, { method: 'eth_chainId', params: [] })
    const chainId = chain.payload?.result
    record(chainId === ARC_MAINNET_CHAIN_ID, `eth_chainId = ${chainId}`, `${ARC_MAINNET_RPC} (harus ${ARC_MAINNET_CHAIN_ID} / 5042)`)

    const block = await jsonRpc(ARC_MAINNET_RPC, { method: 'eth_blockNumber', params: [] })
    const height = Number.parseInt(block.payload?.result || '0x0', 16)
    record(height > 0, `blok terakhir = ${height}`, 'RPC hidup dan tersinkron')
  } catch (error) {
    record(false, 'RPC mainnet tidak dapat dihubungi', error.message)
  }
}

async function codeAt(address) {
  try {
    const res = await jsonRpc(ARC_MAINNET_RPC, { method: 'eth_getCode', params: [address, 'latest'] })
    const code = res.payload?.result || '0x'
    return code.length > 2 ? code.length : 0
  } catch { return 0 }
}

async function checkContracts() {
  console.log('\n── Kontrak di Arc mainnet')
  for (const [label, address] of CIRCLE_CONTRACTS) {
    const size = await codeAt(address)
    record(size > 0, `${label} ada`, `${address}${size ? ` (${size} byte)` : ' — kode kosong'}`)
  }
  console.log('\n── Kontrak ARCOX (harus di-deploy ulang ke mainnet)')
  for (const [label, address] of ARCOX_CONTRACTS) {
    const size = await codeAt(address)
    // Belum di-deploy = sesuai harapan saat ini; yang penting terlihat jelas.
    record(null, `${label} ${size > 0 ? 'SUDAH ada' : 'belum di-deploy'}`, `${address} (alamat testnet — mainnet butuh alamat baru)`)
  }
}

async function checkLiveClientKey() {
  console.log('\n── Client Key LIVE (passkey/MSCA/paymaster mainnet)')
  const key = process.env.CIRCLE_CLIENT_KEY_LIVE || ''
  if (!key) {
    record(false, 'CIRCLE_CLIENT_KEY_LIVE belum diset')
    return
  }
  for (const [label, slug, expected] of [['Arc mainnet', 'arc', '0x13b2'], ['Base', 'base', '0x2105'], ['Arbitrum', 'arbitrum', '0xa4b1']]) {
    const res = await jsonRpc(`${MODULAR_RPC}/${slug}`, { method: 'eth_chainId', params: [] }, { authorization: `Bearer ${key}`, 'X-AppInfo': APP_INFO })
    record(res.payload?.result === expected, `${label} eth_chainId = ${res.payload?.result}`, expected)
  }

  const eps = await jsonRpc(`${MODULAR_RPC}/arc`, { method: 'eth_supportedEntryPoints', params: [] }, { authorization: `Bearer ${key}`, 'X-AppInfo': APP_INFO })
  const entryPoints = eps.payload?.result || []
  record(entryPoints.includes(ENTRY_POINT_V07), 'EntryPoint v0.7 tersedia', entryPoints.join(', ') || 'tidak ada')

  // Gasless paymaster: policy harus ada DAN aktif di Console (Gas Station → LIVE).
  const userOp = {
    sender: '0x0000000000000000000000000000000000000001', nonce: '0x0', callData: '0x',
    callGasLimit: '0x0', verificationGasLimit: '0x0', preVerificationGas: '0x0',
    maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0', signature: '0x',
  }
  const pm = await jsonRpc(
    `${MODULAR_RPC}/arc`,
    { method: 'pm_getPaymasterStubData', params: [userOp, ENTRY_POINT_V07, ARC_MAINNET_CHAIN_ID, {}] },
    { authorization: `Bearer ${key}`, 'X-AppInfo': APP_INFO },
  )
  const policyError = pm.payload?.error?.message || ''
  record(Boolean(pm.payload?.result) && !policyError, 'Gas Station policy LIVE untuk Arc mainnet',
    policyError ? `${policyError} → Console → Gas Station → aktifkan policy` : 'paymaster + paymasterData diterima')
}

async function checkLiveApiKey() {
  console.log('\n── API Key LIVE (developer-controlled wallet, webhook)')
  const key = process.env.CIRCLE_API_KEY_MAINNET || ''
  if (!key) {
    record(false, 'CIRCLE_API_KEY_MAINNET belum diset')
    return
  }
  try {
    const res = await fetch(`${CIRCLE_API_BASE}/v1/w3s/config/entity`, { headers: { authorization: `Bearer ${key}` } })
    const payload = await res.json().catch(() => ({}))
    record(res.ok && Boolean(payload?.data?.appId), 'API key LIVE diterima', res.ok ? `appId ${payload?.data?.appId}` : `HTTP ${res.status}`)
  } catch (error) {
    record(false, 'API key LIVE tidak dapat diverifikasi', error.message)
  }
}

// Penamaan chain Circle (Gateway/Unified Balance) untuk mainnet tidak boleh
// ditebak: nama itu dipakai untuk mencocokkan domain di /v1/info. Probe ini
// mencari namanya, bukan mengasumsikan.
async function checkGatewayMainnetNaming() {
  console.log('\n── Gateway / Unified Balance mainnet (penamaan chain Circle)')
  const candidates = [
    process.env.CIRCLE_GATEWAY_BASE_URL,
    'https://gateway-api.circle.com',
    'https://gateway-api-testnet.circle.com',
  ].filter(Boolean)
  for (const base of [...new Set(candidates)]) {
    try {
      const res = await fetch(`${base}/v1/info`)
      if (!res.ok) continue
      const payload = await res.json().catch(() => ({}))
      const domains = payload?.domains || payload?.data?.domains || []
      const arc = domains.find(item => /arc/i.test(String(item.chain || '')))
      if (!arc) continue
      const network = /testnet/i.test(base) ? 'testnet' : 'mainnet'
      record(true, `Gateway ${network} terjangkau — ${base}`, `domain Arc = "${arc.chain}" (domain ${arc.domain})`)
      return
    } catch { /* coba kandidat berikutnya */ }
  }
  record(null, 'Gateway /v1/info tidak terjangkau dari sini', 'bukan blocker; verifikasi penamaan chain Arc manual di Console Gateway')
}

async function checkPasskeyDomain() {
  console.log('\n── Passkey domain environment LIVE')
  const key = process.env.CIRCLE_CLIENT_KEY_LIVE || ''
  if (!key) return record(false, 'CIRCLE_CLIENT_KEY_LIVE belum diset')
  const res = await jsonRpc(`${MODULAR_BASE}`, { method: 'rp_getRegistrationOptions', params: [`arx-probe-${Date.now().toString(36)}`] }, { authorization: `Bearer ${key}`, 'X-AppInfo': APP_INFO })
  const message = res.payload?.error?.message || ''
  if (res.payload?.result?.rp?.name) {
    record(true, `domain passkey LIVE terdaftar (rp.name = ${res.payload.result.rp.name})`)
  } else if (/Lockout/i.test(res.text || '') || (res.status === 403 && !res.payload)) {
    record(null, 'probe rp_* diblokir edge Circle (Lockout)', 'ulangi beberapa menit lagi; ini bukan hasil konfigurasi')
  } else {
    record(false, 'domain passkey LIVE belum terdaftar', message || `HTTP ${res.status}`)
  }
}

console.log('ARCOX — pre-flight Arc Mainnet (read-only)')
console.log(`RPC   : ${ARC_MAINNET_RPC}`)
console.log(`Modular: ${MODULAR_RPC}`)

await checkArcRpc()
await checkContracts()
await checkLiveClientKey()
await checkLiveApiKey()
await checkPasskeyDomain()
await checkGatewayMainnetNaming()

const blockers = results.filter(r => r.ok === false && !/ARCOX|belum di-deploy/.test(r.label))
const notes = results.filter(r => r.ok === null)

console.log('\nRingkasan')
console.log(`  lulus   : ${results.filter(r => r.ok === true).length}`)
console.log(`  blocker : ${blockers.length}`)
for (const blocker of blockers) console.log(`    ❌ ${blocker.label}${blocker.detail ? ` — ${blocker.detail}` : ''}`)
for (const note of notes) console.log(`    • ${note.label}${note.detail ? ` — ${note.detail}` : ''}`)
if (!blockers.length) {
  console.log('\nSemua pemeriksaan read-only lolos. Langkah berikutnya: deploy kontrak ARCOX ke Arc mainnet,')
  console.log('treasury mainnet, lalu uji 1 pembayaran kecil — tetap menunggu konfirmasi operator.')
}
console.log('\nCatatan: kontrak ARCOX & treasury mainnet sengaja belum ada; itu pekerjaan berikutnya, bukan kegagalan probe.')

process.exit(blockers.length ? 1 : 0)
