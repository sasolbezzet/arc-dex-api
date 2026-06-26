import { Router } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { createPublicClient, decodeEventLog, getAddress, http, parseAbiItem } from 'viem'
import {
  addUsageLog,
  compareUsdc,
  createPaymentIntent,
  findApiKey,
  getAiRouterStatus,
  getPolicy,
  issueApiKey,
  listApiKeys,
  markPaymentSettled,
  normalizeOwner,
  normalizeUsdc,
  publicApiKey,
  refundCredit,
  reserveCredit,
  revokeApiKey,
  setPolicy,
  spendToday,
  toUnits,
  treasuryAddress,
  usageForOwner,
  aiRouterState,
} from '../services/aiRouterStore.mjs'
import { callChatCompletionWithFallback, publicModels } from '../services/aiProviderService.mjs'

const router = Router()
const transferEvent = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const ARC_USDC = process.env.X402_USDC_ADDRESS || '0x3600000000000000000000000000000000000000'

router.get('/status', (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  res.json({ ok: true, ...getAiRouterStatus(ownerAddress), treasury: treasuryAddress(), docs: docs() })
})

router.post('/auto-pay', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  res.json({ ok: true, autoPay: setPolicy(ownerAddress, req.body || {}) })
})

router.get('/api-keys', (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  res.json({ ok: true, apiKeys: listApiKeys(ownerAddress) })
})

router.post('/api-keys', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  const issued = issueApiKey({
    ownerAddress,
    label: req.body?.label || 'ARCOX AI Router',
    scopes: req.body?.scopes || ['ai:chat', 'ai:models'],
  })
  res.json({
    ok: true,
    apiKey: issued.apiKey,
    key: issued.record,
    warning: 'Copy this key now. ARCOX stores only the hash and cannot show it again.',
  })
})

router.post('/api-keys/:id/revoke', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const key = revokeApiKey(req.params.id, ownerAddress)
  if (!key) return res.status(404).json({ error: 'API key not found' })
  res.json({ ok: true, key })
})

router.post('/api-keys/:id/rotate', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const oldKey = revokeApiKey(req.params.id, ownerAddress)
  if (!oldKey) return res.status(404).json({ error: 'API key not found' })
  const issued = issueApiKey({ ownerAddress, label: `${oldKey.label || 'ARCOX AI Router'} rotated`, scopes: oldKey.scopes })
  res.json({ ok: true, revoked: oldKey, apiKey: issued.apiKey, key: issued.record })
})

router.get('/models', (_req, res) => {
  res.json({ ok: true, data: publicModels(), object: 'list' })
})

router.get('/usage', (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  const limit = Number(req.query.limit || 25)
  res.json({ ok: true, usageLogs: usageForOwner(ownerAddress, limit) })
})

router.post('/payments/prepare', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const amount = normalizeUsdc(req.body?.amount || process.env.AI_ROUTER_TOPUP_AMOUNT_USDC || '0.10')
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  const recipient = treasuryAddress()
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) return res.status(500).json({ error: 'AI Router treasury address is not configured' })
  const payment = createPaymentIntent({ ownerAddress, amount })
  res.json({
    ok: true,
    payment,
    instruction: 'Spend this exact amount from Unified Balance to the ARCOX treasury, then submit the txHash automatically from the UI.',
  })
})

router.post('/payments/:id/settle', requireOwnerAuth, async (req, res) => {
  const payment = aiRouterState.payments[req.params.id]
  if (!payment) return res.status(404).json({ error: 'payment not found' })
  const txHash = String(req.body?.txHash || req.body?.spendTxHash || '').trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: 'valid txHash is required' })
  try {
    await verifyArcUsdcTransfer({ txHash, amount: payment.amount, recipient: payment.recipient })
    const settled = markPaymentSettled(payment.id, { txHash })
    const policy = setPolicy(payment.ownerAddress, { enabled: true, ...getPolicy(payment.ownerAddress) })
    res.json({ ok: true, payment: settled, autoPay: policy, status: getAiRouterStatus(payment.ownerAddress) })
  } catch (error) {
    payment.status = 'failed'
    payment.error = error?.message || 'payment verification failed'
    payment.updatedAt = new Date().toISOString()
    res.status(400).json({ error: payment.error, payment })
  }
})

router.get('/docs', (_req, res) => {
  res.json({ ok: true, docs: docs() })
})

export async function openAiModels(req, res) {
  const auth = authenticateAiKey(req, 'ai:models')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  res.json({ object: 'list', data: publicModels() })
}

export async function openAiChatCompletions(req, res) {
  const auth = authenticateAiKey(req, 'ai:chat')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  const requestId = `air_req_${Date.now().toString(36)}`
  const apiKey = auth.apiKey
  const owner = apiKey.ownerAddress
  const policy = getPolicy(owner)
  const cost = normalizeUsdc(req.body?.metadata?.arcox_cost || process.env.AI_ROUTER_DEFAULT_COST_USDC || '0.001')
  if (!policy.enabled) return paymentRequired(res, 'Auto Pay is off', 'Turn Auto Pay ON and fund AI Router from Unified Balance.')
  if (compareUsdc(cost, policy.maxPerRequest) > 0) return paymentRequired(res, 'Auto Pay limit reached', 'Request cost exceeds max per request limit.')
  if (compareUsdc(spendToday(owner), policy.dailyLimit) >= 0) return paymentRequired(res, 'Auto Pay limit reached', 'Daily Auto Pay limit reached.')
  const reserve = reserveCredit(owner, cost)
  if (!reserve) return paymentRequired(res, 'Please deposit more USDC to Unified Balance', 'Fund AI Router from Unified Balance before calling models.')

  const started = Date.now()
  try {
    const { data, meta } = await callChatCompletionWithFallback(req.body || {})
    const usage = data.usage || {}
    const log = addUsageLog({
      requestId,
      apiKeyId: apiKey.id,
      ownerAddress: owner,
      model: req.body?.model || 'arcox/auto',
      providerUsed: meta.providerUsed,
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      cost,
      paymentId: requestId,
      fallbackCount: meta.fallbackCount,
      status: 'success',
      latency: meta.latency || Date.now() - started,
    })
    res.json({
      ...data,
      arcox: {
        paidFrom: 'unified_balance_credit',
        cost,
        requestId,
        usageLog: log,
        providerUsed: meta.providerUsed,
        fallbackCount: meta.fallbackCount,
      },
    })
  } catch (error) {
    refundCredit(owner, cost)
    const meta = error?.providerMeta || {}
    addUsageLog({
      requestId,
      apiKeyId: apiKey.id,
      ownerAddress: owner,
      model: req.body?.model || 'arcox/auto',
      providerUsed: meta.providerUsed || '',
      cost,
      fallbackCount: meta.fallbackCount || 0,
      status: 'failed',
      latency: meta.latency || Date.now() - started,
      error: error?.message || 'provider failed',
    })
    res.status(error?.status || 502).json({ error: { message: error?.message || 'AI provider failed', type: 'provider_error' } })
  }
}

function authenticateAiKey(req, scope) {
  const header = String(req.headers.authorization || '')
  const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!secret.startsWith('arx_sk_')) return { ok: false, status: 401, body: { error: { message: 'Invalid ARCOX API key', type: 'authentication_error' } } }
  const apiKey = findApiKey(secret)
  if (!apiKey) return { ok: false, status: 401, body: { error: { message: 'Invalid ARCOX API key', type: 'authentication_error' } } }
  if (!apiKey.scopes?.includes(scope)) return { ok: false, status: 403, body: { error: { message: `Missing scope ${scope}`, type: 'permission_error' } } }
  return { ok: true, apiKey: publicApiKey(apiKey) }
}

function requireOwnerAuth(req, res, next) {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  const authAddress = verifyAuthToken(req)
  if (!authAddress || authAddress !== ownerAddress) return res.status(401).json({ error: 'Wallet authentication required for AI Router key and payment changes' })
  next()
}

function verifyAuthToken(req) {
  const secret = process.env.AUTH_SECRET || process.env.CIRCLE_ENTITY_SECRET || process.env.CIRCLE_API_KEY || ''
  if (!secret) return ''
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token.includes('.')) return ''
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return ''
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return ''
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!data?.address || !data?.exp || Date.now() > data.exp) return ''
    return normalizeOwner(data.address)
  } catch {
    return ''
  }
}

function paymentRequired(res, message, detail) {
  return res.status(402).json({
    error: {
      message,
      detail,
      type: 'payment_required',
    },
    payment: {
      method: 'unified_balance',
      asset: 'USDC',
      network: 'arc-testnet',
      action: 'Deposit USDC to Unified Balance, then fund AI Router credit from Unified Balance.',
    },
  })
}

async function verifyArcUsdcTransfer({ txHash, amount, recipient }) {
  const client = createPublicClient({ transport: http(process.env.ARC_RPC_URL || process.env.RPC || 'https://rpc.testnet.arc.network/', { timeout: 15_000, retryCount: 1 }) })
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  if (!receipt || receipt.status !== 'success') throw new Error('AI Router top-up transaction is not successful on Arc')
  const expectedRecipient = getAddress(recipient)
  const expectedAmount = BigInt(toUnits(amount))
  const found = receipt.logs.some(log => {
    if (String(log.address).toLowerCase() !== ARC_USDC.toLowerCase()) return false
    try {
      const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics })
      return getAddress(decoded.args?.to) === expectedRecipient && BigInt(decoded.args?.value || 0n) >= expectedAmount
    } catch {
      return false
    }
  })
  if (!found) throw new Error('No matching Arc ERC-20 USDC Transfer to ARCOX treasury found in tx receipt')
}

function docs() {
  return {
    base_url: process.env.AI_ROUTER_PUBLIC_BASE_URL || 'https://api.arcox.app/v1',
    api_key: 'arx_sk_...',
    model: 'arcox/auto',
    setup: [
      'Connect wallet in ARCOX DEX.',
      'Deposit USDC to Unified Balance.',
      'Fund AI Router from Unified Balance.',
      'Turn Auto Pay ON.',
      'Create API Key.',
      'Use the key in Hermes/OpenClaw/OpenAI-compatible clients.',
    ],
  }
}

export default router
