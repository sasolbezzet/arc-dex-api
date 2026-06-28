import { Router } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import {
  addUsageLog,
  createPaymentIntent,
  findApiKey,
  getActiveAgentId,
  getAiRouterStatus,
  getPolicy,
  issueApiKey,
  listApiKeys,
  listAgentJobs,
  markPaymentSettled,
  markPaymentStatus,
  normalizeOwner,
  normalizeUsdc,
  publicApiKey,
  recordAgentJob,
  revokeApiKey,
  setPolicy,
  setActiveAgentIdentity,
  treasuryAddress,
  usageForOwner,
} from '../services/aiRouterStore.mjs'
import { callChatCompletionWithFallback, publicModels, validateChatCompletionRoute } from '../services/aiProviderService.mjs'
import { delegateConfig, estimateDelegatedAiSpend, spendDelegatedAiPayment } from '../services/aiRouterSpendService.mjs'
import { listAgentIdentities, verifyAgentOwnership } from '../services/agentIdentityService.mjs'
import { submitAgentMemoProof } from '../services/arcMemoService.mjs'
import { getGatewayDelegateStatus } from '../services/gatewayDelegateService.mjs'

const router = Router()

router.get('/status', async (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  try {
    const identity = await resolveActiveIdentity(ownerAddress)
    res.json({ ok: true, ...getAiRouterStatus(ownerAddress), agentIdentity: identity.active, agentIdentities: identity.items, treasury: treasuryAddress(), docs: docs() })
  } catch (error) {
    res.status(502).json({ error: error?.message || 'Agent Identity lookup failed' })
  }
})

router.get('/delegate-status', async (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  const delegateAddress = normalizeOwner(req.query.delegateAddress)
  const chain = String(req.query.chain || '')
  if (!/^0x[a-f0-9]{40}$/.test(ownerAddress) || !/^0x[a-f0-9]{40}$/.test(delegateAddress)) return res.status(400).json({ error: 'Valid ownerAddress and delegateAddress are required' })
  if (!['Arc_Testnet', 'Ethereum_Sepolia', 'Base_Sepolia', 'Arbitrum_Sepolia'].includes(chain)) return res.status(400).json({ error: 'Unsupported Unified Balance chain' })
  try {
    res.json({ ok: true, ...(await getGatewayDelegateStatus({ ownerAddress, delegateAddress, chain })) })
  } catch (error) {
    res.status(502).json({ error: error?.message || 'Gateway delegate status failed' })
  }
})

router.get('/agent-identities', async (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  try {
    const identity = await resolveActiveIdentity(ownerAddress, req.query.refresh === 'true')
    res.json({ ok: true, ownerAddress, identities: identity.items, activeAgentIdentity: identity.active })
  } catch (error) {
    res.status(502).json({ error: error?.message || 'Agent Identity lookup failed' })
  }
})

router.post('/agent-identities/select', requireOwnerAuth, async (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const agentId = String(req.body?.agentId || '')
  const identity = await verifyAgentOwnership(agentId, ownerAddress)
  if (!identity) return res.status(403).json({ error: 'Agent identity mismatch' })
  setActiveAgentIdentity(ownerAddress, agentId)
  res.json({ ok: true, activeAgentIdentity: identity })
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

router.post('/api-keys', requireOwnerAuth, async (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  const identity = await resolveActiveIdentity(ownerAddress)
  const requestedScopes = Array.isArray(req.body?.scopes) ? req.body.scopes : ['ai:chat', 'ai:models']
  const scopes = [...new Set([
    ...requestedScopes.filter(scope => ['ai:chat', 'ai:models'].includes(scope)),
    ...(identity.active ? ['agent:jobs'] : []),
  ])]
  const issued = issueApiKey({
    ownerAddress,
    agentId: identity.active?.agentId || '',
    label: req.body?.label || 'ARCOX AI Router',
    scopes,
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
  const issued = issueApiKey({ ownerAddress, agentId: oldKey.agentId, label: `${oldKey.label || 'ARCOX AI Router'} rotated`, scopes: oldKey.scopes })
  res.json({ ok: true, revoked: oldKey, apiKey: issued.apiKey, key: issued.record })
})

router.get('/models', (_req, res) => {
  res.json({ ok: true, data: publicModels(), object: 'list' })
})

router.get('/usage', (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  const limit = Number(req.query.limit || 5)
  res.json({ ok: true, usageLogs: usageForOwner(ownerAddress, limit) })
})

router.get('/agent-jobs', async (req, res) => {
  const auth = await authenticateAiKey(req, 'agent:jobs')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  res.json({ ok: true, agentId: auth.apiKey.agentId, jobs: listAgentJobs(auth.apiKey.ownerAddress, auth.apiKey.agentId, req.query.limit) })
})

router.post('/agent-jobs', async (req, res) => {
  const auth = await authenticateAiKey(req, 'agent:jobs')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  if (String(req.body?.agentId || auth.apiKey.agentId) !== auth.apiKey.agentId) return res.status(403).json({ error: 'Agent identity mismatch' })
  const job = recordAgentJob({
    jobId: req.body?.jobId,
    agentId: auth.apiKey.agentId,
    ownerAddress: auth.apiKey.ownerAddress,
    txHash: req.body?.txHash,
    memoId: req.body?.memoId,
    status: req.body?.status || 'created',
  })
  res.json({ ok: true, job })
})

router.get('/docs', (_req, res) => {
  res.json({ ok: true, docs: docs() })
})

export async function openAiModels(req, res) {
  const auth = await authenticateAiKey(req, 'ai:models')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  res.json({ object: 'list', data: publicModels() })
}

export async function openAiChatCompletions(req, res) {
  const auth = await authenticateAiKey(req, 'ai:chat')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  const requestId = `air_req_${Date.now().toString(36)}`
  const apiKey = auth.apiKey
  const owner = apiKey.ownerAddress
  const policy = getPolicy(owner)
  const cost = normalizeUsdc(req.body?.metadata?.arcox_cost || process.env.AI_ROUTER_DEFAULT_COST_USDC || '0.001')
  if (!policy.enabled) return paymentRequired(res, 'Enable Auto Pay first', `Enable Auto Pay for API key owner ${shortAddress(owner)} before calling AI models. If the web UI is already ready, create/copy a fresh API key from that same connected wallet.`)
  if ((policy.delegateStatus || 'not_configured') !== 'ready') return paymentRequired(res, 'Enable Auto Pay first', `Auto Pay is not ready for API key owner ${shortAddress(owner)}.`)
  if (!delegateConfig().enabled || !delegateConfig().delegateAddress) return paymentRequired(res, 'Enable Auto Pay first', 'Backend Auto Pay wallet is not configured.')
  try {
    await validateChatCompletionRoute(req.body || {})
  } catch (error) {
    return res.status(error?.status || 503).json({
      error: {
        message: error?.message || 'AI provider route is not available',
        type: error?.type || 'provider_config_error',
      },
    })
  }

  const started = Date.now()
  const payment = createPaymentIntent({ ownerAddress: owner, agentId: apiKey.agentId, amount: cost, requestId, model: req.body?.model || 'arcox/auto' })
  markPaymentStatus(payment.id, 'estimate_ready')
  let estimate
  try {
    estimate = await estimateDelegatedAiSpend({ sourceAccount: owner, amount: cost, sourceChains: readyDelegateChains(policy, owner) })
    markPaymentStatus(payment.id, 'estimate_ready', { amount: estimate.spendAmount || cost, serviceAmount: cost, totalFee: estimate.totalFee || '0' })
  } catch (error) {
    return handlePaymentFailure({ res, paymentId: payment.id, error })
  }

  let providerResult
  try {
    providerResult = await callChatCompletionWithFallback(req.body || {})
  } catch (error) {
    const meta = error?.providerMeta || {}
    const message = error?.message || 'provider failed'
    markPaymentStatus(payment.id, 'failed', { error: message, charged: false })
    addUsageLog({
      requestId,
      apiKeyId: apiKey.id,
      ownerAddress: owner,
      agentId: apiKey.agentId,
      model: req.body?.model || 'arcox/auto',
      providerUsed: meta.providerUsed || '',
      cost: '0',
      fallbackCount: meta.fallbackCount || 0,
      status: 'failed',
      latency: meta.latency || Date.now() - started,
      error: message,
    })
    return res.status(error?.status || 502).json({ error: { message, type: error?.type || 'provider_error', charged: false } })
  }

  let spend
  let memoProof = null
  try {
    spend = await spendDelegatedAiPayment({ sourceAccount: owner, amount: cost, estimate, sourceChains: readyDelegateChains(policy, owner) })
    if (apiKey.agentId && spend.txHash) {
      memoProof = await submitAgentMemoProof({
        agentId: apiKey.agentId,
        paymentId: payment.id,
        requestId,
        service: 'ai_router',
        model: req.body?.model || 'arcox/auto',
        amount: spend.chargedAmount || cost,
        treasury: treasuryAddress(),
        settlementTxHash: spend.txHash,
      }).catch(() => null)
    }
    markPaymentSettled(payment.id, { txHash: spend.txHash, transferId: spend.transferId, memoId: memoProof?.memoId, memoTxHash: memoProof?.txHash })
  } catch (error) {
    return handlePaymentFailure({ res, paymentId: payment.id, error })
  }

  const { data, meta } = providerResult
  const usage = data.usage || {}
  const log = addUsageLog({
    requestId,
    apiKeyId: apiKey.id,
    ownerAddress: owner,
    agentId: apiKey.agentId,
    model: req.body?.model || 'arcox/auto',
    providerUsed: meta.providerUsed,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    cost: spend.chargedAmount || cost,
    paymentId: payment.id,
    txHash: spend.txHash,
    memoId: memoProof?.memoId || '',
    fallbackCount: meta.fallbackCount,
    status: 'success',
    latency: meta.latency || Date.now() - started,
  })
  const body = {
    ...data,
    arcox: {
      paidFrom: 'delegated_unified_balance',
      cost: spend.chargedAmount || cost,
      serviceCost: cost,
      totalFee: spend.totalFee || '0',
      requestId,
      paymentId: payment.id,
      paymentStatus: 'paid',
      txHash: spend.txHash,
      transferId: spend.transferId,
      agentId: apiKey.agentId || null,
      memoId: memoProof?.memoId || null,
      memoTxHash: memoProof?.txHash || null,
      usageLog: log,
      providerUsed: meta.providerUsed,
      fallbackCount: meta.fallbackCount,
    },
  }
  if (req.body?.stream) return sendChatCompletionStream(res, body)
  res.json(body)
}

function handlePaymentFailure({ res, paymentId, error }) {
  const message = error?.message || 'payment failed'
  markPaymentStatus(paymentId, 'failed', { error: message, charged: false })
  if (/insufficient/i.test(message)) return paymentRequired(res, 'Please deposit more USDC to Unified Balance', message)
  if (/delegate|auto pay/i.test(message)) return paymentRequired(res, 'Enable Auto Pay first', message.replace(/delegate/gi, 'Auto Pay'))
  return res.status(error?.status || 502).json({ error: { message, type: 'payment_error', charged: false } })
}

function sendChatCompletionStream(res, data) {
  const id = data.id || `chatcmpl_${Date.now().toString(36)}`
  const created = data.created || Math.floor(Date.now() / 1000)
  const model = data.model || 'arcox/auto'
  const content = extractAssistantText(data)
  const message = data?.choices?.[0]?.message || {}
  const toolCalls = normalizeToolCalls(message.tool_calls)
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })
  if (content) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })
  }
  if (toolCalls.length) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
    })
  }
  if (message.function_call) {
    writeSse(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { function_call: message.function_call }, finish_reason: null }],
    })
  }
  writeSse(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: data.choices?.[0]?.finish_reason || (toolCalls.length ? 'tool_calls' : 'stop') }],
    usage: data.usage,
    arcox: data.arcox,
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall?.id,
    type: toolCall?.type || 'function',
    function: {
      name: toolCall?.function?.name || '',
      arguments: typeof toolCall?.function?.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall?.function?.arguments || {}),
    },
  }))
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function extractAssistantText(data) {
  const message = data?.choices?.[0]?.message || {}
  return String(message.content || message.reasoning_content || message.reasoning || data?.output_text || '')
}

async function authenticateAiKey(req, scope) {
  const header = String(req.headers.authorization || '')
  const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!secret.startsWith('arx_sk_')) return { ok: false, status: 401, body: { error: { message: 'Invalid ARCOX API key', type: 'authentication_error' } } }
  const apiKey = findApiKey(secret)
  if (!apiKey) return { ok: false, status: 401, body: { error: { message: 'Invalid ARCOX API key', type: 'authentication_error' } } }
  if (!apiKey.scopes?.includes(scope)) return { ok: false, status: 403, body: { error: { message: `Missing scope ${scope}`, type: 'permission_error' } } }
  const claimedAgentId = String(req.headers['x-arcox-agent-id'] || req.body?.metadata?.agentId || req.body?.agentId || '')
  if (claimedAgentId && claimedAgentId !== String(apiKey.agentId || '')) return { ok: false, status: 403, body: { error: { message: 'Agent identity mismatch', type: 'permission_error' } } }
  if (apiKey.agentId && !await verifyAgentOwnership(apiKey.agentId, apiKey.ownerAddress)) return { ok: false, status: 403, body: { error: { message: 'Agent identity mismatch', type: 'permission_error' } } }
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
  const secret = process.env.AUTH_SECRET || ''
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

async function resolveActiveIdentity(ownerAddress, refresh = false) {
  const items = await listAgentIdentities(ownerAddress, { refresh })
  let activeId = getActiveAgentId(ownerAddress)
  let active = items.find(item => item.agentId === activeId) || null
  if (!active && items.length) {
    active = items[0]
    activeId = setActiveAgentIdentity(ownerAddress, active.agentId)
  } else if (!active && activeId) {
    setActiveAgentIdentity(ownerAddress, '')
  }
  return { items, active }
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

function readyDelegateChains(policy, ownerAddress) {
  if (delegateConfig().delegateAddress?.toLowerCase() === String(ownerAddress || '').toLowerCase()) {
    return ['Arc_Testnet', 'Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia']
  }
  const ready = (policy?.delegateChains || []).filter(item => item?.status === 'ready').map(item => item.chain)
  return ready.length ? ready : policy?.delegateStatus === 'ready' ? ['Arc_Testnet'] : []
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
