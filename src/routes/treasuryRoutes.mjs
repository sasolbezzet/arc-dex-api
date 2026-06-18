import { Router } from 'express'
import { randomUUID } from 'crypto'

const router = Router()
const ledger = globalThis.__arcoxTreasuryLedger || { deposits: [], spends: [], settlements: [] }
globalThis.__arcoxTreasuryLedger = ledger

function cfg() {
  return {
    mode: process.env.TREASURY_MODE || 'unified_balance',
    unifiedBalance: String(process.env.ENABLE_UNIFIED_BALANCE || 'true').toLowerCase() === 'true',
    treasuryWallet: process.env.ARCOX_TREASURY_WALLET_ADDRESS || process.env.ARCOX_TREASURY_WALLET || '',
    destinationWallet: process.env.DESTINATION_WALLET_ADDRESS || '',
    feeRouter: process.env.ARCOX_FEE_ROUTER_ADDRESS || '',
    feeRecipient: process.env.ARCOX_FEE_RECIPIENT || '',
    feeBps: Math.min(Number(process.env.ARCOX_FEE_BPS || 50), 500),
    maxFeeBps: 500,
    label: 'mock/testnet - Unified Balance is a USDC routing layer, not a third wallet.',
  }
}

router.get('/status', (_req, res) => {
  res.json({ ok: true, ...cfg(), balances: { USDC: 'mock' }, ledgerCounts: { deposits: ledger.deposits.length, spends: ledger.spends.length, settlements: ledger.settlements.length } })
})

router.post('/quote-settlement', (req, res) => {
  const amount = Number(req.body?.amount || 0)
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be greater than 0' })
  const config = cfg()
  const fee = amount * config.feeBps / 10_000
  res.json({ ok: true, mode: 'mock', sourceToken: req.body?.sourceToken || 'USDC', destinationToken: req.body?.destinationToken || 'USDC', amount: String(amount), fee: fee.toFixed(6), netAmount: (amount - fee).toFixed(6), ...config })
})

router.post('/simulate-settlement', (req, res) => {
  const rec = { id: `settle_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: 'mock', ...req.body }
  ledger.settlements.push(rec)
  res.json({ ok: true, settlement: rec, config: cfg() })
})

router.post('/unified-balance/deposit', (req, res) => {
  const rec = { id: `ub_dep_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: 'mock', asset: 'USDC', ...req.body }
  ledger.deposits.push(rec)
  res.json({ ok: true, deposit: rec, note: 'Mock/testnet Unified Balance deposit recorded.' })
})

router.post('/unified-balance/spend', (req, res) => {
  const rec = { id: `ub_spend_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), mode: 'mock', asset: 'USDC', ...req.body }
  ledger.spends.push(rec)
  res.json({ ok: true, spend: rec, note: 'Mock/testnet Unified Balance spend recorded.' })
})

export default router
