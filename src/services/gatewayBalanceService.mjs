// Circle Gateway Unified Balance summary — shared by AI Router status and any
// future readout that needs the real confirmed/pending USDC balance instead of
// a placeholder string. The route-level formatting in server.mjs stays as-is;
// this service is self-contained so it can be imported from routes/services
// without pulling in the Express entrypoint.
const GATEWAY_TESTNET_API = 'https://gateway-api-testnet.circle.com'

export const GATEWAY_TESTNET_CHAINS = [
  { domain: 26, chain: 'Arc_Testnet', ecosystem: 'evm' },
  { domain: 6, chain: 'Base_Sepolia', ecosystem: 'evm' },
  { domain: 0, chain: 'Ethereum_Sepolia', ecosystem: 'evm' },
  { domain: 3, chain: 'Arbitrum_Sepolia', ecosystem: 'evm' },
  { domain: 5, chain: 'Solana_Devnet', ecosystem: 'solana' },
]

function balanceUsdcUnits(value) {
  const normalized = String(value || '0').trim()
  if (!/^\d+(\.\d+)?$/.test(normalized)) return 0n
  const [whole, fraction = ''] = normalized.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6) || '0')
}

function fixedUsdc(value) {
  const [whole = '0', fraction = ''] = String(value || '0').split('.')
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`
}

function addDecimalAmounts(left, right) {
  const units = balanceUsdcUnits(left) + balanceUsdcUnits(right)
  const base = 10n ** 6n
  const whole = units / base
  const frac = (units % base).toString().padStart(6, '0').replace(/0+$/, '')
  return `${whole.toString()}${frac ? `.${frac}` : ''}`
}

async function gatewayBalanceRequest(path, body) {
  let lastError
  const attempts = 2
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Number(process.env.GATEWAY_BALANCE_TIMEOUT_MS || 7_000))
    try {
      const response = await fetch(`${GATEWAY_TESTNET_API}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'arcox-api/2.0' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) {
        const error = new Error(data?.message || `Circle Gateway HTTP ${response.status}`)
        error.status = response.status >= 400 && response.status < 500 ? response.status : 502
        throw error
      }
      return data
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 350))
    } finally {
      clearTimeout(timeout)
    }
  }
  const error = new Error(lastError?.name === 'AbortError' ? 'Circle Gateway balance request timed out' : (lastError?.message || 'Circle Gateway request failed'))
  error.status = lastError?.status || 502
  throw error
}

/**
 * Fetch the real confirmed/pending Unified Balance for an EVM depositor
 * (with optional Solana depositor). Returns null when the Gateway is
 * unreachable so callers can fall back to a placeholder instead of failing.
 */
export async function fetchUnifiedBalanceSummary({ address, solanaAddress = '' } = {}) {
  const evm = String(address || '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(evm)) return null
  let solana = String(solanaAddress || '').trim()
  if (solana) {
    try {
      const { PublicKey } = await import('@solana/web3.js')
      solana = new PublicKey(solana).toBase58()
    } catch {
      solana = ''
    }
  }
  const depositorByDomain = new Map(GATEWAY_TESTNET_CHAINS.map(({ domain, ecosystem }) => [domain, ecosystem === 'solana' ? solana : evm]))
  const sources = GATEWAY_TESTNET_CHAINS
    .map(({ domain }) => ({ depositor: depositorByDomain.get(domain), domain }))
    .filter(source => Boolean(source.depositor))
  if (!sources.length) return null
  const requestBody = { token: 'USDC', sources }
  const confirmed = await gatewayBalanceRequest('/v1/balances', requestBody)
  const confirmedByDomain = new Map((confirmed?.balances || []).map(item => [Number(item.domain), String(item.balance || '0')]))
  const chains = GATEWAY_TESTNET_CHAINS
    .filter(({ domain }) => Boolean(depositorByDomain.get(domain)))
    .map(({ domain, chain }) => ({
      chain,
      depositor: depositorByDomain.get(domain),
      confirmedBalance: fixedUsdc(confirmedByDomain.get(domain) || '0'),
    }))
  return {
    token: 'USDC',
    totalConfirmedBalance: fixedUsdc(chains.reduce((total, item) => addDecimalAmounts(total, item.confirmedBalance), '0')),
    source: 'circle-gateway-server',
    chains,
    fetchedAt: new Date().toISOString(),
  }
}
