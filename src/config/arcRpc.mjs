import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { arcNetwork } from './arcNetwork.mjs'

// RPC Arc mengikuti jaringan aktif (lihat src/config/arcNetwork.mjs). Default
// tetap testnet, jadi nilai di bawah tidak berubah sampai ARC_NETWORK=mainnet.
//
// Testnet: https://rpc.testnet.arc.io (primary) + https://arc-testnet.drpc.org.
// Mainnet: https://rpc.mainnet.arc.io (primary). Endpoint dRPC/Canteen hanya
// untuk testnet, jadi keduanya sengaja tidak dipakai di mainnet.
export const PUBLIC_ARC_RPC = arcNetwork().publicRpc
export const DRPC_ARC_RPC = arcNetwork().drpcRpc

// Canteen rejects the public-RPC 8k log window and can hit its response-size
// limit sooner when a high-volume ERC-20 event is queried. Keep all Arc scans
// below the observed safe window for both Canteen and fallback consistency.
export const ARC_RPC_LOG_CHUNK_SIZE = 2_000n
const CANTEEN_ENV_FILE = `${homedir()}/.arc-canteen/env`

function readCanteenRpc() {
  if (!existsSync(CANTEEN_ENV_FILE)) return ''
  try {
    const text = readFileSync(CANTEEN_ENV_FILE, 'utf8')
    const match = text.match(/(?:export\s+)?RPC\s*=\s*['"]?([^\s'"\r\n]+)['"]?/i)
    return match?.[1] || ''
  } catch {
    return ''
  }
}

function validRpc(value) {
  try {
    const url = new URL(String(value || '').trim())
    return /^https?:$/.test(url.protocol) ? url.toString().replace(/\/$/, '') : ''
  } catch {
    return ''
  }
}

/**
 * RPC yang dipakai untuk jaringan Arc aktif.
 *
 * Precedence testnet: `CANTEEN_RPC_URL`/Canteen (kalau diminta) → `ARC_RPC_URL`
 * → Canteen → RPC publik testnet.
 *
 * Precedence mainnet: `ARC_MAINNET_RPC_URL` → `RPC` → RPC publik mainnet.
 * `ARC_RPC_URL` dan Canteen **tidak** dipakai di mainnet karena keduanya milik
 * testnet; mengabaikannya mencegah transaksi mainnet menyasar endpoint testnet.
 */
export function resolveArcRpc({
  preferCanteen = process.env.USE_CANTEEN_RPC === 'true',
  configuredRpc = process.env.CANTEEN_RPC_URL,
  canteenRpc = readCanteenRpc(),
  applicationRpc,
  network = arcNetwork(),
} = {}) {
  const isMainnet = Boolean(network?.isMainnet)
  const rpc = applicationRpc === undefined
    ? (isMainnet ? (process.env.ARC_MAINNET_RPC_URL || process.env.RPC) : (process.env.ARC_RPC_URL || process.env.RPC))
    : applicationRpc

  if (isMainnet) {
    const envRpc = validRpc(rpc)
    const canteenAllowed = validRpc(configuredRpc)
    // Operator tetap boleh menunjuk endpoint sendiri lewat CANTEEN_RPC_URL,
    // tetapi hanya kalau diminta eksplisit (tidak ada auto-fallback Canteen).
    return (preferCanteen ? canteenAllowed || envRpc : envRpc) || network.publicRpc
  }

  const configured = validRpc(configuredRpc)
  const canteen = validRpc(canteenRpc)
  const envRpc = validRpc(rpc)
  const legacyDprc = envRpc === DRPC_ARC_RPC
  const useCanteen = preferCanteen || legacyDprc
  return (useCanteen ? configured || canteen || envRpc : configured || envRpc || canteen) || network.publicRpc
}

export function arcRpcUrls(options = {}) {
  const network = options.network || arcNetwork()
  return [...new Set([resolveArcRpc(options), network.publicRpc, network.drpcRpc].filter(Boolean))]
}
