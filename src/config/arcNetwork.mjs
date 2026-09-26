// arcNetwork.mjs — satu-satunya sumber kebenaran untuk jaringan Arc yang aktif.
//
// Default tetap TESTNET. Ganti ke mainnet hanya lewat env:
//
//   ARC_NETWORK=mainnet
//
// (atau `ARC_CHAIN_ID=5042`). Tidak ada perubahan kode, dan data testnet tidak
// tersentuh: state per-jaringan dipisah oleh chain key (`arc-testnet` vs
// `arc-mainnet`) sehingga session, binding agent, dan invoice tidak bercampur.
//
// Semua nilai mainnet di bawah diverifikasi lewat probe read-only
// (`npm run probe:mainnet`); lihat docs/mainnet-x402-readiness.md.
//
// Aturan penting: alamat kontrak ARCOX mainnet TIDAK pernah diambil dari nilai
// testnet. Kalau kontraknya belum di-deploy, resolusi mengembalikan null supaya
// pemanggil gagal dengan pesan jelas, bukan mengirim transaksi ke alamat testnet.

const TESTNET = {
  id: 'testnet',
  key: 'arc-testnet',
  chainId: 5042002,
  chainIdHex: '0x4cef52',
  name: 'Arc Testnet',
  shortLabel: 'ARC Testnet',
  isMainnet: false,
  publicRpc: 'https://rpc.testnet.arc.io',
  drpcRpc: 'https://arc-testnet.drpc.org',
  explorerUrl: 'https://testnet.arcscan.app',
  transportSlug: 'arcTestnet',
  circleEnv: 'testnet',
  circleBaseUrl: 'https://api-sandbox.circle.com',
  cctpDomain: 26,
  gatewayBaseUrl: 'https://gateway-api-testnet.circle.com',
  // Terverifikasi dari GET https://gateway-api-testnet.circle.com/v1/info:
  // domain 26 → chain "Arc", network "Testnet". Nama chain di API Gateway
  // ternyata "Arc" (bukan "Arc_Testnet") dan sama di kedua jaringan; yang
  // membedakan hanya field `network`. Kunci internal aplikasi tetap
  // "Arc_Testnet" supaya kontrak dengan frontend/MCP tidak berubah.
  gatewayChainName: 'Arc',
  gatewayKey: 'Arc_Testnet',
  gatewayNetwork: 'Testnet',
  // Nama chain versi SDK Circle (Swap Kit/Bridge Kit) & CCTP yang dipakai
  // jalur bridge MCP. Mainnet memakai 'Arc' mengikuti slug transport Circle
  // (`arc`); jalur SDK mainnet tetap digerbang gagal-keras sampai SDK-nya ada.
  sdkChainName: 'Arc_Testnet',
  gatewayWallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  gatewayMinter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  usdc: '0x3600000000000000000000000000000000000000',
  tokens: {
    USDC: '0x3600000000000000000000000000000000000000',
    ETH: null, // native on Arc adalah USDC
    EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
    cirBTC: null,
  },
  cctp: {
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  },
  contracts: {
    memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
    identityRegistry: null,
  },
  // API attestation/fee CCTP Circle (Iris). Sandbox hanya untuk testnet.
  irisBaseUrl: 'https://iris-api-sandbox.circle.com',
  // Identifier blockchain Circle Wallets. SDK terpasang hanya mengenal Arc
  // Testnet, jadi mainnet memakai nilainya sendiri (override via env).
  circleWalletBlockchain: 'ARC-TESTNET',
  // Chain non-Arc yang dipakai jalur MSCA/Agent Wallet pada jaringan ini.
  externalChainKeys: ['ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia'],
  // Chain CCTP (domain, kontrak, explorer, retry) sesuai jaringan aktif.
  // Nilai testnet di bawah dipertahankan apa adanya (case mengikuti nilai lama).
  cctpChains: {
    Arc_Testnet: {
      chainId: 5042002,
      domain: 26,
      name: 'Arc Testnet',
      usdc: '0x3600000000000000000000000000000000000000',
      tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      explorer: 'https://testnet.arcscan.app/tx/',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: ['https://rpc.testnet.arc.io'],
      retry: { maxRetries: 60, fastMode: true },
      isArc: true,
    },
    Ethereum_Sepolia: {
      chainId: 11155111,
      domain: 0,
      name: 'Sepolia',
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
      messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
      explorer: 'https://sepolia.etherscan.io/tx/',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
      retry: { maxRetries: 700, fastMode: false },
    },
    Base_Sepolia: {
      chainId: 84532,
      domain: 6,
      name: 'Base Sepolia',
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
      messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
      explorer: 'https://sepolia.basescan.org/tx/',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://sepolia.base.org'],
      retry: { maxRetries: 700, fastMode: false },
    },
    Arbitrum_Sepolia: {
      chainId: 421614,
      domain: 3,
      name: 'Arbitrum Sepolia',
      usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
      messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
      explorer: 'https://sepolia.arbiscan.io/tx/',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'],
      retry: { maxRetries: 300, fastMode: false },
    },
    HyperEVM_Testnet: {
      chainId: 998,
      domain: 19,
      name: 'HyperEVM Testnet',
      usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab',
      tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      explorer: 'https://app.hyperliquid-testnet.xyz/explorer/tx/',
      nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
      rpcUrls: ['https://rpc.hyperliquid-testnet.xyz/evm'],
      retry: { maxRetries: 300, fastMode: false },
    },
  },
  solanaCctp: {
    domain: 5,
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    tokenMessengerProgram: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
    messageTransmitterProgram: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
    rpc: 'https://api.devnet.solana.com',
    rpcEnv: 'SOLANA_DEVNET_RPC',
    explorer: 'https://explorer.solana.com/tx/',
  },
  // MSCA/testnet mendukung tiga chain; mainnet (scope saat ini) hanya Arc.
  mscaChainKeys: ['arc-testnet', 'base-sepolia', 'arbitrum-sepolia'],
  gatewayChains: [
    { chain: 'Arc_Testnet', domain: 26, ecosystem: 'evm' },
    { chain: 'Base_Sepolia', domain: 6, ecosystem: 'evm' },
    { chain: 'Ethereum_Sepolia', domain: 0, ecosystem: 'evm' },
    { chain: 'Arbitrum_Sepolia', domain: 3, ecosystem: 'evm' },
    { chain: 'Solana_Devnet', domain: 5, ecosystem: 'solana' },
  ],
}

const MAINNET = {
  id: 'mainnet',
  key: 'arc-mainnet',
  chainId: 5042,
  chainIdHex: '0x13b2',
  name: 'Arc Mainnet',
  shortLabel: 'ARC',
  isMainnet: true,
  publicRpc: 'https://rpc.mainnet.arc.io',
  drpcRpc: '', // tidak ada endpoint dRPC mainnet yang terverifikasi
  explorerUrl: 'https://explorer.arc.io',
  transportSlug: 'arc',
  circleEnv: 'live',
  circleBaseUrl: 'https://api.circle.com',
  cctpDomain: 26,
  gatewayBaseUrl: 'https://gateway-api.circle.com',
  // Terverifikasi dari GET https://gateway-api.circle.com/v1/info →
  // domain 26, chain "Arc", network "Mainnet".
  gatewayChainName: 'Arc',
  gatewayKey: 'Arc',
  gatewayNetwork: 'Mainnet',
  sdkChainName: 'Arc',
  gatewayWallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  gatewayMinter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
  usdc: '0x3600000000000000000000000000000000000000',
  tokens: {
    USDC: '0x3600000000000000000000000000000000000000',
    ETH: null,
    EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    USYC: '0x8a5D989Bbb96929F689B0200f435f53dA42bF490',
    cirBTC: null,
  },
  cctp: {
    tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
  },
  contracts: {
    memo: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  },
  // Iris produksi. Endpoint sandbox sengaja tidak pernah dipakai di mainnet
  // (lihat arcIrisBaseUrl) supaya attestation/fee tidak pernah dibaca dari
  // lingkungan uji.
  irisBaseUrl: 'https://iris-api.circle.com',
  // Identifier blockchain Circle Wallets untuk Arc mainnet. SDK Circle yang
  // terpasang belum mengekspor konstanta ini, jadi operator bisa menimpanya
  // lewat ARC_CIRCLE_WALLET_BLOCKCHAIN setelah Circle merilis nilainya.
  circleWalletBlockchain: 'ARC',
  externalChainKeys: ['ethereum-mainnet', 'base-mainnet', 'arbitrum-mainnet'],
  // CCTP v2 mainnet: TokenMessengerV2/MessageTransmitterV2 memakai alamat
  // deterministik yang sama di seluruh EVM (diverifikasi on-chain: kode 2175
  // byte). Kunci di bawah adalah nama chain mainnet yang dipakai frontend.
  cctpChains: {
    Arc: {
      chainId: 5042,
      domain: 26,
      name: 'Arc Mainnet',
      usdc: '0x3600000000000000000000000000000000000000',
      tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      explorer: 'https://explorer.arc.io/tx/',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: ['https://rpc.mainnet.arc.io'],
      retry: { maxRetries: 60, fastMode: true },
      isArc: true,
    },
    Ethereum: {
      chainId: 1,
      domain: 0,
      name: 'Ethereum',
      usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      explorer: 'https://etherscan.io/tx/',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://ethereum-rpc.publicnode.com'],
      retry: { maxRetries: 700, fastMode: false },
    },
    Base: {
      chainId: 8453,
      domain: 6,
      name: 'Base',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      explorer: 'https://basescan.org/tx/',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      retry: { maxRetries: 700, fastMode: false },
    },
    Arbitrum: {
      chainId: 42161,
      domain: 3,
      name: 'Arbitrum One',
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      explorer: 'https://arbiscan.io/tx/',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://arb1.arbitrum.io/rpc'],
      retry: { maxRetries: 300, fastMode: false },
    },
    HyperEVM: {
      chainId: 999,
      domain: 19,
      name: 'HyperEVM',
      usdc: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
      tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
      messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
      explorer: 'https://hyperevmscan.io/tx/',
      nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
      rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
      retry: { maxRetries: 300, fastMode: false },
    },
  },
  solanaCctp: {
    domain: 5,
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    tokenMessengerProgram: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
    messageTransmitterProgram: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
    rpc: 'https://api.mainnet-beta.solana.com',
    rpcEnv: 'SOLANA_MAINNET_RPC',
    explorer: 'https://explorer.solana.com/tx/',
  },
  mscaChainKeys: ['arc-mainnet'],
  // Unified Balance / Auto Pay mainnet: hanya Arc yang sudah diverifikasi lewat
  // GET https://gateway-api.circle.com/v1/info. Chain mainnet lain sengaja
  // belum didaftarkan supaya fitur gagal dengan pesan jelas alih-alih diam-diam
  // memakai nama chain testnet (Base_Sepolia, Solana_Devnet, dst).
  gatewayChains: [
    { chain: 'Arc', domain: 26, ecosystem: 'evm' },
  ],
}

export const ARC_NETWORKS = { testnet: TESTNET, mainnet: MAINNET }

const ALIASES = {
  mainnet: 'mainnet', 'arc-mainnet': 'mainnet', arc_mainnet: 'mainnet', live: 'mainnet', arc: 'mainnet',
  testnet: 'testnet', 'arc-testnet': 'testnet', arc_testnet: 'testnet', sandbox: 'testnet',
}

// Slug Circle (`arcTestnet`) dan nama produk (`Arc_Testnet`/`Arc`) juga harus
// dikenali supaya input dari MCP/console tidak menyasar jaringan yang salah.
const CHAIN_KEY_ALIASES = {
  arc: 'arc-mainnet', arc_mainnet: 'arc-mainnet', 'arc-mainnet': 'arc-mainnet',
  arcmainnet: 'arc-mainnet', arc_testnet: 'arc-testnet', 'arc-testnet': 'arc-testnet',
  arctestnet: 'arc-testnet',
}

/** Nama jaringan aktif dari env (`ARC_NETWORK`, fallback `ARC_CHAIN_ID`). */
export function arcNetworkId(env = process.env) {
  const explicit = ALIASES[String(env.ARC_NETWORK || '').trim().toLowerCase()]
  if (explicit) return explicit
  if (String(env.ARC_CHAIN_ID || '').trim() === String(MAINNET.chainId)) return 'mainnet'
  return 'testnet'
}

/** Objek jaringan aktif. */
export function arcNetwork(env = process.env) {
  return ARC_NETWORKS[arcNetworkId(env)]
}

/** Normalisasi alias chain key ke key jaringan yang sedang aktif. */
export function resolveArcChainKey(value, env = process.env) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return arcNetwork(env).key
  if (raw === 'arc' || raw === 'arc-testnet' || raw === 'arc-mainnet' || raw === 'arc_testnet' || raw === 'arc_mainnet') {
    return arcNetwork(env).key
  }
  return CHAIN_KEY_ALIASES[raw] || raw
}

/** True kalau nilai apa pun menunjuk ke chain Arc (alias testnet maupun mainnet). */
export function isArcChainKey(value) {
  const raw = String(value || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(CHAIN_KEY_ALIASES, raw)
}

const network = arcNetwork()

export const ARC_NETWORK_ID = network.id
export const IS_ARC_MAINNET = network.isMainnet
export const ARC_CHAIN_KEY = network.key
export const ARC_CHAIN_ID = network.chainId
export const ARC_CHAIN_ID_HEX = network.chainIdHex
export const ARC_CHAIN_NAME = network.name
export const ARC_NETWORK_LABEL = network.name
export const ARC_EXPLORER_URL = network.explorerUrl
export const ARC_TRANSPORT_SLUG = network.transportSlug
export const ARC_CCTP_DOMAIN = network.cctpDomain
export const ARC_CIRCLE_ENV = network.circleEnv
export const ARC_GATEWAY_CHAIN_NAME = network.gatewayChainName
export const ARC_USDC_ADDRESS = network.usdc
export const ARC_GATEWAY_WALLET = network.gatewayWallet
export const ARC_GATEWAY_MINTER = network.gatewayMinter
export const ARC_GATEWAY_NETWORK_LABEL = network.gatewayNetwork
// Kunci/vokabulari internal (dipakai frontend, MCP, dan state tersimpan).
export const ARC_GATEWAY_KEY = network.gatewayKey
// Nama chain versi SDK Circle untuk jalur bridge/CCTP.
export const ARC_SDK_CHAIN_NAME = network.sdkChainName

/** Daftar chain Circle Gateway untuk jaringan aktif (Unified Balance/Auto Pay). */
export function arcGatewayChains() {
  return network.gatewayChains.map(entry => ({ ...entry }))
}

/** Alamat token aktif (null kalau token tidak ada di jaringan ini). */
export function arcTokenAddress(symbol) {
  return network.tokens[String(symbol || '').toUpperCase()] ?? null
}

/** Alamat kontrak pihak Circle sesuai jaringan aktif. */
export function arcCircleContract(name) {
  return network.cctp[name] ?? network.contracts[name] ?? null
}

/**
 * Base URL Circle Gateway sesuai jaringan aktif, boleh dioverride env.
 * `CIRCLE_GATEWAY_BASE_URL` selalu menang supaya operator bisa mengarahkan ke
 * proxy/lingkungan lain tanpa mengubah kode.
 */
export function arcGatewayBaseUrl(env = process.env) {
  return String(env.CIRCLE_GATEWAY_BASE_URL || '').trim().replace(/\/+$/, '') || network.gatewayBaseUrl
}

/**
 * Kontrak ARCOX (Fee Router, AMM Router, Swap Adapter, Agentic Commerce).
 *
 * Di mainnet TIDAK ada fallback ke alamat testnet: alamat harus datang dari
 * `<ENV>_MAINNET` supaya transaksi tidak pernah menyasar kontrak testnet.
 */
export function arcContractAddress(name, env = process.env) {
  const suffix = network.isMainnet ? '_MAINNET' : ''
  const value = String(env[`${name}${suffix}`] || '').trim()
  if (value) return value
  if (!network.isMainnet) return String(env[name] || '').trim() || null
  return null
}

/** Pesan error seragam untuk kontrak ARCOX yang belum tersedia di jaringan aktif. */
export function arcContractMissingMessage(name) {
  return network.isMainnet
    ? `${name} belum di-deploy ke Arc mainnet; set ${name}_MAINNET setelah deploy (alamat testnet sengaja tidak dipakai).`
    : `${name} belum dikonfigurasi.`
}

/**
 * API key Circle sesuai jaringan aktif.
 *
 * Mainnet HANYA memakai `CIRCLE_API_KEY_MAINNET` (tanpa fallback ke key
 * sandbox) supaya kunci testnet tidak pernah terpakai di produksi.
 */
export function arcCircleApiKey(env = process.env) {
  return network.isMainnet
    ? String(env.CIRCLE_API_KEY_MAINNET || '').trim()
    : String(env.CIRCLE_API_KEY || '').trim()
}

/**
 * Client Key Circle (embedded/agent wallet) sesuai jaringan aktif.
 * Mainnet memakai `CIRCLE_CLIENT_KEY_LIVE`, testnet `CIRCLE_CLIENT_KEY`.
 */
export function arcCircleClientKey(env = process.env) {
  return network.isMainnet
    ? String(env.CIRCLE_CLIENT_KEY_LIVE || '').trim()
    : String(env.CIRCLE_CLIENT_KEY || '').trim()
}

/**
 * Base URL Circle API sesuai jaringan aktif. `CIRCLE_BASE_URL` boleh dipakai
 * sebagai override, tapi endpoint sandbox tidak pernah dipakai di mainnet.
 */
export function arcCircleBaseUrl(env = process.env) {
  const explicit = String(env.CIRCLE_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!network.isMainnet) return explicit || network.circleBaseUrl
  if (explicit && !/sandbox|testnet/i.test(explicit)) return explicit
  return network.circleBaseUrl
}

/**
 * Base URL Circle Iris (attestation + CCTP fast-transfer fee) sesuai jaringan
 * aktif. Override `CIRCLE_IRIS_BASE_URL`/`CCTP_FEE_API_BASE_URL` dihormati, tapi
 * endpoint sandbox tidak pernah dipakai di mainnet.
 */
export function arcIrisBaseUrl(env = process.env) {
  const explicit = String(env.CIRCLE_IRIS_BASE_URL || env.CCTP_FEE_API_BASE_URL || '').trim().replace(/\/+$/, '')
  if (!network.isMainnet) return explicit || network.irisBaseUrl
  if (explicit && !/sandbox|testnet/i.test(explicit)) return explicit
  return network.irisBaseUrl
}

/** Daftar chain CCTP untuk jaringan aktif, key = nama chain (mis. `Arc`). */
export function arcCctpChains() {
  return network.cctpChains
}

/** Entri chain CCTP jaringan aktif (null kalau nama chain tidak dikenal). */
export function arcCctpChain(name) {
  return network.cctpChains[String(name || '').trim()] || null
}

/** Map nama chain → domain CCTP untuk jaringan aktif. */
export function arcCctpDomains() {
  return Object.fromEntries(Object.entries(network.cctpChains).map(([name, cfg]) => [name, cfg.domain]))
}

/**
 * Identifer blockchain Circle Wallets untuk Arc pada jaringan aktif.
 * SDK terpasang hanya mengenal Arc Testnet, jadi mainnet memakai
 * `ARC_CIRCLE_WALLET_BLOCKCHAIN` (kalau diisi) atau nilainya dari registry.
 */
export function arcCircleWalletBlockchain(env = process.env) {
  if (network.isMainnet) return String(env.ARC_CIRCLE_WALLET_BLOCKCHAIN || '').trim() || network.circleWalletBlockchain
  return network.circleWalletBlockchain
}

/** Chain non-Arc (MSCA/Agent Wallet) untuk jaringan aktif. */
export const ARC_EXTERNAL_CHAIN_KEYS = [...network.externalChainKeys]

// Alias pendek yang dipakai API/MCP (mis. `base`, `arbitrum`).
const EXTERNAL_CHAIN_SHORT_NAMES = {
  ethereum: 'ethereum', eth: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum', arb: 'arbitrum',
}

/**
 * Normalisasi alias chain MSCA ke chain key jaringan aktif.
 *
 * Testnet: `base`/`base_sepolia` → `base-sepolia`.
 * Mainnet: `base`/`base_mainnet` → `base-mainnet`.
 * Chain Arc (alias apa pun) selalu dipetakan ke chain key Arc jaringan aktif.
 */
export function resolveMscaChainKey(value, env = process.env) {
  const net = arcNetwork(env)
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return net.key
  // Semua alias Arc (arc, arc-testnet, Arc_Testnet, ...) → chain key jaringan aktif.
  if (raw === 'arc' || isArcChainKey(raw)) return net.key
  const suffix = net.isMainnet ? 'mainnet' : 'sepolia'
  const short = EXTERNAL_CHAIN_SHORT_NAMES[raw] || raw.replace(/[-_](mainnet|sepolia|testnet)$/, '')
  const candidate = `${EXTERNAL_CHAIN_SHORT_NAMES[short] || short}-${suffix}`
  return net.externalChainKeys.includes(candidate) ? candidate : raw
}

/** Chain yang dibaca untuk saldo multi-chain: Arc + chain non-Arc jaringan aktif. */
export const ARC_BALANCE_CHAIN_KEYS = [network.key, ...network.externalChainKeys]

/** Konfigurasi CCTP Solana sesuai jaringan aktif (RPC bisa dioverride env). */
export function arcSolanaCctp(env = process.env) {
  const cfg = network.solanaCctp
  const rpc = String(env[cfg.rpcEnv] || '').trim() || cfg.rpc
  return { ...cfg, rpc }
}
