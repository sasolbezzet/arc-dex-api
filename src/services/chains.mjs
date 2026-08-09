// chains.mjs — Multi-chain configuration for MSCA + balance fetching.
// Supported: Arc Testnet, Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia.

export const CHAINS = {
  'arc-testnet': {
    id: 5042002,
    name: 'Arc Testnet',
    shortName: 'ARC',
    rpcUrl: process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network',
    explorerUrl: 'https://testnet.arcscan.app',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    transportSlug: 'arcTestnet',
    tokens: {
      USDC:  '0x3600000000000000000000000000000000000000',
      ETH:   null, // native on Arc is USDC
      EURC:  null,
      cirBTC: null,
    },
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
    transportSlug: 'arbSepolia',
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
}

export const CHAIN_LIST = Object.entries(CHAINS).map(([key, c]) => ({
  key, ...c,
}))

/** ERC-20 balanceOf(address) calldata */
export function erc20BalanceOfCalldata(walletAddress) {
  const selector = '0x70a08231' // balanceOf(address)
  return selector + walletAddress.toLowerCase().slice(2).padStart(64, '0')
}

/** ERC-20 decimals() calldata */
export function erc20DecimalsCalldata() {
  return '0x313ce567' // decimals()
}
