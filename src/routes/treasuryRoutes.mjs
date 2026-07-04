import { Router } from 'express'
import { randomUUID } from 'crypto'
import { solanaTreasuryAddress, treasuryAddress } from '../config/treasury.mjs'

const router = Router()
const ledger = globalThis.__arcoxTreasuryLedger || { deposits: [], spends: [], settlements: [] }
globalThis.__arcoxTreasuryLedger = ledger

function cfg() {
  return {
    mode: process.env.TREASURY_MODE || 'unified_balance',
    unifiedBalance: String(process.env.ENABLE_UNIFIED_BALANCE || 'true').toLowerCase() === 'true',
    network: 'arc-testnet',
    chainId: Number(process.env.ARC_CHAIN_ID || 5042002),
    asset: 'USDC',
    decimals: 6,
    treasuryWallet: treasuryAddress(),
    solanaTreasuryWallet: solanaTreasuryAddress(),
    destinationWallet: process.env.DESTINATION_WALLET_ADDRESS || '',
    feeRouter: process.env.ARCOX_FEE_ROUTER_ADDRESS || '',
    feeRecipient: process.env.ARCOX_FEE_RECIPIENT || '',
    feeBps: Math.min(Number(process.env.ARCOX_FEE_BPS || 50), 500),
    maxFeeBps: 500,
    label: 'real testnet - Unified Balance is a USDC routing layer, not a third wallet.',
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
    mode: 'real-testnet-estimate',
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
  const rec = { id: `settle_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: 'testnet-ledger', status: 'settlement_pending', ...req.body }
  ledger.settlements.push(rec)
  res.json({ ok: true, settlement: rec, config: cfg() })
})

router.post('/unified-balance/deposit', requireDevTools, (req, res) => {
  const rec = { id: `ub_dep_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: 'real-testnet-intent', asset: 'USDC', status: 'awaiting_signature', ...req.body }
  ledger.deposits.push(rec)
  res.json({ ok: true, deposit: rec, note: 'Use Circle AppKit deposit/spend in the frontend wallet session; backend records intent only.' })
})

router.post('/unified-balance/estimate-spend', (req, res) => {
  const amount = Number(req.body?.amount || 0)
  const recipient = String(req.body?.recipient || cfg().treasuryWallet || '').trim()
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be greater than 0' })
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return res.status(400).json({ error: 'recipient must be a valid Arc EVM address' })
  res.json({
    ok: true,
    mode: 'real-testnet-estimate',
    method: 'unified-balance-gateway',
    token: 'USDC',
    amount: amount.toFixed(6),
    destinationChain: 'Arc_Testnet',
    recipient,
    validation: {
      estimateSpendRequired: true,
      delegateMustBeReady: true,
      doNotMarkPaidBeforeSettlement: true,
    },
  })
})

router.post('/unified-balance/spend', requireDevTools, (req, res) => {
  const rec = { id: `ub_spend_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: 'real-testnet-ledger', asset: 'USDC', status: 'settlement_pending', ...req.body }
  ledger.spends.push(rec)
  res.json({ ok: true, spend: rec, note: 'Spend submitted. Wait for on-chain transfer or Circle webhook before marking paid.' })
})

export default router
