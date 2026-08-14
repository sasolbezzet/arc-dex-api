import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'

export const PUBLIC_ARC_RPC = 'https://rpc.testnet.arc.network'
export const DRPC_ARC_RPC = 'https://arc-testnet.drpc.org'
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

export function resolveArcRpc({
  preferCanteen = process.env.USE_CANTEEN_RPC === 'true',
  configuredRpc = process.env.CANTEEN_RPC_URL,
  canteenRpc = readCanteenRpc(),
  applicationRpc = process.env.ARC_RPC_URL || process.env.RPC,
} = {}) {
  const configured = validRpc(configuredRpc)
  const canteen = validRpc(canteenRpc)
  const envRpc = validRpc(applicationRpc)
  const legacyDprc = envRpc === DRPC_ARC_RPC
  const useCanteen = preferCanteen || legacyDprc
  return (useCanteen ? configured || canteen || envRpc : configured || envRpc || canteen) || PUBLIC_ARC_RPC
}

export function arcRpcUrls(options = {}) {
  return [...new Set([resolveArcRpc(options), PUBLIC_ARC_RPC, DRPC_ARC_RPC].filter(Boolean))]
}
