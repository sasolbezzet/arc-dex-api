import 'dotenv/config'
import express from 'express'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { AppKit, SwapChain } from '@circle-fin/app-kit'
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'

process.on('uncaughtException', (err) => console.error('[UncaughtException]', err.message))
process.on('unhandledRejection', (reason) => console.error('[UnhandledRejection]', reason?.message || reason))
BigInt.prototype.toJSON = function() { return this.toString() }

const app = express()
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})
app.use(express.json())

const KIT_KEY = process.env.KIT_KEY
const PORT = process.env.PORT || 3001
const WALLET_DB = './wallets-db.json'

const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network/'] } },
  blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
})

const TOKENS = {
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
}

const SOLANA_CCTP = {
  domain: 1,
  usdcMint: 'G247gygHjYkwn9wECFrzzfuJxyDYpGXt9xFP6Q3FVSr5',
  tokenMessengerProgram: 'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3',
  rpc: process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com',
  explorer: 'https://explorer.solana.com/tx/',
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ name: 'success', type: 'bool' }],
  stateMutability: 'nonpayable'
}]

const circleClient = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const circleAdapter = createCircleWalletsAdapter({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const kit = new AppKit()

function loadWallets() {
  try { return existsSync(WALLET_DB) ? JSON.parse(readFileSync(WALLET_DB, 'utf-8')) : {} }
  catch { return {} }
}
function saveWallets(db) { writeFileSync(WALLET_DB, JSON.stringify(db, null, 2)) }

async function getOrCreateWallet(metamaskAddr) {
  const addr = metamaskAddr.toLowerCase()
  const db = loadWallets()
  if (db[addr]) {
    const res = await circleClient.getWallet({ id: db[addr] })
    return res.data?.wallet
  }
  const ws = await circleClient.createWalletSet({ name: `user-${addr.slice(0,8)}` })
  const wr = await circleClient.createWallets({
    blockchains: ['ARC-TESTNET'], count: 1,
    walletSetId: ws.data?.walletSet?.id ?? '', accountType: 'SCA',
  })
  const wallet = wr.data?.wallets?.[0]
  db[addr] = wallet.id
  saveWallets(db)
  console.log(`[wallet] new: ${addr} → ${wallet.address}`)
  return wallet
}

async function pollAttestation(domain, txHash, maxRetries = 20) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${txHash}`
  console.log(`[iris] polling: ${url}`)
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!r.ok) { console.log(`[iris] HTTP ${r.status}`); continue }
      const ct = r.headers.get('content-type') || ''
      if (!ct.includes('json')) { console.log('[iris] non-JSON response'); continue }
      const data = await r.json()
      const msg = data?.messages?.[0]
      console.log(`[iris] attempt ${i+1}/${maxRetries}: ${msg?.status}`)
      if (msg?.status === 'complete' && msg.attestation && msg.message) {
        return { attestation: msg.attestation, message: msg.message }
      }
    } catch(e) { console.log(`[iris] error: ${e.message}`) }
  }
  return null
}

// ── Health ──
app.get('/health', (_, res) => res.json({ ok: true, time: new Date(), version: '2.0.0' }))

// ── Wallet ──
app.post('/api/wallet', async (req, res) => {
  try {
    const { metamaskAddress } = req.body
    if (!metamaskAddress) return res.status(400).json({ error: 'Missing metamaskAddress' })
    const w = await getOrCreateWallet(metamaskAddress)
    res.json({ success: true, wallet: { id: w.id, address: w.address } })
  } catch(e) { console.error('[wallet]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Balance ──
app.get('/api/balance/:address', async (req, res) => {
  try {
    const client = createPublicClient({ chain: arcTestnet, transport: http() })
    const result = {}
    for (const [sym, addr] of Object.entries(TOKENS)) {
      try {
        const bal = await client.readContract({ address: addr, abi: erc20Abi, functionName: 'balanceOf', args: [req.params.address] })
        result[sym] = formatUnits(bal, 6)
      } catch { result[sym] = '0' }
    }
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Quote ──
app.post('/api/quote', async (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn } = req.body
    const rates = { 'USDC-EURC': 0.92, 'EURC-USDC': 1.085 }
    const rate = rates[`${tokenIn}-${tokenOut}`] || 1.0
    res.json({ amountOut: (parseFloat(amountIn) * rate).toFixed(4), fee: (parseFloat(amountIn) * 0.0002).toFixed(6), rate })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Swap ──
app.post('/api/swap', async (req, res) => {
  try {
    const { metamaskAddress, tokenIn, tokenOut, amountIn } = req.body
    if (!metamaskAddress || !tokenIn || !tokenOut || !amountIn) return res.status(400).json({ error: 'Missing params' })
    const wallet = await getOrCreateWallet(metamaskAddress)
    const result = await kit.swap({
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      tokenIn, tokenOut, amountIn,
      config: { kitKey: KIT_KEY, allowanceStrategy: 'approve' },
    })
    res.json({ success: true, result })
  } catch(e) { console.error('[swap]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Prepare Bridge (Circle → EOA) ──
app.post('/api/prepare-bridge', async (req, res) => {
  try {
    const { metamaskAddress, amount } = req.body
    if (!metamaskAddress || !amount) return res.status(400).json({ error: 'Missing params' })
    const wallet = await getOrCreateWallet(metamaskAddress)
    const result = await kit.send({
      from: { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address },
      to: metamaskAddress, amount, token: 'USDC',
    })
    res.json({ success: true, txHash: result.txHash, explorerUrl: result.explorerUrl })
  } catch(e) { console.error('[prepare-bridge]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Get Attestation - fast via App Kit ──
app.post('/api/get-attestation', async (req, res) => {
  try {
    const { txHash, fromChain } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3, Solana_Devnet: 1 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain: ' + fromChain })
    console.log(`[get-attestation] domain=${domain} tx=${txHash}`)
    // Fast attestation - poll dengan interval lebih pendek
    const att = await pollAttestation(domain, txHash, 60)
    if (!att) return res.status(400).json({ error: 'Attestation timeout.' })
    res.json({ success: true, attestation: att.attestation, message: att.message, domain })
  } catch(e) { console.error('[get-attestation]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint via App Kit (EVM chains) - lebih reliable dari manual receiveMessage ──
app.post('/api/mint-via-appkit', async (req, res) => {
  try {
    const { burnTxHash, fromChain, toChain, toAddress } = req.body
    if (!burnTxHash || !fromChain || !toChain) return res.status(400).json({ error: 'Missing params' })

    const viemAdapter = createViemAdapterFromPrivateKey({ privateKey: process.env.OWNER_PRIVATE_KEY })
    
    // Reconstruct bridge result untuk retry
    const partialResult = {
      state: 'error',
      amount: '0',
      token: 'USDC',
      source: { 
        address: process.env.OWNER_PRIVATE_KEY ? (await import('viem/accounts')).then(m => m.privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address) : toAddress,
        chain: fromChain 
      },
      destination: { address: toAddress, chain: toChain },
      steps: [
        { name: 'approve', state: 'success' },
        { name: 'burn', state: 'success', txHash: burnTxHash },
        { name: 'fetchAttestation', state: 'error', error: 'Resuming from frontend burn' },
      ],
    }

    console.log(`[mint-via-appkit] retrying from burn tx ${burnTxHash}`)
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

// ── Mint CCTP Solana (Arc → Solana) - return attestation untuk Solflare sign ──
app.post('/api/mint-cctp-solana', async (req, res) => {
  try {
    const { burnTxHash, toAddress } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })
    const att = await pollAttestation(26, burnTxHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout.' })
    res.json({
      success: true,
      requiresSolanaSign: true,
      attestation: att.attestation,
      message: att.message,
      toAddress,
      solanaConfig: {
        messageTransmitter: 'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3',
        usdcMint: SOLANA_CCTP.usdcMint,
      },
    })
  } catch(e) { console.error('[mint-cctp-solana]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP dari Solana → Arc (backend sign di Arc) ──
app.post('/api/mint-cctp-from-solana', async (req, res) => {
  try {
    const { burnTxHash, toAddress } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })
    const att = await pollAttestation(1, burnTxHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout.' })
    const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY)
    const wc = createWalletClient({ account, chain: arcTestnet, transport: http() })
    const pc = createPublicClient({ chain: arcTestnet, transport: http() })
    const txHash = await wc.writeContract({
      address: CCTP.Arc_Testnet.messageTransmitter,
      abi: RECEIVE_MESSAGE_ABI,
      functionName: 'receiveMessage',
      args: [att.message, att.attestation],
    })
    await pc.waitForTransactionReceipt({ hash: txHash })
    res.json({ success: true, txHash, explorerUrl: CCTP.Arc_Testnet.explorer + txHash })
  } catch(e) { console.error('[mint-from-solana]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Send ──
app.post('/api/send', async (req, res) => {
  try {
    const { metamaskAddress, toAddress, amount, token, source } = req.body
    if (!metamaskAddress || !toAddress || !amount || !token) return res.status(400).json({ error: 'Missing params' })
    const resolvedToken = SEND_TOKEN_MAP[token] || token
    let fromCtx
    if (source === 'eoa') {
      const viemAdapter = createViemAdapterFromPrivateKey({ privateKey: process.env.OWNER_PRIVATE_KEY })
      fromCtx = { adapter: viemAdapter, chain: SwapChain.Arc_Testnet }
    } else {
      const wallet = await getOrCreateWallet(metamaskAddress)
      fromCtx = { adapter: circleAdapter, chain: SwapChain.Arc_Testnet, address: wallet.address }
    }
    const result = await kit.send({ from: fromCtx, to: toAddress, amount, token: resolvedToken })
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
