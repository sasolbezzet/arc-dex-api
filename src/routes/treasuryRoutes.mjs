import { Router } from 'express'
import { randomUUID } from 'crypto'
import { solanaTreasuryAddress, treasuryAddress } from '../config/treasury.mjs'
import { scheduleTreasuryFinancialEvent } from '../services/supabasePersistence.mjs'
import { ARC_CHAIN_ID, ARC_CHAIN_KEY, ARC_GATEWAY_KEY, ARC_NETWORK_LABEL, IS_ARC_MAINNET, arcContractAddress } from '../config/arcNetwork.mjs'

const router = Router()
// Label mode mengikuti jaringan aktif supaya respons produksi tidak lagi
// menyebut "testnet" saat backend berjalan di mainnet.
const NETWORK_MODE = IS_ARC_MAINNET ? 'mainnet' : 'testnet'
const ledger = globalThis.__arcoxTreasuryLedger || { deposits: [], spends: [], settlements: [] }
globalThis.__arcoxTreasuryLedger = ledger

function cfg() {
  return {
    mode: process.env.TREASURY_MODE || 'unified_balance',
    unifiedBalance: String(process.env.ENABLE_UNIFIED_BALANCE || 'true').toLowerCase() === 'true',
    network: ARC_CHAIN_KEY,
    chainId: Number(ARC_CHAIN_ID),
    asset: 'USDC',
    decimals: 6,
    treasuryWallet: treasuryAddress(),
    solanaTreasuryWallet: solanaTreasuryAddress(),
    destinationWallet: process.env.DESTINATION_WALLET_ADDRESS || '',
    // Mainnet hanya membaca `*_MAINNET`; testnet tetap memakai var lama.
    feeRouter: arcContractAddress('ARCOX_FEE_ROUTER_ADDRESS') || '',
    feeRecipient: process.env.ARCOX_FEE_RECIPIENT || '',
    feeBps: Math.min(Number(
      (IS_ARC_MAINNET ? process.env.ARCOX_ROUTER_FEE_BPS_MAINNET : '') ||
      process.env.ARCOX_ROUTER_FEE_BPS ||
      process.env.ARCOX_FEE_BPS ||
      30,
    ), 1_000),
    maxFeeBps: 1_000,
    label: `${ARC_NETWORK_LABEL} - Unified Balance is a USDC routing layer, not a third wallet.`,
  }
}

function requireDevTools(_req, res, next) {
  if (String(process.env.ENABLE_DEV_TOOLS || 'false').toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Not found' })
  }
  next()
}

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    ...cfg(),
    balances: {
      walletBalance: 'read_in_frontend_wallet',
      unifiedBalance: 'read_with_circle_appkit_getBalances',
    },
    supportedPaymentMethods: ['arc-usdc-memo', 'unified-balance-gateway'],
    recovery: 'If a Unified Balance spend is submitted, track transferId/txHash and retry recovery instead of asking the user to pay again.',
    ledgerCounts: { deposits: ledger.deposits.length, spends: ledger.spends.length, settlements: ledger.settlements.length },
  })
})

router.post('/quote-settlement', (req, res) => {
  const amount = Number(req.body?.amount || 0)
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be greater than 0' })
  const config = cfg()
  const fee = amount * config.feeBps / 10_000
  res.json({
    ok: true,
    mode: `real-${NETWORK_MODE}-estimate`,
    sourceToken: req.body?.sourceToken || 'USDC',
    destinationToken: req.body?.destinationToken || 'USDC',
    amount: String(amount),
    fee: fee.toFixed(6),
    netAmount: (amount - fee).toFixed(6),
    route: 'Treasury wallet -> Arc Unified Balance -> destination wallet',
    requiresFrontendSignature: true,
    ...config,
  })
})

router.post('/simulate-settlement', requireDevTools, (req, res) => {
  const rec = { id: `settle_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: `${NETWORK_MODE}-ledger`, status: 'settlement_pending', ...req.body }
  ledger.settlements.push(rec)
  scheduleTreasuryFinancialEvent({
    id: rec.id, eventType: 'settlement_intent', owner: rec.owner || rec.ownerAddress || '',
    amount: rec.amount, token: rec.asset || rec.token || 'USDC', chain: rec.chain || ARC_CHAIN_KEY,
    status: rec.status, txHash: rec.txHash || '', createdAt: rec.createdAt,
    metadata: { source: 'treasury.simulate-settlement', request: rec },
  })
  res.json({ ok: true, settlement: rec, config: cfg() })
})

router.post('/unified-balance/deposit', requireDevTools, (req, res) => {
  const rec = { id: `ub_dep_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: `real-${NETWORK_MODE}-intent`, asset: 'USDC', status: 'awaiting_signature', ...req.body }
  ledger.deposits.push(rec)
  scheduleTreasuryFinancialEvent({
    id: rec.id, eventType: 'unified_balance_deposit_intent', owner: rec.owner || rec.ownerAddress || '',
    amount: rec.amount, token: rec.asset || rec.token || 'USDC', chain: rec.chain || ARC_CHAIN_KEY,
    status: rec.status, txHash: rec.txHash || '', createdAt: rec.createdAt,
    metadata: { source: 'treasury.unified-balance.deposit', request: rec },
  })
  res.json({ ok: true, deposit: rec, note: 'Use Circle AppKit deposit/spend in the frontend wallet session; backend records intent only.' })
})

router.post('/unified-balance/estimate-spend', (req, res) => {
  const amount = Number(req.body?.amount || 0)
  const recipient = String(req.body?.recipient || cfg().treasuryWallet || '').trim()
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be greater than 0' })
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return res.status(400).json({ error: 'recipient must be a valid Arc EVM address' })
  res.json({
    ok: true,
    mode: `real-${NETWORK_MODE}-estimate`,
    method: 'unified-balance-gateway',
    token: 'USDC',
    amount: amount.toFixed(6),
    destinationChain: ARC_GATEWAY_KEY,
    recipient,
    validation: {
      estimateSpendRequired: true,
      delegateMustBeReady: true,
      doNotMarkPaidBeforeSettlement: true,
    },
  })
})

router.post('/unified-balance/spend', requireDevTools, (req, res) => {
  const rec = { id: `ub_spend_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: `real-${NETWORK_MODE}-ledger`, asset: 'USDC', status: 'settlement_pending', ...req.body }
  ledger.spends.push(rec)
  scheduleTreasuryFinancialEvent({
    id: rec.id, eventType: 'unified_balance_spend_intent', owner: rec.owner || rec.ownerAddress || '',
    amount: rec.amount, token: rec.asset || rec.token || 'USDC', chain: rec.chain || rec.destinationChain || ARC_CHAIN_KEY,
    status: rec.status, txHash: rec.txHash || '', createdAt: rec.createdAt,
    metadata: { source: 'treasury.unified-balance.spend', request: rec },
  })
  res.json({ ok: true, spend: rec, note: 'Spend submitted. Wait for on-chain transfer or Circle webhook before marking paid.' })
})

export default router
