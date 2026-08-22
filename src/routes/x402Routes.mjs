import { Router } from 'express'
import {
  assertX402TreasuryHealthy,
  createX402Invoice,
  estimateUnifiedBalanceX402,
  getX402Invoice,
  getX402Stats,
  markUnifiedBalanceSpendSubmitted,
  publicInvoice,
  reconcileX402Invoice,
  x402Config,
  x402TreasuryHealth,
} from '../middleware/x402Middleware.mjs'
import { verifyAgentOwnership } from '../services/agentIdentityService.mjs'
import { verifyOwnerToken } from '../services/authToken.mjs'
import {
  executeRefund,
  listApprovedRefunds,
  markRefundCompleted,
  scanRefundEligibleInvoices,
  getRefundLog,
} from '../services/x402RefundWorker.mjs'
import { x402OpenApiSpec } from '../services/x402OpenApi.mjs'

const router = Router()

async function authenticatedOwner(req) {
  const auth = String(req.headers.authorization || '')
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  let owner = verifyOwnerToken(token)
  if (!owner && token.startsWith('arx_vs_')) {
    const { validateSession } = await import('../services/vaultStore.mjs')
    owner = validateSession(token)
  }
  if (!owner) return null
  const { getSessionKeyInfo } = await import('../services/vaultStore.mjs')
  const session = await getSessionKeyInfo(owner)
  return session?.active ? { owner, walletAddress: String(session.walletAddress).toLowerCase() } : null
}

async function createInvoiceForOwner(req, res, body) {
  const resource = String(body.resource || '').trim()
  if (!resource.startsWith('/api/')) return res.status(400).json({ error: 'resource must be an /api/... path' })
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  if (body.ownerWallet && String(body.ownerWallet).toLowerCase() !== authOwner.walletAddress) return res.status(403).json({ error: 'ownerWallet must match authenticated MSCA' })
  if (body.agentId && !await verifyAgentOwnership(body.agentId, authOwner.walletAddress)) return res.status(403).json({ error: 'Agent identity mismatch' })
  const treasury = await assertX402TreasuryHealthy()
  if (!treasury.ok) return res.status(503).json({ error: 'x402 treasury balance is too low; payments are temporarily paused', treasury: treasury.health })
  let invoice
  try {
    invoice = createX402Invoice({
      service: body.service || 'arcox_intel',
      amount: body.amount,
      resource,
      agentId: body.agentId,
      ownerWallet: authOwner.walletAddress,
    })
  } catch (error) {
    return res.status(error.statusCode || 429).json({ error: error.message })
  }
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice), config: publicConfig() })
}

router.post('/invoices/create', async (req, res) => {
  await createInvoiceForOwner(req, res, req.body || {})
})

router.get('/invoices/:invoiceId/status', async (req, res) => {
  const invoice = await reconcileX402Invoice(req.params.invoiceId)
  if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.post('/payment-request', async (req, res) => {
  await createInvoiceForOwner(req, res, req.body || {})
})

router.get('/payment-request/:paymentId', async (req, res) => {
  const invoice = await reconcileX402Invoice(req.params.paymentId)
  if (!invoice) return res.status(404).json({ error: 'x402 payment request not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.post('/verify', (_req, res) => {
  res.status(410).json({
    ok: false,
    error: 'Manual x402 txHash verification is disabled. Pay with a direct MSCA USDC transfer or Unified Balance and wait for on-chain/webhook reconciliation.',
  })
})

router.post('/invoices/:invoiceId/estimate-unified-balance', (req, res) => {
  try {
    const invoice = estimateUnifiedBalanceX402(req.params.invoiceId, req.body || {})
    if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
    res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Unified Balance estimate failed' })
  }
})

router.post('/invoices/:invoiceId/spend-submitted', (req, res) => {
  const invoice = markUnifiedBalanceSpendSubmitted(req.params.invoiceId, req.body || {})
  if (!invoice) return res.status(404).json({ error: 'x402 invoice not found' })
  res.json({ ok: true, x402: publicInvoice(invoice), invoice: publicInvoice(invoice) })
})

router.get('/config', (_req, res) => {
  res.json({ ok: true, config: publicConfig() })
})

// ── OpenAPI spec for x402 + intel routes (free, machine-readable) ──
router.get('/openapi.json', (_req, res) => {
  res.type('application/json').json(x402OpenApiSpec())
})

// ── Analytics ──
// Owner-gated usage analytics: revenue, invoices by status, usage per
// service, provider errors, and refund pipeline state.
router.get('/stats', async (req, res) => {
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  res.json({ ok: true, stats: getX402Stats() })
})

// ── Treasury health ──
router.get('/treasury-health', async (_req, res) => {
  const health = await x402TreasuryHealth({ force: true })
  res.json({ ok: true, ...health })
})

// ── Refund management ──
// The auto-refund worker approves eligible invoices after a cooldown and
// executes the USDC refund back to the payer through the treasury Unified
// Balance spend path. These endpoints expose the pipeline state and allow
// manual overrides for a treasury operator.

router.get('/refunds/approved', (_req, res) => {
  res.json({ ok: true, refunds: listApprovedRefunds() })
})

router.get('/refunds/log', (_req, res) => {
  res.json({ ok: true, log: getRefundLog() })
})

router.post('/refunds/scan', (_req, res) => {
  const approved = scanRefundEligibleInvoices()
  res.json({ ok: true, approved, count: approved.length })
})

// Execute an approved refund immediately (spend from treasury Unified
// Balance back to the payer). Same path the worker uses.
router.post('/refunds/:invoiceId/execute', async (req, res) => {
  const authOwner = await authenticatedOwner(req)
  if (!authOwner) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const result = await executeRefund(req.params.invoiceId)
  if (result.ok) {
    const invoice = getX402Invoice(req.params.invoiceId)
    res.json({ ok: true, refund: invoice ? publicInvoice(invoice) : null, ...result })
  } else {
    res.status(result.reason === 'invoice_not_found' ? 404 : 409).json({ ok: false, ...result })
  }
})

router.post('/refunds/:invoiceId/complete', (req, res) => {
  const txHash = String(req.body?.txHash || '').trim()
  if (!txHash) return res.status(400).json({ error: 'txHash is required' })
  const invoice = markRefundCompleted(req.params.invoiceId, txHash)
  if (!invoice) return res.status(404).json({ error: 'Refund-eligible invoice not found' })
  res.json({ ok: true, refund: invoice })
})

function publicConfig() {
  const cfg = x402Config()
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    asset: cfg.asset,
    network: cfg.network,
    chainId: cfg.chainId,
    usdcAddress: cfg.usdcAddress,
    circleEnvironment: cfg.circleEnvironment,
    circleBaseUrl: cfg.circleBaseUrl,
    circleTreasuryWalletId: cfg.circleTreasuryWalletId,
    recipient: cfg.circleTreasuryAddress,
    paymentMethod: 'arc-usdc-direct',
    paymentMethods: ['arc-usdc-direct', 'unified-balance-gateway'],
    baseAmount: cfg.baseAmount,
    expiresInSeconds: cfg.ttlSeconds,
    abuseLimits: {
      maxUnpaidPerOwner: Number(process.env.X402_MAX_UNPAID_PER_OWNER || 10),
      invoiceCooldownMs: Number(process.env.X402_INVOICE_COOLDOWN_MS || 0),
    },
    refunds: {
      executeEnabled: String(process.env.X402_REFUND_EXECUTE_ENABLED || 'true').toLowerCase() === 'true',
      dailyCapUsdc: Number(process.env.X402_REFUND_DAILY_CAP_USDC || 25),
      maxAutoRefundUsdc: Number(process.env.X402_MAX_AUTO_REFUND_USDC || 1.0),
    },
    treasury: {
      minUsdc: Number(process.env.X402_MIN_TREASURY_USDC || 2.0),
      blockOnLow: String(process.env.X402_BLOCK_ON_LOW_TREASURY || 'true').toLowerCase() === 'true',
    },
  }
}

export default router
