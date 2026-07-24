import { createPublicClient, defineChain, getAddress, http, isAddress, parseAbiItem } from 'viem'

export const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)')
const cache = new Map()

const identityAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }] },
]

function client() {
  const chain = defineChain({
    id: Number(process.env.ARC_CHAIN_ID || 5042002),
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [process.env.ARC_RPC_URL || process.env.RPC || 'https://arc-testnet.drpc.org'] } },
  })
  const drpcKey = process.env.DRPC_KEY || ''
  const fetchOptions = drpcKey ? { headers: { Authorization: `Bearer ${drpcKey}` } } : undefined
  return createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 10_000, retryCount: 2, ...(fetchOptions ? { fetchOptions } : {}) }) })
}

export async function getAgentIdentity(agentId) {
  const id = String(agentId || '').trim()
  if (!/^\d+$/.test(id)) throw new Error('Invalid Agent Identity ID')
  const rpc = client()
  const [owner, metadataUri] = await Promise.all([
    rpc.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: 'ownerOf', args: [BigInt(id)] }),
    rpc.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: 'tokenURI', args: [BigInt(id)] }).catch(() => ''),
  ])
  return { agentId: id, ownerWallet: getAddress(owner), metadataUri: String(metadataUri || ''), registry: IDENTITY_REGISTRY, network: 'arc-testnet' }
}

export async function verifyAgentOwnership(agentId, ownerAddress) {
  if (!isAddress(ownerAddress)) return null
  try {
    const identity = await getAgentIdentity(agentId)
    return identity.ownerWallet.toLowerCase() === getAddress(ownerAddress).toLowerCase() ? identity : null
  } catch {
    return null
  }
}

export async function listAgentIdentities(ownerAddress, { refresh = false } = {}) {
  if (!isAddress(ownerAddress)) throw new Error('Invalid ownerAddress')
  const owner = getAddress(ownerAddress)
  const key = owner.toLowerCase()
  const cached = cache.get(key)
  if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.items

  const rpc = client()
  const expected = Number(await rpc.readContract({ address: IDENTITY_REGISTRY, abi: identityAbi, functionName: 'balanceOf', args: [owner] }).catch(() => 0n))
  if (!expected) {
    cache.set(key, { at: Date.now(), items: [] })
    return []
  }

  let ids = await idsFromArcScan(owner).catch(() => [])
  if (ids.length < expected) ids = [...new Set([...ids, ...await idsFromRecentLogs(rpc, owner, expected)])]
  const identities = (await Promise.all(ids.map(id => getAgentIdentity(id).catch(() => null))))
    .filter(item => item?.ownerWallet?.toLowerCase() === key)
    .sort((a, b) => Number(BigInt(b.agentId) - BigInt(a.agentId)))
    .slice(0, expected)
  cache.set(key, { at: Date.now(), items: identities })
  return identities
}

async function idsFromArcScan(owner) {
  const base = String(process.env.ARCSCAN_API_BASE_URL || 'https://testnet.arcscan.app/api/v2').replace(/\/$/, '')
  let url = new URL(`${base}/addresses/${owner}/nft`)
  url.searchParams.set('type', 'ERC-721')
  const ids = []
  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) })
    if (!response.ok) throw new Error(`ArcScan HTTP ${response.status}`)
    const data = await response.json()
    for (const item of data.items || []) {
      if (String(item?.token?.address_hash || '').toLowerCase() !== IDENTITY_REGISTRY.toLowerCase()) continue
      const id = String(item.id || item.token_id || '')
      if (/^\d+$/.test(id)) ids.push(id)
    }
    if (!data.next_page_params) break
    const next = new URL(`${base}/addresses/${owner}/nft`)
    next.searchParams.set('type', 'ERC-721')
    for (const [name, value] of Object.entries(data.next_page_params)) next.searchParams.set(name, String(value))
    url = next
  }
  return [...new Set(ids)]
}

async function idsFromRecentLogs(rpc, owner, expected) {
  const latest = await rpc.getBlockNumber()
  const lookback = BigInt(Number(process.env.ERC8004_SCAN_LOOKBACK_BLOCKS || 500_000))
  const floor = latest > lookback ? latest - lookback : 0n
  const ids = new Set()
  for (let toBlock = latest; toBlock >= floor && ids.size < expected;) {
    const fromBlock = toBlock > 9_999n ? toBlock - 9_999n : 0n
    const logs = await rpc.getLogs({ address: IDENTITY_REGISTRY, event: TRANSFER_EVENT, args: { to: owner }, fromBlock: fromBlock < floor ? floor : fromBlock, toBlock })
    for (const log of logs) if (log.args.tokenId !== undefined) ids.add(log.args.tokenId.toString())
    if (fromBlock <= floor) break
    toBlock = fromBlock - 1n
  }
  return [...ids]
}
