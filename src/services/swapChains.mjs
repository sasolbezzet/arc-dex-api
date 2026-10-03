// swapChains.mjs — registry chain + token untuk jalur swap lintas-chain.
//
// Satu entri di sini adalah satu chain yang bisa dipilih UI/API/MCP. Chain di
// luar daftar ini ditolak dengan pesan jelas (bukan diam-diam jatuh ke Arc).
// Semua alamat token di sini berasal dari sumber terverifikasi:
//   - Arc: registry jaringan aktif (src/config/arcNetwork.mjs)
//   - EURC: developers.circle.com/stablecoins/eurc-contract-addresses
//   - cirBTC: developers.circle.com/assets/cirbtc-contract-addresses
//     (mainnet: Arc + Ethereum; testnet: Arc Testnet + Ethereum Sepolia)
//   - USDC chain non-Arc: cctpChains di arcNetwork.mjs (diverifikasi on-chain)
//
// `circleSwapChain` adalah nama chain yang dipakai Circle Stablecoin Service /
// App Kit (`SwapChain`); route-nya lewat aggregator pihak ketiga (LiFi) dan
// sudah diverifikasi terhadap API produksi untuk pasangan USDC↔cirBTC dan
// EURC↔cirBTC di Arc & Ethereum, termasuk token arbitrary (paste CA) di
// Base/Arbitrum/Ethereum.
//
// `circleWalletBlockchain` adalah identifier Circle Wallets untuk provisioning
// wallet custodial per chain. Kalau null, swap tetap bisa lewat Personal Wallet
// (EOA) tetapi tidak lewat Circle Wallet — chain itu ditolak dengan pesan yang
// menyarankan Personal Wallet.
import { createPublicClient, http, getAddress, isAddress } from 'viem'
import { arcNetwork, IS_ARC_MAINNET, ARC_CHAIN_KEY } from '../config/arcNetwork.mjs'

const network = arcNetwork()

// Alamat adapter Circle Stablecoin Service (tempat EIP-712 ExecutionParams
// diverifikasi). Sama di seluruh EVM mainnet / testnet (CREATE2) dan sudah
// dicek punya kode di Arc, Ethereum, Base, Arbitrum. Env override menang supaya
// jaringan uji baru bisa diarahkan tanpa mengubah kode.
const CIRCLE_ADAPTER_MAINNET = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'
const CIRCLE_ADAPTER_TESTNET = '0xBBD70b01a1CAbc96d5b7b129Ae1AAabdf50dd40b'

const MAINNET_CHAINS = {
  'arc-mainnet': {
    name: 'Arc Mainnet',
    shortName: 'ARC',
    chainId: 5042,
    circleSwapChain: 'Arc',
    circleWalletBlockchain: 'ARC',
    explorerUrl: 'https://explorer.arc.io',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: [network.publicRpc],
    tokens: network.tokens, // USDC, EURC, USYC, cirBTC
  },
  'ethereum-mainnet': {
    name: 'Ethereum',
    shortName: 'ETH',
    chainId: 1,
    circleSwapChain: 'Ethereum',
    circleWalletBlockchain: 'ETH',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [process.env.ETH_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com'],
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
      cirBTC: '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E',
    },
  },
  'base-mainnet': {
    name: 'Base',
    shortName: 'BASE',
    chainId: 8453,
    circleSwapChain: 'Base',
    circleWalletBlockchain: 'BASE',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org'],
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    },
  },
  'arbitrum-mainnet': {
    name: 'Arbitrum One',
    shortName: 'ARB',
    chainId: 42161,
    circleSwapChain: 'Arbitrum',
    circleWalletBlockchain: 'ARB',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: [process.env.ARB_MAINNET_RPC_URL || 'https://arb1.arbitrum.io/rpc'],
    tokens: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    },
  },
}

// Testnet: App Kit hanya mendukung swap di Arc Testnet (chain uji lain tidak
// pernah diiklankan supaya tidak diam-diam mengirim dana ke jaringan uji).
const TESTNET_CHAINS = {
  'arc-testnet': {
    name: 'Arc Testnet',
    shortName: 'ARC Testnet',
    chainId: 5042002,
    circleSwapChain: 'Arc_Testnet',
    circleWalletBlockchain: 'ARC-TESTNET',
    explorerUrl: 'https://testnet.arcscan.app',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: [network.publicRpc],
    tokens: network.tokens,
  },
}

export const SWAP_CHAINS = IS_ARC_MAINNET ? MAINNET_CHAINS : TESTNET_CHAINS
export const SWAP_MAINNET_CHAINS = MAINNET_CHAINS

const TOKEN_DECIMALS = { USDC: 6, EURC: 6, USYC: 6, cirBTC: 8 }

const CHAIN_ALIASES = {
  arc: ARC_CHAIN_KEY,
  'arc-mainnet': 'arc-mainnet',
  arcmainnet: 'arc-mainnet',
  '5042': 'arc-mainnet',
  ethereum: 'ethereum-mainnet',
  eth: 'ethereum-mainnet',
  'ethereum-mainnet': 'ethereum-mainnet',
  mainnet: 'ethereum-mainnet',
  '1': 'ethereum-mainnet',
  base: 'base-mainnet',
  'base-mainnet': 'base-mainnet',
  '8453': 'base-mainnet',
  arbitrum: 'arbitrum-mainnet',
  arb: 'arbitrum-mainnet',
  'arbitrum-mainnet': 'arbitrum-mainnet',
  '42161': 'arbitrum-mainnet',
  'arc-testnet': 'arc-testnet',
  arctestnet: 'arc-testnet',
  '5042002': 'arc-testnet',
}

/** Daftar chain swap aktif untuk API/UI (tanpa data internal). */
export function swapChainList() {
  return Object.entries(SWAP_CHAINS).map(([key, chain]) => ({
    key,
    name: chain.name,
    shortName: chain.shortName,
    // Chain Arc yang sedang aktif (mainnet/testnet) — frontend memakai flag ini
    // untuk tahu wallet Circle mana yang sudah dimuat App dan mana yang perlu
    // dibuat per-chain lewat /api/wallet.
    active: key === ARC_CHAIN_KEY,
    chainId: chain.chainId,
    chainIdHex: `0x${chain.chainId.toString(16)}`,
    rpcUrls: chain.rpcUrls,
    explorerUrl: chain.explorerUrl,
    circleSwapChain: chain.circleSwapChain,
    circleWalletSupported: Boolean(chain.circleWalletBlockchain),
    nativeCurrency: chain.nativeCurrency,
    tokens: Object.fromEntries(
      Object.entries(chain.tokens)
        .filter(([, address]) => Boolean(address))
        .map(([symbol, address]) => [symbol, { address, decimals: TOKEN_DECIMALS[symbol] ?? null }]),
    ),
  }))
}

/**
 * Resolve input chain dari API/MCP/UI ke entri registry.
 * Kosong = jaringan Arc yang aktif. Nilai tak dikenal ditolak dengan daftar
 * chain yang benar supaya tidak ada fallback diam-diam ke chain lain.
 */
export function resolveSwapChain(input) {
  const raw = String(input ?? '').trim().toLowerCase()
  const key = raw ? (CHAIN_ALIASES[raw] || raw) : ARC_CHAIN_KEY
  const chain = SWAP_CHAINS[key]
  if (!chain) {
    const supported = Object.keys(SWAP_CHAINS).join(', ')
    throw Object.assign(new Error(`Chain swap '${input}' tidak didukung. Chain yang tersedia: ${supported}.`), { status: 400, code: 'unsupported_swap_chain' })
  }
  return { key, ...chain }
}

/**
 * Resolve token input: simbol terdaftar (USDC/EURC/cirBTC/USYC) atau contract
 * address apa pun (paste CA). Symbol lookup hanya untuk kenyamanan; alamat
 * eksplisit selalu menang supaya CA yang kebetulan sama dengan token bawaan
 * tidak salah dipetakan.
 */
export function resolveSwapToken(input, chain) {
  const raw = String(input ?? '').trim()
  if (!raw) throw Object.assign(new Error('Token wajib diisi.'), { status: 400, code: 'missing_swap_token' })
  if (isAddress(raw)) {
    return { address: getAddress(raw), symbol: null, decimals: null, custom: true, input: raw }
  }
  const upper = raw.toUpperCase()
  const symbol = upper === 'CIRBTC' ? 'cirBTC' : upper
  const address = chain.tokens?.[symbol]
  if (!address) {
    // Sebutkan simbol yang BENAR-BENAR ada di chain itu (mis. Arbitrum hanya
    // USDC), supaya pesan tidak menyuruh mencoba token yang tidak tersedia.
    const available = Object.entries(chain.tokens || {})
      .filter(([, tokenAddress]) => Boolean(tokenAddress))
      .map(([name]) => name)
    throw Object.assign(
      new Error(`Token '${raw}' tidak dikenal di ${chain.name}. Simbol yang tersedia: ${available.length ? available.join(', ') : 'tidak ada'}. Kamu juga bisa menempel contract address token.`),
      { status: 400, code: 'unsupported_swap_token' },
    )
  }
  return { address, symbol, decimals: TOKEN_DECIMALS[symbol] ?? null, custom: false, input: raw }
}

const erc20DecimalsAbi = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }]
const decimalsCache = new Map()

/**
 * Decimals token arbitrary dibaca on-chain (dengan cache) karena fee split dan
 * konversi base units tidak boleh menebak. Kalau read gagal, permintaan ditolak
 * dengan pesan yang menyebut alamat kontraknya — tidak ada default 18.
 */
export async function readSwapTokenDecimals(address, chain) {
  const cacheKey = `${chain.chainId}:${address.toLowerCase()}`
  if (decimalsCache.has(cacheKey)) return decimalsCache.get(cacheKey)
  let lastError
  for (const rpcUrl of chain.rpcUrls) {
    try {
      const client = createPublicClient({ transport: http(rpcUrl, { timeout: 12_000 }) })
      const decimals = await client.readContract({ address, abi: erc20DecimalsAbi, functionName: 'decimals' })
      const value = Number(decimals)
      if (!Number.isInteger(value) || value < 0 || value > 36) throw new Error(`decimals() tidak masuk akal: ${decimals}`)
      decimalsCache.set(cacheKey, value)
      return value
    } catch (error) {
      lastError = error
    }
  }
  throw Object.assign(
    new Error(`Gagal membaca decimals() ${address} di ${chain.name}: ${lastError?.message || 'RPC error'}. Pastikan alamat adalah kontrak ERC-20 di chain itu.`),
    { status: 400, code: 'token_decimals_unavailable' },
  )
}

/** Resolve + lengkapi decimals (baca on-chain kalau perlu). */
export async function describeSwapToken(input, chain) {
  const token = resolveSwapToken(input, chain)
  const decimals = token.decimals ?? await readSwapTokenDecimals(token.address, chain)
  return { ...token, decimals, label: token.symbol || shortAddress(token.address) }
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Alamat adapter Circle untuk jaringan aktif (env override > konstanta SDK). */
export function swapAdapterAddress() {
  const override = IS_ARC_MAINNET
    ? process.env.ARCOX_SWAP_ADAPTER_MAINNET
    : process.env.ARCOX_SWAP_ADAPTER
  return getAddress(String(override || (IS_ARC_MAINNET ? CIRCLE_ADAPTER_MAINNET : CIRCLE_ADAPTER_TESTNET)))
}

/** Chain Circle Wallet untuk entri registry; null kalau wallet custodial tak didukung. */
export function circleWalletBlockchain(chain) {
  return chain.circleWalletBlockchain || null
}
