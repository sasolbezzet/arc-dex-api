import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'

export const PUBLIC_ARC_RPC = 'https://rpc.testnet.arc.network'
export const DRPC_ARC_RPC = 'https://arc-testnet.drpc.org'
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
  return (preferCanteen ? configured || canteen || envRpc : configured || envRpc || canteen) || PUBLIC_ARC_RPC
}

export function arcRpcUrls(options = {}) {
  return [...new Set([resolveArcRpc(options), PUBLIC_ARC_RPC, DRPC_ARC_RPC].filter(Boolean))]
}
