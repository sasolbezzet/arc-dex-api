// chains.mjs — Multi-chain configuration for MSCA + balance fetching.
//
// Chain Arc berasal dari registry jaringan aktif (src/config/arcNetwork.mjs):
// default `arc-testnet`, dan `arc-mainnet` ketika `ARC_NETWORK=mainnet`.
// Chain Sepolia di bawah tetap ada sebagai chain non-Arc (read-only/tujuan uji);
// MSCA hanya diizinkan pada chain yang didaftarkan jaringan aktif.
import { resolveArcRpc } from '../config/arcRpc.mjs'
import { arcNetwork } from '../config/arcNetwork.mjs'

export {
  ARC_CHAIN_KEY,
  ARC_CHAIN_ID,
  ARC_CHAIN_ID_HEX,
  ARC_CHAIN_NAME,
  ARC_EXPLORER_URL,
  IS_ARC_MAINNET,
  ARC_NETWORK_ID,
  arcNetwork,
  resolveArcChainKey,
  isArcChainKey,
} from '../config/arcNetwork.mjs'
import { ARC_BALANCE_CHAIN_KEYS } from '../config/arcNetwork.mjs'

const arc = arcNetwork()

// Circle Modular Wallet/MSCA support is narrower than Circle Gas Station support.
// Ethereum Sepolia can use other Circle wallet products/Gas Station, but it is
// not an MSCA network and must never enter the passkey/session UserOperation flow.
// Mainnet (scope saat ini) hanya mengizinkan Arc.
export const MSCA_SUPPORTED_CHAIN_KEYS = [...arc.mscaChainKeys]

export const CHAINS = {
  [arc.key]: {
    id: arc.chainId,
    name: arc.name,
    shortName: 'ARC',
    rpcUrl: resolveArcRpc(),
    explorerUrl: arc.explorerUrl,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    transportSlug: arc.transportSlug,
    tokens: { ...arc.tokens },
  },
  'ethereum-sepolia': {
    id: 11155111,
    name: 'Ethereum Sepolia',
    shortName: 'ETH',
    rpcUrl: process.env.ETH_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    transportSlug: 'ethSepolia',
    tokens: {
      USDC:  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      ETH:   null, // native
      EURC:  '0x08210F5488734207B08B3C5A7DB76aE3154f4286',
      cirBTC: null,
    },
  },
  'arbitrum-sepolia': {
    id: 421614,
    name: 'Arbitrum Sepolia',
    shortName: 'ARB',
    rpcUrl: process.env.ARB_SEPOLIA_RPC_URL || 'https://arbitrum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    // Circle Modular Web SDK uses the lowerCamelCase Chain class name.
    // Arbitrum Sepolia is ArbitrumSepolia, not the abbreviated arbSepolia.
    transportSlug: 'arbitrumSepolia',
    tokens: {
      USDC:  '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      ETH:   null, // native
      EURC:  null, // No verified Arbitrum Sepolia EURC address configured.
      cirBTC: null,
    },
  },
  'base-sepolia': {
    id: 84532,
    name: 'Base Sepolia',
    shortName: 'BASE',
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    transportSlug: 'baseSepolia',
    tokens: {
      USDC:  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      ETH:   null, // native
      EURC:  '0x044d5736a68653d2bc4751b3f8a238ee189c5f71',
      cirBTC: null,
    },
  },
  // ── Chain mainnet non-Arc ──
  // Read-only: saldo ERC-20/native + tujuan CCTP. MSCA sengaja TIDAK
  // didaftarkan di sini — MSCA_SUPPORTED_CHAIN_KEYS tetap diambil dari
  // registry jaringan aktif (mainnet saat ini hanya Arc). Semua alamat token di
  // bawah diverifikasi on-chain lewat symbol()/decimals() sebelum dipakai.
  'ethereum-mainnet': {
    id: 1,
    name: 'Ethereum',
    shortName: 'ETH',
    rpcUrl: process.env.ETH_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    transportSlug: 'ethereum',
    tokens: {
      USDC:   '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      ETH:    null, // native
      EURC:   '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
      cirBTC: null, // belum ada di mainnet
    },
  },
  'base-mainnet': {
    id: 8453,
    name: 'Base',
    shortName: 'BASE',
    rpcUrl: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    transportSlug: 'base',
    tokens: {
      USDC:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      ETH:    null, // native
      EURC:   '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
      cirBTC: null,
    },
  },
  'arbitrum-mainnet': {
    id: 42161,
    name: 'Arbitrum One',
    shortName: 'ARB',
    rpcUrl: process.env.ARB_MAINNET_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    transportSlug: 'arbitrum',
    tokens: {
      USDC:   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      ETH:    null, // native
      EURC:   null, // alamat EURC Arbitrum mainnet belum terverifikasi
      cirBTC: null,
    },
  },
}

export const CHAIN_LIST = Object.entries(CHAINS).map(([key, c]) => ({
  key, ...c,
}))

/**
 * Daftar chain untuk permukaan API (`/api/chains`) sesuai jaringan aktif.
 * Entri Sepolia/mainnet tetap ada di CHAINS sebagai rute baca, tapi mainnet
 * tidak pernah mengiklankan chain Sepolia dan sebaliknya.
 */
export const ACTIVE_CHAIN_LIST = CHAIN_LIST.filter(chain => ARC_BALANCE_CHAIN_KEYS.includes(chain.key))

/** ERC-20 balanceOf(address) calldata */
export function erc20BalanceOfCalldata(walletAddress) {
  const selector = '0x70a08231' // balanceOf(address)
  return selector + walletAddress.toLowerCase().slice(2).padStart(64, '0')
}

/** ERC-20 decimals() calldata */
export function erc20DecimalsCalldata() {
  return '0x313ce567' // decimals()
}
