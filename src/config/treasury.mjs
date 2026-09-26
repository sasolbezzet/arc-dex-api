import { IS_ARC_MAINNET } from './arcNetwork.mjs'

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

// Treasury tunggal untuk kedua jaringan: alamat fee treasury ARCOX
// (0x5d16E8Ef…). Di mainnet, `ARCOX_TREASURY_WALLET_ADDRESS_MAINNET` dibaca
// lebih dulu supaya treasury mainnet tidak pernah diam-diam mewarisi nilai
// testnet; kalau var itu kosong, nilai generik dipakai (kedua jaringan memang
// memakai alamat yang sama).
export const TREASURY_MAINNET_ENV = 'ARCOX_TREASURY_WALLET_ADDRESS_MAINNET'
export const TREASURY_GENERIC_ENV = 'ARCOX_TREASURY_WALLET_ADDRESS'

function envValue(name) {
  return String(process.env[name] || '').trim()
}

function canonicalTreasuryEnv() {
  const generic = envValue(TREASURY_GENERIC_ENV)
  if (!IS_ARC_MAINNET) return { name: TREASURY_GENERIC_ENV, value: generic }
  const mainnet = envValue(TREASURY_MAINNET_ENV)
  return mainnet
    ? { name: TREASURY_MAINNET_ENV, value: mainnet }
    : { name: TREASURY_GENERIC_ENV, value: generic }
}

const EVM_ENV_NAMES = [
  TREASURY_GENERIC_ENV,
  TREASURY_MAINNET_ENV,
  'ARCOX_FEE_TREASURY',
  'ARCOX_TREASURY_WALLET',
  'AI_ROUTER_TREASURY_ADDRESS',
  'X402_RECIPIENT_ADDRESS',
  'CIRCLE_X402_TREASURY_ADDRESS',
]

export function treasuryAddress() {
  const canonical = canonicalTreasuryEnv()
  if (canonical.value && !EVM_ADDRESS.test(canonical.value)) {
    throw new Error(`${canonical.name} must be a valid EVM address`)
  }
  if (canonical.value) return canonical.value
  return EVM_ENV_NAMES
    .filter(name => name !== canonical.name)
    .map(envValue)
    .find(value => EVM_ADDRESS.test(value)) || ''
}

export function requireTreasuryAddress() {
  const value = treasuryAddress()
  if (!value) throw new Error(`${TREASURY_GENERIC_ENV} is not configured`)
  return value
}

export function solanaTreasuryAddress() {
  const value = envValue('ARCOX_SOLANA_TREASURY_ADDRESS')
  if (value && !SOLANA_ADDRESS.test(value)) {
    throw new Error('ARCOX_SOLANA_TREASURY_ADDRESS must be a valid Solana address')
  }
  return value
}

export function treasuryConfigurationIssues() {
  const canonical = canonicalTreasuryEnv()
  const canonicalValue = canonical.value.toLowerCase()
  const issues = []
  if (!canonical.value) issues.push(`${canonical.name} is unset; a legacy treasury variable is being used`)
  for (const name of EVM_ENV_NAMES) {
    if (name === canonical.name) continue
    const value = envValue(name).toLowerCase()
    if (value && canonicalValue && EVM_ADDRESS.test(value) && value !== canonicalValue) {
      issues.push(`${name} differs from ${canonical.name} and will be ignored`)
    }
  }
  return issues
}
