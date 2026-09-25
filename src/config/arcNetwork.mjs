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
