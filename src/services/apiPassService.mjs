import { createPublicClient, defineChain, getAddress, http, fallback } from 'viem'

export const API_PASS_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getApiPass', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: 'owner', type: 'address' }, { name: 'apiKeyIdHash', type: 'bytes32' }, { name: 'metadataURI', type: 'string' }, { name: 'exists', type: 'bool' }] },
  { type: 'function', name: 'tokenIdByApiKeyHash', stateMutability: 'view', inputs: [{ name: 'apiKeyIdHash', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isSessionDelegate', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'delegate', type: 'address' }], outputs: [{ type: 'bool' }] },
]

const ARC_RPC_LIST = [
  process.env.ARC_RPC_URL || process.env.RPC || 'https://arc-testnet.drpc.org',
  'https://rpc.testnet.arc.network',
  'https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_cb280d6a2612407c4a1dfc8ae235c0ae62bdfe0740559a355dcb7c48b22b345a',
].filter(Boolean)
const chain = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [...new Set(ARC_RPC_LIST)] } },
})

function config() {
  const address = String(process.env.ARCOX_API_PASS_ADDRESS || '')
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw new Error('ARCOX_API_PASS_ADDRESS is not configured')
  const drpcKey = process.env.DRPC_KEY || ''
  const transports = [...new Set(ARC_RPC_LIST)].map((url, i) =>
    http(url, { timeout: 8_000, retryCount: 1, ...(i === 0 && drpcKey && url.includes('drpc.org') ? { fetchOptions: { headers: { Authorization: `Bearer ${drpcKey}` } } } : {}) })
  )
  return {
    address: getAddress(address),
    client: createPublicClient({ chain, transport: fallback(transports, { retryCount: 2, rank: false }) }),
  }
}

export function apiPassAddress() {
  return config().address
}

export async function verifyApiPass({ tokenId, ownerAddress, apiKeyIdHash, txHash = '' }) {
  const { address, client } = config()
  if (txHash) {
    const receipt = await client.getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') throw new Error('API Pass mint transaction failed')
  }
  const [owner, pass, boundTokenId] = await Promise.all([
    client.readContract({ address, abi: API_PASS_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
    client.readContract({ address, abi: API_PASS_ABI, functionName: 'getApiPass', args: [BigInt(tokenId)] }),
    client.readContract({ address, abi: API_PASS_ABI, functionName: 'tokenIdByApiKeyHash', args: [apiKeyIdHash] }),
  ])
  if (!pass[3] || getAddress(owner) !== getAddress(ownerAddress) || getAddress(pass[0]) !== getAddress(ownerAddress)) throw new Error('API Pass owner mismatch')
  if (String(pass[1]).toLowerCase() !== String(apiKeyIdHash).toLowerCase() || boundTokenId !== BigInt(tokenId)) throw new Error('API Pass key binding mismatch')
  return { address, owner: getAddress(owner), tokenId: String(tokenId), apiKeyIdHash: pass[1] }
}

export async function apiPassExists(apiKey) {
  try {
    await verifyApiPass({ tokenId: apiKey.sbtTokenId, ownerAddress: apiKey.ownerAddress, apiKeyIdHash: apiKey.apiKeyIdHash })
    return true
  } catch {
    return false
  }
}

export async function isApiPassSigner(apiKey, signerAddress) {
  const signer = getAddress(signerAddress)
  if (signer === getAddress(apiKey.ownerAddress)) return true
  const { address, client } = config()
  return client.readContract({ address, abi: API_PASS_ABI, functionName: 'isSessionDelegate', args: [BigInt(apiKey.sbtTokenId), signer] })
}
