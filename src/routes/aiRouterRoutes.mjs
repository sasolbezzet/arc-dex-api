import { Router } from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import {
  addUsageLog,
  createPaymentIntent,
  findApiKeyForCredential,
  getActiveAgentId,
  getAiRouterStatus,
  getPolicy,
  getPaymentIntent,
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
  spendThisMonth,
  spendToday,
  treasuryAddress,
  usageForOwner,
} from '../services/aiRouterStore.mjs'
import { callChatCompletionWithFallback, publicModels, validateChatCompletionRoute } from '../services/aiProviderService.mjs'
import { delegateConfig, estimateDelegatedAiSpend, spendDelegatedAiPayment } from '../services/aiRouterSpendService.mjs'
import { listAgentIdentities, verifyAgentOwnership } from '../services/agentIdentityService.mjs'
import { submitAgentMemoProof } from '../services/arcMemoService.mjs'
import { getGatewayDelegateStatus } from '../services/gatewayDelegateService.mjs'

const router = Router()
const aiResponseCache = new Map()
const aiInflight = new Set()
const aiOwnerInflight = new Map()
const aiKeyRateBuckets = new Map()

router.get('/status', async (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!ownerAddress) return res.status(400).json({ error: 'ownerAddress is required' })
  try {
    const identity = await resolveActiveIdentity(ownerAddress)
    res.json({
      ok: true,
      ...getAiRouterStatus(ownerAddress),
      solanaDelegateAddress: delegateConfig().solanaDelegateAddress || '',
      agentIdentity: identity.active,
      agentIdentities: identity.items,
      treasury: treasuryAddress(),
      security: {
        apiPassRequired: false,
        sessionRequired: false,
        transactionWalletMatchRequired: true,
        maxServiceCostUsdc: process.env.AI_ROUTER_MAX_SERVICE_COST_USDC || '0.01',
        maxTotalDebitUsdc: process.env.AI_ROUTER_MAX_TOTAL_DEBIT_USDC || '0.05',
        dailyLimitUsdc: process.env.AI_ROUTER_DAILY_LIMIT_USDC || '10',
        weeklyLimitUsdc: 'unlimited',
        monthlyLimitUsdc: Number(process.env.AI_ROUTER_MONTHLY_LIMIT_USDC || '0') > 0 ? process.env.AI_ROUTER_MONTHLY_LIMIT_USDC : 'unlimited',
      },
      docs: docs(),
    })
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

router.get('/auto-pay/readiness', async (req, res) => {
  const ownerAddress = normalizeOwner(req.query.ownerAddress)
  if (!/^0x[a-f0-9]{40}$/.test(ownerAddress)) return res.status(400).json({ error: 'Valid ownerAddress is required' })
  try {
    res.json({ ok: true, autoPay: await refreshAutoPayReadiness(ownerAddress) })
  } catch (error) {
    res.status(502).json({ error: error?.message || 'Auto Pay readiness refresh failed' })
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
  const created = issueApiKey({
    ownerAddress,
    agentId: identity.active?.agentId || '',
    label: req.body?.label || 'ARCOX AI Router',
    scopes,
  })
  res.json({ ok: true, apiKey: created.apiKey, key: created.record, warning: 'Copy this key now. ARCOX stores only the hash and cannot show it again.' })
})

router.post('/api-keys/:id/activate', (_req, res) => res.status(410).json({ error: 'API Pass activation is no longer required.' }))

router.post('/api-keys/:id/disable', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const key = revokeApiKey(req.params.id, ownerAddress)
  if (!key) return res.status(404).json({ error: 'API key not found' })
  res.json({ ok: true, key })
})

router.post('/api-keys/:id/finalize-revoke', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const key = revokeApiKey(req.params.id, ownerAddress)
  if (!key) return res.status(404).json({ error: 'API key not found' })
  res.json({ ok: true, key })
})

router.post('/api-keys/:id/revoke', requireOwnerAuth, (req, res) => {
  const ownerAddress = normalizeOwner(req.body?.ownerAddress)
  const key = revokeApiKey(req.params.id, ownerAddress)
  if (!key) return res.status(404).json({ error: 'API key not found' })
  res.json({ ok: true, key })
})

router.get('/api-keys/status', (req, res) => {
  const auth = credentialApiKey(req)
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  res.json({ ok: true, key: publicApiKey(auth.apiKey), sessionRequired: false })
})

router.post('/sessions/challenge', (_req, res) => res.status(410).json({ error: 'Signed API sessions are no longer required.' }))
router.post('/sessions', (_req, res) => res.status(410).json({ error: 'Signed API sessions are no longer required.' }))

router.get('/models', (_req, res) => {
  res.json({ ok: true, data: pricedModels(), object: 'list' })
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
  res.json({ object: 'list', data: pricedModels() })
}

export async function openAiChatCompletions(req, res) {
  const auth = await authenticateAiKey(req, 'ai:chat')
  if (!auth.ok) return res.status(auth.status).json(auth.body)
  const apiKey = auth.apiKey
  const idempotencyKey = normalizeIdempotencyKey(req.headers['x-arcox-idempotency-key'])
  const cacheKey = idempotencyKey ? `${apiKey.id}:${idempotencyKey}` : ''
  const cached = cacheKey ? aiResponseCache.get(cacheKey) : null
  if (cached && Date.now() < cached.expiresAt) return sendChatResponse(req, res, cached.body)
  if (cacheKey && aiInflight.has(cacheKey)) return res.status(409).json({ error: { message: 'Identical AI request is already processing. Retry shortly.', type: 'request_in_progress', charged: false } })
  if (cacheKey) {
    aiInflight.add(cacheKey)
    res.once('finish', () => aiInflight.delete(cacheKey))
    res.once('close', () => aiInflight.delete(cacheKey))
  }
  const requestId = idempotencyKey ? `air_req_${idempotencyKey.slice(0, 20)}` : `air_req_${Date.now().toString(36)}`
  const previousPayment = idempotencyKey ? getPaymentIntent(requestId) : null
  if (previousPayment?.status === 'paid') {
    return res.status(409).json({
      error: {
        message: 'This identical request was already paid. ARCOX will not charge it again.',
        type: 'already_paid',
        charged: false,
        paymentId: previousPayment.id,
        txHash: previousPayment.txHash || null,
      },
    })
  }
  const owner = apiKey.ownerAddress
  if (!consumeAiKeyRate(apiKey.id)) return res.status(429).json({ error: { message: 'AI Router request rate exceeded.', type: 'rate_limit', charged: false } })
  let policy = getPolicy(owner)
  if (policy.delegateChains?.some(item => item?.status === 'pending')) {
    policy = await refreshAutoPayReadiness(owner).catch(() => policy)
  }
  const cost = priceForModel(req.body?.model || 'arcox/auto')
  const limitError = aiSpendLimitError(owner, cost)
  if (limitError) return paymentRequired(res, 'Auto Pay limit reached', limitError)
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
    estimate = await estimateDelegatedAiSpend({ sourceAccount: owner, solanaSourceAccount: policy.solanaOwnerAddress, amount: cost, sourceChains: readyDelegateChains(policy, owner) })
    const totalDebit = normalizeUsdc(estimate.totalDebit || estimate.spendAmount || cost)
    const maxDebit = normalizeUsdc(process.env.AI_ROUTER_MAX_TOTAL_DEBIT_USDC || '0.05')
    if (Number(totalDebit) > Number(maxDebit)) throw new Error(`Total debit ${totalDebit} USDC exceeds the configured ${maxDebit} USDC safety cap`)
    markPaymentStatus(payment.id, 'estimate_ready', { amount: estimate.totalDebit || estimate.spendAmount || cost, serviceAmount: cost, totalFee: estimate.totalFee || '0' })
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
      apiKeyIdHash: apiKey.apiKeyIdHash,
      sbtTokenId: apiKey.sbtTokenId,
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
  let releaseOwner
  try {
    releaseOwner = await acquireAiOwnerSlot(owner, res)
  } catch (error) {
    markPaymentStatus(payment.id, 'failed', { error: error?.message || 'Payment queue timeout', charged: false })
    return res.status(error?.status || 503).json({ error: { message: error?.message || 'AI Router payment queue is busy.', type: error?.type || 'wallet_queue_timeout', charged: false } })
  }
  res.once('finish', releaseOwner)
  res.once('close', releaseOwner)
  try {
    spend = await spendDelegatedAiPayment({ sourceAccount: owner, solanaSourceAccount: policy.solanaOwnerAddress, amount: cost, estimate, sourceChains: readyDelegateChains(policy, owner) })
    releaseOwner()
    if (spend.txHash) {
      memoProof = await submitAgentMemoProof({
        agentId: apiKey.agentId,
        sbtTokenId: apiKey.sbtTokenId,
        apiKeyIdHash: apiKey.apiKeyIdHash,
        apiPassAddress: apiKey.apiPassAddress,
        paymentId: payment.id,
        requestId,
        service: 'ai_router',
        model: req.body?.model || 'arcox/auto',
        amount: spend.chargedAmount || cost,
        treasury: treasuryAddress(),
        settlementTxHash: spend.txHash,
      }).catch(() => null)
    }
    markPaymentSettled(payment.id, {
      txHash: spend.txHash,
      transferId: spend.transferId,
      memoId: memoProof?.memoId,
      memoTxHash: memoProof?.txHash,
      amount: spend.chargedAmount,
      serviceAmount: spend.serviceAmount,
      totalFee: spend.totalFee,
      sourceAllocations: spend.sourceAllocations,
    })
  } catch (error) {
    releaseOwner()
    return handlePaymentFailure({ res, paymentId: payment.id, error })
  }

  const { data, meta } = providerResult
  const usage = data.usage || {}
  const log = addUsageLog({
    requestId,
    apiKeyId: apiKey.id,
    apiKeyIdHash: apiKey.apiKeyIdHash,
    sbtTokenId: apiKey.sbtTokenId,
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
      sourceAllocations: spend.sourceAllocations || [],
      requestId,
      paymentId: payment.id,
      paymentStatus: 'paid',
      txHash: spend.txHash,
      transferId: spend.transferId,
      agentId: apiKey.agentId || null,
      sbtTokenId: apiKey.sbtTokenId,
      apiKeyIdHash: apiKey.apiKeyIdHash,
      memoId: memoProof?.memoId || null,
      memoTxHash: memoProof?.txHash || null,
      usageLog: log,
      providerUsed: meta.providerUsed,
      fallbackCount: meta.fallbackCount,
      toolsForwarded: meta.toolsForwarded || 0,
    },
  }
  if (cacheKey) aiResponseCache.set(cacheKey, { body, expiresAt: Date.now() + Number(process.env.AI_ROUTER_IDEMPOTENCY_TTL_SECONDS || 300) * 1000 })
  pruneAiResponseCache()
  sendChatResponse(req, res, body)
}

function sendChatResponse(req, res, body) {
  if (req.body?.stream) return sendChatCompletionStream(res, body)
  return res.json(body)
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim()
  return /^[a-fA-F0-9]{32,64}$/.test(key) ? key.toLowerCase() : ''
}

async function acquireAiOwnerSlot(owner, res) {
  const timeoutMs = Math.max(10_000, Number(process.env.AI_ROUTER_WALLET_QUEUE_TIMEOUT_MS || 120_000))
  const lockTtlMs = Math.max(timeoutMs, Number(process.env.AI_ROUTER_WALLET_LOCK_TTL_MS || 180_000))
  const started = Date.now()
  const token = Symbol(owner)
  while (true) {
    if (res.destroyed) throw Object.assign(new Error('AI request was cancelled before payment.'), { status: 499, type: 'request_cancelled' })
    const current = aiOwnerInflight.get(owner)
    if (!current || Date.now() >= current.expiresAt) {
      aiOwnerInflight.set(owner, { token, expiresAt: Date.now() + lockTtlMs })
      let released = false
      return () => {
        if (released) return
        released = true
        if (aiOwnerInflight.get(owner)?.token === token) aiOwnerInflight.delete(owner)
      }
    }
    if (Date.now() - started >= timeoutMs) {
      throw Object.assign(new Error('AI Router is finishing your previous request. Try again shortly.'), { status: 503, type: 'wallet_queue_timeout' })
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

function pruneAiResponseCache() {
  const now = Date.now()
  for (const [key, entry] of aiResponseCache) if (now >= entry.expiresAt) aiResponseCache.delete(key)
  while (aiResponseCache.size > 100) aiResponseCache.delete(aiResponseCache.keys().next().value)
}

function priceForModel(model) {
  let prices = {}
  try { prices = JSON.parse(process.env.AI_ROUTER_MODEL_PRICES_USDC || '{}') } catch {}
  const value = prices[String(model || '')] ?? process.env.AI_ROUTER_MODEL_PRICE_DEFAULT_USDC ?? process.env.AI_ROUTER_DEFAULT_COST_USDC ?? '0.001'
  return normalizeUsdc(value)
}

function pricedModels() {
  return publicModels().map(model => ({ ...model, price_usdc: priceForModel(model.id), payment_asset: 'USDC', payment_source: 'Unified Balance' }))
}

function aiSpendLimitError(owner, cost) {
  const perRequest = Number(process.env.AI_ROUTER_MAX_SERVICE_COST_USDC || '0.01')
  const daily = Number(process.env.AI_ROUTER_DAILY_LIMIT_USDC || '10')
  const monthly = Number(process.env.AI_ROUTER_MONTHLY_LIMIT_USDC || '0')
  if (perRequest > 0 && Number(cost) > perRequest) return `Service cost ${cost} USDC exceeds the per-request limit ${perRequest} USDC.`
  if (daily > 0 && Number(spendToday(owner)) + Number(cost) > daily) return `Daily AI Router limit ${daily} USDC reached.`
  if (monthly > 0 && Number(spendThisMonth(owner)) + Number(cost) > monthly) return `Monthly AI Router limit ${monthly} USDC reached.`
  return ''
}

function consumeAiKeyRate(apiKeyId) {
  const now = Date.now()
  const windowMs = 60_000
  const max = Number(process.env.AI_ROUTER_REQUESTS_PER_MINUTE || '20')
  const recent = (aiKeyRateBuckets.get(apiKeyId) || []).filter(time => now - time < windowMs)
  if (recent.length >= max) return false
  recent.push(now)
  aiKeyRateBuckets.set(apiKeyId, recent)
  return true
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
  const apiKey = findApiKeyForCredential(secret)
  if (!apiKey || apiKey.status !== 'active') return { ok: false, status: 403, body: { error: { message: 'This API key has been revoked.', type: 'api_key_revoked' } } }
  if (!apiKey.scopes?.includes(scope)) return { ok: false, status: 403, body: { error: { message: `Missing scope ${scope}`, type: 'permission_error' } } }
  const claimedAgentId = String(req.headers['x-arcox-agent-id'] || req.body?.metadata?.agentId || req.body?.agentId || '')
  if (claimedAgentId && claimedAgentId !== String(apiKey.agentId || '')) return { ok: false, status: 403, body: { error: { message: 'Agent identity mismatch', type: 'permission_error' } } }
  if (apiKey.agentId && !await verifyAgentOwnership(apiKey.agentId, apiKey.ownerAddress)) return { ok: false, status: 403, body: { error: { message: 'Agent identity mismatch', type: 'permission_error' } } }
  return { ok: true, apiKey: publicApiKey(apiKey) }
}

function credentialApiKey(req) {
  const header = String(req.headers.authorization || '')
  const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!secret.startsWith('arx_sk_')) return { ok: false, status: 401, body: { error: { message: 'Invalid ARCOX API key', type: 'authentication_error' } } }
  const apiKey = findApiKeyForCredential(secret)
  if (!apiKey) return { ok: false, status: 401, body: { error: { message: 'Invalid ARCOX API key', type: 'authentication_error' } } }
  if (apiKey.status !== 'active') return { ok: false, status: 403, body: { error: { message: 'This API key has been revoked.', type: 'api_key_revoked' } } }
  return { ok: true, apiKey }
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

async function refreshAutoPayReadiness(ownerAddress) {
  const policy = getPolicy(ownerAddress)
  const delegateAddress = policy.delegateAddress || delegateConfig().delegateAddress
  if (!policy.enabled || !delegateAddress || !Array.isArray(policy.delegateChains) || !policy.delegateChains.length) return policy
  const delegateChains = await Promise.all(policy.delegateChains.map(async item => {
    if (item?.status !== 'pending') return item
    try {
      const result = await getGatewayDelegateStatus({ ownerAddress, delegateAddress, chain: item.chain })
      return { chain: item.chain, status: result.status === 'none' ? 'not_configured' : result.status }
    } catch {
      return item
    }
  }))
  const delegateStatus = delegateChains.some(item => item.status === 'ready')
    ? 'ready'
    : delegateChains.some(item => item.status === 'pending') ? 'pending' : 'not_configured'
  return setPolicy(ownerAddress, { enabled: policy.enabled, delegateStatus, delegateAddress, delegateChains })
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
      'Create and copy the API key once.',
      'Use the production base URL directly in Hermes/OpenClaw.',
    ],
  }
}

export default router
