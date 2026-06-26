import { Router } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
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
  markPaymentStatus,
  normalizeOwner,
  normalizeUsdc,
  publicApiKey,
  revokeApiKey,
  setPolicy,
  treasuryAddress,
  usageForOwner,
} from '../services/aiRouterStore.mjs'
import { callChatCompletionWithFallback, publicModels } from '../services/aiProviderService.mjs'
import { delegateConfig, spendDelegatedAiPayment } from '../services/aiRouterSpendService.mjs'

const router = Router()

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
  if (!policy.enabled) return paymentRequired(res, 'Enable Auto Pay first', `Enable Auto Pay for API key owner ${shortAddress(owner)} before calling AI models. If the web UI is already ready, create/copy a fresh API key from that same connected wallet.`)
  if ((policy.delegateStatus || 'not_configured') !== 'ready') return paymentRequired(res, 'Enable Auto Pay first', `Auto Pay is not ready for API key owner ${shortAddress(owner)}.`)
  if (!delegateConfig().enabled || !delegateConfig().delegateAddress) return paymentRequired(res, 'Enable Auto Pay first', 'Backend Auto Pay wallet is not configured.')
  if (compareUsdc(cost, policy.maxPerRequest) > 0) return paymentRequired(res, 'Auto Pay limit reached', 'Request cost exceeds max per request limit.')

  const started = Date.now()
  const payment = createPaymentIntent({ ownerAddress: owner, amount: cost, requestId, model: req.body?.model || 'arcox/auto' })
  try {
    markPaymentStatus(payment.id, 'estimate_ready')
    const spend = await spendDelegatedAiPayment({ sourceAccount: owner, amount: cost })
    markPaymentSettled(payment.id, { txHash: spend.txHash, transferId: spend.transferId, estimate: spend.estimate })
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
      txHash: spend.txHash,
      fallbackCount: meta.fallbackCount,
      status: 'success',
      latency: meta.latency || Date.now() - started,
    })
    res.json({
      ...data,
      arcox: {
        paidFrom: 'delegated_unified_balance',
        cost,
        requestId,
        paymentId: payment.id,
        paymentStatus: 'paid',
        txHash: spend.txHash,
        transferId: spend.transferId,
        usageLog: log,
        providerUsed: meta.providerUsed,
        fallbackCount: meta.fallbackCount,
      },
    })
  } catch (error) {
    const meta = error?.providerMeta || {}
    const message = error?.message || 'provider failed'
    if (/insufficient/i.test(message)) return paymentRequired(res, 'Please deposit more USDC to Unified Balance', message)
    if (/delegate|auto pay/i.test(message)) return paymentRequired(res, 'Enable Auto Pay first', message.replace(/delegate/gi, 'Auto Pay'))
    markPaymentStatus(payment.id, 'failed', { error: message })
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
      error: message,
    })
    res.status(error?.status || 502).json({ error: { message, type: 'provider_error' } })
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

function shortAddress(address) {
  const value = String(address || '')
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value || 'unknown'
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
      action: 'Deposit USDC to Unified Balance and enable Auto Pay.',
    },
  })
}

function docs() {
  return {
    base_url: process.env.AI_ROUTER_PUBLIC_BASE_URL || 'https://arc-dex-bice.vercel.app/v1',
    api_key: 'arx_sk_...',
    model: 'arcox/auto',
    setup: [
      'Connect wallet in ARCOX DEX.',
      'Deposit USDC to Unified Balance.',
      'Turn Auto Pay ON.',
      'Create API Key.',
      'Use the key in Hermes/OpenClaw/OpenAI-compatible clients.',
    ],
  }
}

export default router
