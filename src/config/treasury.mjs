const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

const EVM_ENV_NAMES = [
  'ARCOX_TREASURY_WALLET_ADDRESS',
  'ARCOX_FEE_TREASURY',
  'ARCOX_TREASURY_WALLET',
  'AI_ROUTER_TREASURY_ADDRESS',
  'X402_RECIPIENT_ADDRESS',
  'CIRCLE_X402_TREASURY_ADDRESS',
]

export function treasuryAddress() {
  const canonical = String(process.env.ARCOX_TREASURY_WALLET_ADDRESS || '').trim()
  if (canonical && !EVM_ADDRESS.test(canonical)) {
    throw new Error('ARCOX_TREASURY_WALLET_ADDRESS must be a valid EVM address')
  }
  if (canonical) return canonical
  return EVM_ENV_NAMES
    .slice(1)
    .map(name => String(process.env[name] || '').trim())
    .find(value => EVM_ADDRESS.test(value)) || ''
}

export function requireTreasuryAddress() {
  const value = treasuryAddress()
  if (!value) throw new Error('ARCOX_TREASURY_WALLET_ADDRESS is not configured')
  return value
}

export function solanaTreasuryAddress() {
  const value = String(process.env.ARCOX_SOLANA_TREASURY_ADDRESS || '').trim()
  if (value && !SOLANA_ADDRESS.test(value)) {
    throw new Error('ARCOX_SOLANA_TREASURY_ADDRESS must be a valid Solana address')
  }
  return value
}

export function treasuryConfigurationIssues() {
  const canonical = String(process.env.ARCOX_TREASURY_WALLET_ADDRESS || '').trim().toLowerCase()
  const issues = []
  if (!canonical) issues.push('ARCOX_TREASURY_WALLET_ADDRESS is unset; a legacy treasury variable is being used')
  for (const name of EVM_ENV_NAMES.slice(1)) {
    const value = String(process.env[name] || '').trim().toLowerCase()
    if (value && canonical && EVM_ADDRESS.test(value) && value !== canonical) {
      issues.push(`${name} differs from ARCOX_TREASURY_WALLET_ADDRESS and will be ignored`)
    }
  }
  return issues
}
