import { createPublicClient, defineChain, fallback, http, isAddress, parseAbi } from 'viem'

const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const GATEWAY_INFO_URL = 'https://gateway-api-testnet.circle.com/v1/info'
const STATUS_ABI = parseAbi([
  'function isAuthorizedForBalance(address token, address depositor, address delegate) view returns (bool)',
])

const CHAINS = {
  Arc_Testnet: chainConfig(5042002, 'Arc Testnet', 'USDC', 26, 'ARC', 'Testnet', '0x3600000000000000000000000000000000000000', 'ARC_RPC_URL', 'https://rpc.testnet.arc.network/'),
  Ethereum_Sepolia: chainConfig(11155111, 'Ethereum Sepolia', 'ETH', 0, 'Ethereum', 'Sepolia', '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', 'ETHEREUM_SEPOLIA_RPC', 'https://ethereum-sepolia-rpc.publicnode.com'),
  Base_Sepolia: chainConfig(84532, 'Base Sepolia', 'ETH', 6, 'Base', 'Sepolia', '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'BASE_SEPOLIA_RPC', 'https://sepolia.base.org'),
  Arbitrum_Sepolia: chainConfig(421614, 'Arbitrum Sepolia', 'ETH', 3, 'Arbitrum', 'Sepolia', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 'ARBITRUM_SEPOLIA_RPC', ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com']),
}

let gatewayInfoCache = null
let gatewayInfoCachedAt = 0
let gatewayInfoInFlight = null

export async function getGatewayDelegateStatus({ ownerAddress, delegateAddress, chain }) {
  if (!isAddress(ownerAddress) || !isAddress(delegateAddress)) throw new Error('Valid ownerAddress and delegateAddress are required')
  const config = CHAINS[chain]
  if (!config) throw new Error(`Unsupported Unified Balance chain: ${chain}`)
  const client = publicClient(config)
  const args = [config.usdcAddress, ownerAddress, delegateAddress]
  const authorized = await client.readContract({ address: GATEWAY_WALLET, abi: STATUS_ABI, functionName: 'isAuthorizedForBalance', args })
  if (!authorized) return result(chain, 'none', true)

  let info
  try {
    info = await gatewayInfo()
  } catch (error) {
    return result(chain, 'pending', false, error instanceof Error ? error.message : 'Gateway finality unavailable')
  }
  const domain = info.domains.find(item => Number(item.domain) === config.domain && item.chain === config.gatewayChain)
  if (!domain?.processedHeight) return result(chain, 'pending', false, 'Gateway processed height unavailable')
  try {
    const finalized = await client.readContract({
      address: GATEWAY_WALLET,
      abi: STATUS_ABI,
      functionName: 'isAuthorizedForBalance',
      args,
      blockNumber: BigInt(domain.processedHeight),
    })
    return result(chain, finalized ? 'ready' : 'pending', true, '', domain.processedHeight)
  } catch (error) {
    return result(chain, 'pending', true, error instanceof Error ? error.message : 'RPC finality read pending', domain.processedHeight)
  }
}

function chainConfig(id, name, symbol, domain, gatewayChain, network, usdcAddress, rpcEnv, defaultRpc) {
  return { id, name, symbol, domain, gatewayChain, network, usdcAddress, rpcEnv, defaultRpc: Array.isArray(defaultRpc) ? defaultRpc : [defaultRpc] }
}

function publicClient(config) {
  const configuredRpc = process.env[config.rpcEnv] || (config.rpcEnv === 'ARC_RPC_URL' ? process.env.RPC : '')
  const rpcUrls = [...new Set([configuredRpc, ...config.defaultRpc].filter(Boolean))]
  const chain = defineChain({
    id: config.id,
    name: config.name,
    nativeCurrency: { name: config.symbol, symbol: config.symbol, decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  })
  return createPublicClient({
    chain,
    transport: fallback(rpcUrls.map(url => http(url, { timeout: 8_000, retryCount: 1 })), { rank: true }),
  })
}

async function gatewayInfo() {
  if (gatewayInfoCache && Date.now() - gatewayInfoCachedAt < 15_000) return gatewayInfoCache
  if (gatewayInfoInFlight) return gatewayInfoInFlight
  gatewayInfoInFlight = (async () => {
    const response = await fetch(GATEWAY_INFO_URL, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) throw new Error(`Gateway info HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data?.domains)) throw new Error('Invalid Gateway info response')
    gatewayInfoCache = data
    gatewayInfoCachedAt = Date.now()
    return data
  })()
  try {
    return await gatewayInfoInFlight
  } finally {
    gatewayInfoInFlight = null
  }
}

function result(chain, status, gatewayAvailable, warning = '', processedHeight = '') {
  const safeWarning = String(warning || '').split('\n')[0].slice(0, 240)
  return { chain, status, gatewayAvailable, processedHeight, ...(safeWarning ? { warning: safeWarning } : {}) }
}
