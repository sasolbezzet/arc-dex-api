import 'dotenv/config'
import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHmac, timingSafeEqual } from 'crypto'
import { AppKit, SwapChain } from '@circle-fin/app-kit'
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits, defineChain, getAddress, isAddress, verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

process.on('uncaughtException', (err) => console.error('[UncaughtException]', err.message))
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason?.message || reason))
BigInt.prototype.toJSON = function() { return this.toString() }

const app = express()
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'https://43.163.98.128.nip.io',
  'https://43.163.98.128.nip.io/arc-dex',
]
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(v => v.trim())
  .filter(Boolean)
const VERCEL_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && (ALLOWED_ORIGINS.includes(origin) || VERCEL_ORIGIN_RE.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})
app.use(express.json({ limit: '64kb' }))

const KIT_KEY = process.env.KIT_KEY
const PORT = process.env.PORT || 3001
const WALLET_DB = './wallets-db.json'
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.CIRCLE_ENTITY_SECRET || process.env.CIRCLE_API_KEY || ''
const AUTH_TTL_MS = Number(process.env.AUTH_TTL_MS || 24 * 60 * 60 * 1000)
const LOGIN_WINDOW_MS = 5 * 60 * 1000
if (!process.env.AUTH_SECRET) console.warn('[security] AUTH_SECRET not set. Set a dedicated random AUTH_SECRET before production.')

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network/'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
})

const TOKENS = {
  cirBTC: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
}

const SEND_TOKEN_MAP = {
  USDC: 'USDC',
  EURC: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
  USYC: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
}

const CCTP = {
  Arc_Testnet: {
    domain: 26,
    usdc: '0x3600000000000000000000000000000000000000',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    explorer: 'https://testnet.arcscan.app/tx/',
    chain: arcTestnet,
  },
  Ethereum_Sepolia: {
    domain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    explorer: 'https://sepolia.etherscan.io/tx/',
    chain: defineChain({ id: 11155111, name: 'Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } } }),
  },
  Base_Sepolia: {
    domain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    explorer: 'https://sepolia.basescan.org/tx/',
    chain: defineChain({ id: 84532, name: 'Base Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://sepolia.base.org'] } } }),
  },
  Arbitrum_Sepolia: {
    domain: 3,
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessenger: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
    messageTransmitter: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
    explorer: 'https://sepolia.arbiscan.io/tx/',
    chain: defineChain({ id: 421614, name: 'Arbitrum Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://arbitrum-sepolia.publicnode.com'] } } }),
  },
  HyperEVM_Testnet: {
    domain: 19,
    usdc: '0x2B3370eE501B4a559b57D449569354196457D8Ab',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    explorer: 'https://app.hyperliquid-testnet.xyz/explorer/tx/',
    chain: defineChain({ id: 998, name: 'HyperEVM Testnet', nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.hyperliquid-testnet.xyz/evm'] } } }),
  },
}

const SOLANA_CCTP = {
  domain: 5,
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  tokenMessengerProgram: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
  messageTransmitterProgram: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  rpc: process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com/tx/',
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ name: 'success', type: 'bool' }],
  stateMutability: 'nonpayable'
}]

// ── Chain-aware attestation polling retry config ──
// Arc/Solana: ~detik finality → 30s polling  |  Arbitrum: ~1-5mnt → ~9mnt buffer
// Sepolia/Base: ~12-19mnt finality → ~22mnt buffer
const RETRY_CFG = {
  Arc_Testnet: { maxRetries: 60, fastMode: true },
  Solana_Devnet: { maxRetries: 60, fastMode: true },
  Arbitrum_Sepolia: { maxRetries: 300, fastMode: false },
  Ethereum_Sepolia: { maxRetries: 700, fastMode: false },
  Base_Sepolia: { maxRetries: 700, fastMode: false },
  HyperEVM_Testnet: { maxRetries: 300, fastMode: false },
}

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const circleAdapter = createCircleWalletsAdapter({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const kit = new AppKit()

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signPayload(payload) {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
}

function authMessage(address, issuedAt) {
  return [
    'ARCOX DEX login',
    'Only sign this message on the official ARCOX DEX website.',
    `Address: ${getAddress(address)}`,
    `Issued At: ${issuedAt}`,
    'Network: Arc Testnet',
  ].join('\n')
}

function createAuthToken(address) {
  if (!AUTH_SECRET) throw new Error('AUTH_SECRET belum dikonfigurasi')
  const payload = b64url(JSON.stringify({ address: getAddress(address).toLowerCase(), exp: Date.now() + AUTH_TTL_MS }))
  return `${payload}.${signPayload(payload)}`
}

function verifyAuthToken(token) {
  if (!AUTH_SECRET || !token || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  const expected = signPayload(payload)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (!data?.address || !data?.exp || Date.now() > data.exp) return null
  return data.address
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const authAddress = verifyAuthToken(token)
  if (!authAddress) return res.status(401).json({ error: 'Wallet authentication required' })
  const bodyAddress = req.body?.metamaskAddress || req.body?.address
  if (bodyAddress && (!isAddress(bodyAddress) || getAddress(bodyAddress).toLowerCase() !== authAddress)) {
    return res.status(403).json({ error: 'Authenticated wallet does not match request address' })
  }
  req.authAddress = authAddress
  next()
}

function normalizeAddress(value, field = 'address') {
  if (!value || !isAddress(value)) throw new Error(`Invalid ${field}`)
  return getAddress(value)
}

function normalizeAmount(value) {
  const raw = String(value ?? '')
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error('Invalid amount')
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) throw new Error('Invalid amount')
  if (num > 1_000_000) throw new Error('Amount exceeds safety limit')
  return raw
}

function isNoSwapRouteError(err) {
  const msg = err?.message || String(err || '')
  return msg.includes('No route available') ||
    msg.includes('Route or resource not found') ||
    msg.includes('route is not supported') ||
    msg.includes('Swap route not found')
}

function noSwapRouteResponse(res, err) {
  console.warn('[swap] no route:', err?.message || err)
  return res.json({
    success: false,
    available: false,
    code: 'NO_SWAP_ROUTE',
    error: 'Route swap belum tersedia dari Circle Stablecoin Service untuk pasangan/jumlah ini. Coba jumlah lebih besar, atau ulangi beberapa menit lagi.',
    details: err?.message || String(err || ''),
  })
}

function loadWallets() {
  try { return existsSync(WALLET_DB) ? JSON.parse(readFileSync(WALLET_DB, 'utf-8')) : {} }
  catch { return {} }
}
function saveWallets(db) { writeFileSync(WALLET_DB, JSON.stringify(db, null, 2)) }

async function getOrCreateWallet(metamaskAddr) {
  const addr = metamaskAddr.toLowerCase()
  const db = loadWallets()
  if (db[addr]) {
    const record = typeof db[addr] === 'string' ? { id: db[addr] } : db[addr]
    const res = await circleClient.getWallet({ id: record.id })
    const wallet = res.data?.wallet
    if (wallet?.id && wallet?.address && (typeof db[addr] === 'string' || db[addr].address !== wallet.address)) {
      db[addr] = { id: wallet.id, address: wallet.address }
      saveWallets(db)
    }
    return wallet
  }
  const ws = await circleClient.createWalletSet({ name: `user-${addr.slice(0,8)}` })
  const wr = await circleClient.createWallets({
    blockchains: ['ARC-TESTNET'], count: 1,
    walletSetId: ws.data?.walletSet?.id ?? '', accountType: 'SCA',
  })
  const wallet = wr.data?.wallets?.[0]
  db[addr] = { id: wallet.id, address: wallet.address }
  saveWallets(db)
  console.log(`[wallet] new: ${addr} → ${wallet.address}`)
  return wallet
}

async function pollAttestation(domain, txHash, maxRetries = 60, fastMode = false) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${txHash}`
  console.log(`[iris] polling: domain=${domain} tx=${txHash.slice(0,12)}... (fast=${fastMode})`)
  let lastStatus = ''
  for (let i = 0; i < maxRetries; i++) {
    // Adaptive delay: fast chains (instant finality) poll quicker
    let delay
    if (fastMode) {
      delay = 500
    } else if (i < 20) {
      delay = 500  // First 10s: aggressive
    } else if (i < 60) {
      delay = 1000 // Next 40s: moderate
    } else {
      delay = 2000 // After 60s: slow/patient
    }
    await new Promise(r => setTimeout(r, delay))
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!r.ok) { if (i % 10 === 0) console.log(`[iris] HTTP ${r.status} (retry ${i+1}/${maxRetries})`); continue }
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('json')) { if (i % 10 === 0) console.log('[iris] non-JSON response'); continue }
      const data = await r.json()
      const msg = data?.messages?.[0]
      const curStatus = msg?.status || 'no message'
      if (curStatus !== lastStatus || i % 10 === 0) {
        console.log(`[iris] attempt ${i+1}/${maxRetries}: ${curStatus}`)
        lastStatus = curStatus
      }
      if (msg?.status === 'complete' && msg.attestation && msg.message) {
        const elapsed = fastMode ? ((i+1)*0.5) : (i < 20 ? (i+1)*0.5 : i < 60 ? 10 + (i-20)*1 : 10 + 40 + (i-60)*2)
        console.log(`[iris] ✓ attestation ready after ~${elapsed.toFixed(1)}s`)
        return { attestation: msg.attestation, message: msg.message }
      }
    } catch(e) { if (i % 10 === 0) console.log(`[iris] error: ${e.message}`) }
  }
  return null
}

async function checkAttestationOnce(domain, txHash) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${txHash}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) return { complete: false, status: `http_${r.status}` }
  const ct = r.headers.get('content-type') || ''
  if (!ct.includes('json')) return { complete: false, status: 'non_json' }
  const data = await r.json()
  const msg = data?.messages?.[0]
  if (msg?.status === 'complete' && msg.attestation && msg.message) {
    return { complete: true, attestation: msg.attestation, message: msg.message, status: msg.status }
  }
  return { complete: false, status: msg?.status || 'no_message' }
}

// ── Health ──
app.get('/health', (_, res) => res.json({ ok: true, time: new Date(), version: '2.0.0' }))

app.get('/api/config', (_, res) => {
  res.json({ kitKey: KIT_KEY || '' })
})

app.post('/api/auth/session', async (req, res) => {
  try {
    const { address, issuedAt, signature } = req.body || {}
    const normalized = normalizeAddress(address, 'address')
    const issuedTime = Date.parse(issuedAt)
    if (!issuedAt || !Number.isFinite(issuedTime) || Math.abs(Date.now() - issuedTime) > LOGIN_WINDOW_MS) {
      return res.status(400).json({ error: 'Login signature expired. Please reconnect wallet.' })
    }
    if (!signature || !/^0x[0-9a-f]+$/i.test(signature)) return res.status(400).json({ error: 'Invalid signature' })
    const ok = await verifyMessage({
      address: normalized,
      message: authMessage(normalized, issuedAt),
      signature,
    })
    if (!ok) return res.status(401).json({ error: 'Invalid wallet signature' })
    res.json({ success: true, token: createAuthToken(normalized), address: normalized })
  } catch(e) {
    console.error('[auth]', e.message)
    res.status(400).json({ error: e.message })
  }
})

// ── Wallet ──
app.post('/api/wallet', requireAuth, async (req, res) => {
  try {
    const { metamaskAddress } = req.body
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const w = await getOrCreateWallet(owner)
    res.json({ success: true, wallet: { id: w.id, address: w.address } })
  } catch(e) { console.error('[wallet]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Balance ──
app.get('/api/balance/:address', async (req, res) => {
  try {
    const target = normalizeAddress(req.params.address, 'address')
    const client = createPublicClient({ chain: arcTestnet, transport: http() })
    const result = {}
    for (const [sym, addr] of Object.entries(TOKENS)) {
      try {
        const bal = await client.readContract({ address: addr, abi: erc20Abi, functionName: 'balanceOf', args: [target] })
        result[sym] = formatUnits(bal, 6)
      } catch { result[sym] = '0' }
    }
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Quote ──
app.post('/api/quote', requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, tokenIn, tokenOut, amountIn } = req.body
    if (!metamaskAddress || !tokenIn || !tokenOut || !amountIn) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const safeAmount = normalizeAmount(amountIn)
    if (!KIT_KEY) return res.status(500).json({ error: 'KIT_KEY belum dikonfigurasi' })
    if (!TOKENS[tokenIn] || !TOKENS[tokenOut]) return res.status(400).json({ error: 'Unsupported token: ' + (!TOKENS[tokenIn] ? tokenIn : tokenOut) })
    if (tokenIn === tokenOut) return res.status(400).json({ error: 'Token swap harus berbeda' })
    try {
      const wallet = await getOrCreateWallet(owner)
      const estimate = await kit.estimateSwap({
        from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
        tokenIn,
        tokenOut,
        amountIn: safeAmount,
        config: { kitKey: KIT_KEY, allowanceStrategy: 'approve' },
      })
      const fee = (estimate.fees || []).reduce((sum, f) => sum + Number(f.amount || 0), 0)
      return res.json({
        available: true,
        amountOut: estimate.estimatedOutput?.amount || '0',
        fee: fee.toFixed(6),
        rate: Number(estimate.estimatedOutput?.amount || 0) / Number(safeAmount || 1),
      })
    } catch(e) {
      if (isNoSwapRouteError(e)) return noSwapRouteResponse(res, e)
      console.error('[quote]', e.message)
      return res.status(500).json({ error: e.message })
    }
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Swap ──
app.post('/api/swap', requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, tokenIn, tokenOut, amountIn } = req.body
    if (!metamaskAddress || !tokenIn || !tokenOut || !amountIn) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const safeAmount = normalizeAmount(amountIn)
    if (!KIT_KEY) return res.status(500).json({ error: 'KIT_KEY belum dikonfigurasi' })
    if (!TOKENS[tokenIn] || !TOKENS[tokenOut]) return res.status(400).json({ error: 'Unsupported token: ' + (!TOKENS[tokenIn] ? tokenIn : tokenOut) })
    if (tokenIn === tokenOut) return res.status(400).json({ error: 'Token swap harus berbeda' })
    const wallet = await getOrCreateWallet(owner)
    const params = {
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      tokenIn,
      tokenOut,
      amountIn: safeAmount,
      config: { kitKey: KIT_KEY, allowanceStrategy: 'approve' },
    }
    try {
      await kit.estimateSwap(params)
    } catch(e) {
      if (isNoSwapRouteError(e)) return noSwapRouteResponse(res, e)
      console.warn('[swap] estimate precheck failed, continuing:', e.message)
    }
    const result = await kit.swap(params)
    res.json({ success: true, result })
  } catch(e) {
    if (isNoSwapRouteError(e)) return noSwapRouteResponse(res, e)
    console.error('[swap]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Prepare Bridge (Circle → EOA) ──
app.post('/api/prepare-bridge', requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, amount, token } = req.body
    if (!metamaskAddress || !amount) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const safeAmount = normalizeAmount(amount)
    const bridgeToken = token || 'USDC'
    if (!TOKENS[bridgeToken]) return res.status(400).json({ error: 'Unsupported token: ' + bridgeToken })
    const wallet = await getOrCreateWallet(owner)
    const result = await kit.send({
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      to: owner, amount: safeAmount, token: bridgeToken,
    })
    res.json({ success: true, txHash: result.txHash, explorerUrl: result.explorerUrl })
  } catch(e) { console.error('[prepare-bridge]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Get Attestation - fast via App Kit ──
app.post('/api/get-attestation', async (req, res) => {
  try {
    const { txHash, fromChain, toChain, once } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3, HyperEVM_Testnet: 19, Solana_Devnet: 5 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain: ' + fromChain })
    const retryCfg = RETRY_CFG[fromChain] || { maxRetries: 120, fastMode: false }
    console.log(`[get-attestation] domain=${domain} tx=${txHash} retries=${retryCfg.maxRetries} fast=${retryCfg.fastMode}`)
    const att = once
      ? await checkAttestationOnce(domain, txHash).then(r => r.complete ? { attestation: r.attestation, message: r.message, status: r.status } : r)
      : await pollAttestation(domain, txHash, retryCfg.maxRetries, retryCfg.fastMode)
    if (once && !att?.attestation) return res.json({ success: false, pending: true, status: att?.status || 'pending' })
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Chain: ' + fromChain + ' may need more time.' })
    // Include messageTransmitter address + chainId untuk client sign via MetaMask
    let msgTx = null, dstChainId = null
    if (toChain && CCTP[toChain]) {
      msgTx = CCTP[toChain].messageTransmitter
      dstChainId = CCTP[toChain].chain.id
    }
    res.json({ success: true, attestation: att.attestation, message: att.message, domain, messageTransmitter: msgTx, chainId: dstChainId })
  } catch(e) { console.error('[get-attestation]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint via App Kit (EVM chains) - lebih reliable dari manual receiveMessage ──
app.post('/api/mint-via-appkit', async (req, res) => {
  if (process.env.ENABLE_SERVER_SIGNED_MINT !== 'true') {
    return res.status(403).json({ error: 'Server-signed mint disabled. Use wallet-signed retry mint.' })
  }
  try {
    const { burnTxHash, fromChain, toChain, toAddress, amount: reqAmount } = req.body
    if (!burnTxHash || !fromChain || !toChain) return res.status(400).json({ error: 'Missing params' })

      // Build RPC mapping by chain ID from CCTP config
      const RPC_BY_CHAIN_ID = {}
      for (const [, cfg] of Object.entries(CCTP)) {
        if (cfg.chain) {
          RPC_BY_CHAIN_ID[cfg.chain.id] = cfg.chain.rpcUrls.default.http[0]
        }
      }
      const viemAdapter = createViemAdapterFromPrivateKey({
        privateKey: process.env.OWNER_PRIVATE_KEY,
        getPublicClient: ({ chain }) => {
          const rpcUrl = RPC_BY_CHAIN_ID[chain.id]
          if (!rpcUrl) {
            console.warn('[mint-via-appkit] No RPC for chain ID ' + chain.id + ', using default')
            return createPublicClient({ chain, transport: http() })
          }
          return createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 3, timeout: 10000 }) })
        },
      })
    const { privateKeyToAccount } = await import('viem/accounts')
    const ownerAddress = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address
    
    // Reconstruct bridge result untuk retry
    const partialResult = {
      state: 'error',
        amount: reqAmount || '0',
      token: 'USDC',
      source: { address: ownerAddress, chain: fromChain },
      destination: { address: toAddress, chain: toChain },
      steps: [
        { name: 'approve', state: 'success' },
        { name: 'burn', state: 'success', txHash: burnTxHash },
        { name: 'fetchAttestation', state: 'error', error: 'Resuming from frontend burn' },
      ],
    }

      console.log(`[mint-via-appkit] retrying chain=${fromChain} -> ${toChain} tx=${burnTxHash}`)
    const retryResult = await kit.retry(partialResult, {
      from: viemAdapter,
      to: viemAdapter,
    })
    
    if (retryResult.state === 'success') {
      const mintStep = retryResult.steps?.find(s => s.name === 'mint')
      res.json({ success: true, txHash: mintStep?.txHash, explorerUrl: CCTP[toChain]?.explorer + mintStep?.txHash })
    } else {
      res.status(400).json({ error: 'Mint failed: ' + JSON.stringify(retryResult.steps?.find(s => s.state === 'error')?.error) })
    }
  } catch(e) { console.error('[mint-via-appkit]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP Solana (Arc/EVM → Solana) - return attestation untuk Solflare sign ──
app.post('/api/mint-cctp-solana', async (req, res) => {
  try {
    const { burnTxHash, toAddress, fromChain } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })
    const solDomain = CCTP[fromChain]?.domain ?? 26
    console.log('[mint-cctp-solana] fromChain=' + (fromChain || 'Arc_Testnet') + ' domain=' + solDomain)
    const solRetry = RETRY_CFG[fromChain || 'Arc_Testnet'] || { maxRetries: 60, fastMode: false }
    const att = await pollAttestation(solDomain, burnTxHash, solRetry.maxRetries, solRetry.fastMode)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Please retry.' })

    res.json({
      success: true,
      requiresSolanaSign: true,
      attestation: att.attestation,
      message: att.message,
      toAddress,
      solanaConfig: {
        messageTransmitter: SOLANA_CCTP.messageTransmitterProgram,
        usdcMint: SOLANA_CCTP.usdcMint,
      },
    })
  } catch(e) { console.error('[mint-cctp-solana]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP dari Solana → Arc (backend sign di Arc) ──
app.post('/api/mint-cctp-from-solana', async (req, res) => {
  if (process.env.ENABLE_SERVER_SIGNED_MINT !== 'true') {
    return res.status(403).json({ error: 'Server-signed Solana mint disabled.' })
  }
  try {
    const { burnTxHash, toAddress } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })
    const att = await pollAttestation(SOLANA_CCTP.domain, burnTxHash, 120, false)
    if (!att) return res.status(400).json({ error: 'Attestation timeout from Solana. Please retry.' })
    const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY)
    const wc = createWalletClient({ account, chain: arcTestnet, transport: http() })
    const pc = createPublicClient({ chain: arcTestnet, transport: http() })
    // Retry mint up to 3 times
    let txHash
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log(`[mint-from-solana] attempt ${attempt+1}/3`)
        txHash = await wc.writeContract({
          address: CCTP.Arc_Testnet.messageTransmitter,
          abi: RECEIVE_MESSAGE_ABI,
          functionName: 'receiveMessage',
          args: [att.message, att.attestation],
        })
        await pc.waitForTransactionReceipt({ hash: txHash })
        break
      } catch(e) {
        console.error(`[mint-from-solana] attempt ${attempt+1} failed:`, e.message)
        if (attempt === 2) throw e
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    res.json({ success: true, txHash, explorerUrl: CCTP.Arc_Testnet.explorer + txHash })
  } catch(e) { console.error('[mint-from-solana]', e.message); res.status(500).json({ error: e.message }) }
})


// ── Mint Direct (fallback manual receiveMessage) - EVM → EVM tanpa AppKit ──
app.post('/api/mint-direct', async (req, res) => {
  if (process.env.ENABLE_SERVER_SIGNED_MINT !== 'true') {
    return res.status(403).json({ error: 'Server-signed mint disabled. Use wallet-signed retry mint.' })
  }
  try {
    const { burnTxHash, fromChain, toChain, toAddress, amount: reqAmount } = req.body
    if (!burnTxHash || !fromChain || !toChain) return res.status(400).json({ error: 'Missing params' })

    const fromInfo = CCTP[fromChain]
    if (!fromInfo) return res.status(400).json({ error: 'Unknown fromChain: ' + fromChain })
    const toInfo = CCTP[toChain]
    if (!toInfo) return res.status(400).json({ error: 'Unknown toChain: ' + toChain })

    // 1. Poll attestation
    const dirRetry = RETRY_CFG[fromChain] || { maxRetries: 120, fastMode: false }
    console.log('[mint-direct] polling attestation domain=' + fromInfo.domain + ' from=' + fromChain + ' to=' + toChain + ' retries=' + dirRetry.maxRetries)
    const att = await pollAttestation(fromInfo.domain, burnTxHash, dirRetry.maxRetries, dirRetry.fastMode)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Please retry.' })

    // 2. receiveMessage via backend viem wallet
    const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY)
    const RPC_BY_CHAIN_ID = {}
    for (const [, cfg] of Object.entries(CCTP)) {
      if (cfg.chain) RPC_BY_CHAIN_ID[cfg.chain.id] = cfg.chain.rpcUrls.default.http[0]
    }
    const rpcUrl = RPC_BY_CHAIN_ID[toInfo.chain.id]
    if (!rpcUrl) return res.status(500).json({ error: 'No RPC for destination chain ID: ' + toInfo.chain.id })
    const wc = createWalletClient({ account, chain: toInfo.chain, transport: http(rpcUrl) })
    const pc = createPublicClient({ chain: toInfo.chain, transport: http(rpcUrl) })

    // 3. Send receiveMessage with retry
    let txHash
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.log('[mint-direct] attempt ' + (attempt+1) + '/3')
        txHash = await wc.writeContract({
          address: toInfo.messageTransmitter,
          abi: RECEIVE_MESSAGE_ABI,
          functionName: 'receiveMessage',
          args: [att.message, att.attestation],
        })
        await pc.waitForTransactionReceipt({ hash: txHash })
        break
      } catch(e) {
        console.error('[mint-direct] attempt ' + (attempt+1) + ' failed:', e.message)
        if (attempt === 2) throw e
        await new Promise(r => setTimeout(r, 3000))
      }
    }
    res.json({ success: true, txHash, explorerUrl: toInfo.explorer + txHash })
  } catch(e) { console.error('[mint-direct]', e.message); res.status(500).json({ error: e.message }) }
})
// ── Send ──
app.post('/api/send-estimate', requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, toAddress, amount, token, source } = req.body
    if (!metamaskAddress || !toAddress || !amount || !token) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const destination = normalizeAddress(toAddress, 'toAddress')
    const safeAmount = normalizeAmount(amount)
    if (source === 'eoa') return res.status(400).json({ error: 'EOA estimate dihitung langsung dari wallet browser.' })
    const resolvedToken = SEND_TOKEN_MAP[token] || token
    const wallet = await getOrCreateWallet(owner)
    const params = {
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      to: destination,
      amount: safeAmount,
      token: resolvedToken,
    }
    const estimate = await kit.estimateSend(params)
    const fee = estimate?.fee || estimate?.estimatedFee || estimate?.gasFee || estimate?.totalFee || ''
    res.json({
      success: true,
      fee: typeof fee === 'object' ? fee.amount : String(fee || '-'),
      token: typeof fee === 'object' ? (fee.token || 'USDC') : 'USDC',
      detail: estimate?.gas ? `${estimate.gas} gas` : 'App Kit estimate',
      estimate,
    })
  } catch(e) { console.error('[send-estimate]', e.message); res.status(500).json({ error: e.message }) }
})

app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { metamaskAddress, toAddress, amount, token, source } = req.body
    if (!metamaskAddress || !toAddress || !amount || !token) return res.status(400).json({ error: 'Missing params' })
    const owner = normalizeAddress(metamaskAddress, 'metamaskAddress')
    const destination = normalizeAddress(toAddress, 'toAddress')
    const safeAmount = normalizeAmount(amount)
    const resolvedToken = SEND_TOKEN_MAP[token] || token
    if (source === 'eoa') {
      return res.status(400).json({ error: 'EOA send harus ditandatangani langsung dari wallet browser.' })
    }
    const wallet = await getOrCreateWallet(owner)
    const fromCtx = { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address }
    const result = await kit.send({ from: fromCtx, to: destination, amount: safeAmount, token: resolvedToken })
    res.json({ success: true, result })
  } catch(e) { console.error('[send]', e.message); res.status(500).json({ error: e.message }) }
})

// ── History ──
app.get('/api/history/:address', async (req, res) => {
  try {
    const r = await fetch(`https://testnet.arcscan.app/api/v2/addresses/${req.params.address}/transactions?filter=to%7Cfrom&limit=10`)
    const data = await r.json()
    const txs = (data.items || []).slice(0, 10).map(tx => ({ hash: tx.hash, method: tx.method || 'transfer', from: tx.from?.hash, to: tx.to?.hash, timestamp: tx.timestamp, status: tx.status }))
    res.json({ txs })
  } catch { res.json({ txs: [] }) }
})

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════╗`)
  console.log(`║  Arc DEX API v2.0 :${PORT}        ║`)
  console.log(`║  EVM Bridge + Solana CCTP      ║`)
  console.log(`╚════════════════════════════════╝\n`)
  console.log('Routes: health, wallet, balance, quote, swap, prepare-bridge,')
  console.log('        get-attestation, mint-cctp-solana, mint-cctp-from-solana, send, history')
})
