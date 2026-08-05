import { readFileSync, statSync } from 'node:fs'
import { parse as parseDotenv } from 'dotenv'

let providerEnvMtime = 0
let providerEnvKeys = new Set()

export function configuredProviders() {
  refreshProviderEnvironment()
  const providers = []
  for (let i = 1; i <= 8; i += 1) {
    const name = process.env[`AI_PROVIDER_${i}_NAME`]
    const baseUrl = process.env[`AI_PROVIDER_${i}_BASE_URL`]
    const model = process.env[`AI_PROVIDER_${i}_MODEL`]
    const supportsTools = !/^(false|0|no)$/i.test(String(process.env[`AI_PROVIDER_${i}_SUPPORTS_TOOLS`] || 'true'))
    const timeoutMs = positiveNumber(process.env[`AI_PROVIDER_${i}_TIMEOUT_MS`], process.env.AI_PROVIDER_TIMEOUT_MS || 45_000)
    const singleKey = process.env[`AI_PROVIDER_${i}_API_KEY`]
    const namedKeys = name ? process.env[`AI_PROVIDER_${name.toUpperCase()}_API_KEYS`] : ''
    const keys = [
      ...(singleKey ? [singleKey] : []),
      ...(namedKeys ? namedKeys.split(',').map(v => v.trim()).filter(Boolean) : []),
    ]
    if (name && baseUrl && model && (keys.length || !singleKey)) {
      const effectiveKeys = keys.length ? keys : [""]
      effectiveKeys.forEach((apiKey, keyIndex) => {
        providers.push({
          id: `${name}_${keyIndex + 1}`,
          name,
          baseUrl: baseUrl.replace(/\/$/, ''),
          apiKey,
          model,
          supportsTools,
          timeoutMs,
        })
      })
    }
  }
  return providers
}

function refreshProviderEnvironment() {
  try {
    const path = process.env.ARCOX_ENV_FILE || '.env'
    const mtime = statSync(path).mtimeMs
    if (mtime === providerEnvMtime) return
    const parsed = parseDotenv(readFileSync(path))
    const nextKeys = new Set(Object.keys(parsed).filter(key => key.startsWith('AI_PROVIDER_')))
    for (const key of providerEnvKeys) {
      if (!nextKeys.has(key)) delete process.env[key]
    }
    for (const key of nextKeys) process.env[key] = parsed[key]
    providerEnvKeys = nextKeys
    providerEnvMtime = mtime
    modelCache.clear()
  } catch {
    // Keep process env when no local env file is available.
  }
}

export function publicModels() {
  const providers = configuredProviders()
  const models = new Map()
  for (const provider of providers) {
    addPublicModel(models, provider.model, provider.name)
    const alias = modelAlias(provider.model)
    if (alias !== provider.model) addPublicModel(models, alias, provider.name)
  }
  if (!models.has('arcox/auto')) {
    models.set('arcox/auto', { id: 'arcox/auto', object: 'model', created: 0, owned_by: 'arcox' })
  }
  return [...models.values()]
}

export async function validateChatCompletionRoute(payload = {}) {
  const queue = selectProviders(payload)
  const validationMode = String(process.env.AI_PROVIDER_VALIDATE_MODELS || 'true').toLowerCase()
  if (validationMode === 'false' || validationMode === '0') return { ok: true, providers: queue }

  const errors = []
  for (const provider of queue) {
    try {
      const models = await providerModels(provider)
      if (!models.length || models.includes(provider.model)) return { ok: true, providers: queue }
      errors.push(`${provider.name}: model ${provider.model} not listed by provider`)
    } catch (error) {
      errors.push(`${provider.name}: ${error?.message || 'model validation failed'}`)
    }
  }

  const err = new Error(`AI provider model is not available. ${errors.join('; ')}`)
  err.status = 503
  err.type = 'provider_config_error'
  throw err
}

export async function callChatCompletionWithFallback(payload, options = {}) {
  const requestedModel = payload.model || 'arcox/auto'
  const queue = selectProviders(payload)
  const started = Date.now()
  const errors = []
  let fallbackCount = 0

  for (const provider of queue) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
      const forwardedPayload = providerPayload(payload, provider.model)
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          ...(process.env.AI_ROUTER_HTTP_REFERER ? { 'HTTP-Referer': process.env.AI_ROUTER_HTTP_REFERER } : {}),
          ...(process.env.AI_ROUTER_APP_TITLE ? { 'X-OpenRouter-Title': process.env.AI_ROUTER_APP_TITLE } : {}),
        },
        body: JSON.stringify(forwardedPayload),
      }).finally(() => clearTimeout(timeout))
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { data = { raw: text } }
      if (!response.ok) {
        const err = new Error(data?.error?.message || data?.message || `Provider ${provider.name} HTTP ${response.status}`)
        err.status = response.status
        err.provider = provider.name
        if (shouldFallback(response.status, err.message, payload)) {
          errors.push({ provider: provider.name, status: response.status, message: err.message })
          fallbackCount += 1
          continue
        }
        throw err
      }
      validateProviderChatData(data, provider)
      normalizeForcedArcoxToolCall(data, forwardedPayload)
      return {
        data,
        meta: {
          providerUsed: provider.name,
          providerModel: provider.model,
          fallbackCount,
          latency: Date.now() - started,
          errors,
          toolsForwarded: Array.isArray(forwardedPayload.tools) ? forwardedPayload.tools.length : 0,
        },
      }
    } catch (error) {
      const status = error?.name === 'AbortError' ? 504 : Number(error?.status || 0)
      if (shouldFallback(status, error?.message, payload)) {
        errors.push({ provider: provider.name, status, message: error?.message || 'temporary provider error' })
        fallbackCount += 1
        continue
      }
      error.providerMeta = { providerUsed: provider.name, fallbackCount, latency: Date.now() - started, errors }
      throw error
    }
  }

  const err = new Error('All AI providers failed temporarily')
  err.status = 503
  err.providerMeta = { providerUsed: '', fallbackCount, latency: Date.now() - started, errors }
  throw err
}

function validateProviderChatData(data, provider) {
  if (Array.isArray(data?.choices) && data.choices.length) return
  const err = new Error(`Provider ${provider.name} returned malformed chat completion`)
  err.status = 502
  err.provider = provider.name
  throw err
}

export function providerPayload(payload, model) {
  const body = { ...(payload || {}), model, stream: false }
  delete body.stream_options
  delete body.streamOptions
  applyArcoxToolRouting(body)
  return body
}

function applyArcoxToolRouting(body) {
  if (!Array.isArray(body.tools) || !Array.isArray(body.messages)) return
  if (body.tool_choice && body.tool_choice !== 'auto') return
  const lastUserIndex = body.messages.findLastIndex(message => message?.role === 'user')
  if (lastUserIndex < 0) return
  const alreadyUsingTools = body.messages.slice(lastUserIndex + 1).some(message =>
    message?.role === 'tool' || (message?.role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0))
  if (alreadyUsingTools) return
  const prompt = messageText(body.messages[lastUserIndex]?.content).toLowerCase()
  if (!/\b(?:swap|tukar)\b/.test(prompt)) return
  const quoteSwap = body.tools.find(tool => /(?:^|_)arcox_quote_swap$/.test(String(tool?.function?.name || '')))
  if (!quoteSwap?.function?.name) return
  body.tool_choice = { type: 'function', function: { name: quoteSwap.function.name } }
}

export function normalizeForcedArcoxToolCall(data, forwardedPayload) {
  const forcedName = String(forwardedPayload?.tool_choice?.function?.name || '')
  if (!/(?:^|_)arcox_quote_swap$/.test(forcedName)) return data
  const lastUser = [...(forwardedPayload.messages || [])].reverse().find(message => message?.role === 'user')
  const parsed = parseNaturalSwap(messageText(lastUser?.content))
  if (!parsed) return data
  const choice = data?.choices?.[0]
  if (!choice?.message) return data
  choice.message = {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: `call_arcox_quote_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: forcedName, arguments: JSON.stringify(parsed) },
    }],
  }
  choice.finish_reason = 'tool_calls'
  return data
}

function parseNaturalSwap(content) {
  const text = String(content || '').trim()
  const match = text.match(/\b(?:swap|tukar)\s+(\d+(?:[.,]\d+)?)\s+([a-zA-Z][a-zA-Z0-9-]*)\s+(?:ke|to|for|menjadi)\s+([a-zA-Z][a-zA-Z0-9-]*)\b/i)
  if (!match) return null
  return {
    tokenIn: match[2].toUpperCase(),
    tokenOut: match[3].toUpperCase(),
    amountIn: match[1].replace(',', '.'),
  }
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(item => typeof item === 'string' ? item : item?.type === 'text' ? item.text || '' : '').join(' ')
}

function selectProviders(payload = {}) {
  const providers = configuredProviders()
  if (!providers.length) {
    const err = new Error('No AI providers configured')
    err.status = 503
    err.type = 'provider_config_error'
    throw err
  }
  const requestedModel = payload.model || 'arcox/auto'
  const toolsRequested = Array.isArray(payload.tools) && payload.tools.length > 0
  if (requestedModel === 'arcox/auto') {
    const preferredModel = String(process.env.AI_ROUTER_AUTO_MODEL || '').trim()
    return [...providers].sort((left, right) => {
      const toolScore = toolsRequested ? Number(right.supportsTools) - Number(left.supportsTools) : 0
      if (toolScore) return toolScore
      return preferredModel ? Number(modelMatches(right.model, preferredModel)) - Number(modelMatches(left.model, preferredModel)) : 0
    })
  }
  const candidates = providers.filter(provider => modelMatches(provider.model, requestedModel))
  if (candidates.length) {
    if (!/^(true|1|yes)$/i.test(String(process.env.AI_ROUTER_ALLOW_MODEL_FALLBACK || 'false'))) return candidates
    const fallback = providers
      .filter(provider => !candidates.includes(provider) && (!toolsRequested || provider.supportsTools))
      .sort((left, right) => Number(right.supportsTools) - Number(left.supportsTools))
    return [...candidates, ...fallback]
  }
  const err = new Error(`Model ${requestedModel} is not configured in ARCOX AI Router`)
  err.status = 400
  err.type = 'model_not_found'
  throw err
}

function modelMatches(providerModel, requestedModel) {
  return providerModel === requestedModel || modelAlias(providerModel) === requestedModel || modelAlias(requestedModel) === providerModel
}

function modelAlias(model) {
  const value = String(model || '').trim()
  return value.includes('/') ? value.split('/').pop() : value
}

function addPublicModel(models, id, owner) {
  if (!id || models.has(id)) return
  models.set(id, {
    id,
    object: 'model',
    created: 0,
    owned_by: owner,
  })
}

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed >= 1_000) return parsed
  const defaultValue = Number(fallback)
  return Number.isFinite(defaultValue) && defaultValue >= 1_000 ? defaultValue : 45_000
}

const modelCache = new Map()

async function providerModels(provider) {
  const cacheKey = `${provider.baseUrl}|${provider.apiKey.slice(-8)}`
  const cached = modelCache.get(cacheKey)
  if (cached && Date.now() - cached.time < Number(process.env.AI_PROVIDER_MODEL_CACHE_MS || 600_000)) return cached.models
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_PROVIDER_MODEL_TIMEOUT_MS || 10_000))
  const response = await fetch(`${provider.baseUrl}/models`, {
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      ...(process.env.AI_ROUTER_HTTP_REFERER ? { 'HTTP-Referer': process.env.AI_ROUTER_HTTP_REFERER } : {}),
      ...(process.env.AI_ROUTER_APP_TITLE ? { 'X-OpenRouter-Title': process.env.AI_ROUTER_APP_TITLE } : {}),
    },
  }).finally(() => clearTimeout(timeout))
  if (!response.ok) {
    const err = new Error(`models endpoint HTTP ${response.status}`)
    err.status = response.status
    throw err
  }
  const data = await response.json()
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  const models = list.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean)
  modelCache.set(cacheKey, { time: Date.now(), models })
  return models
}

function shouldFallback(status, message = '', payload = {}) {
  if ([0, 401, 402, 403, 408, 429, 500, 502, 503, 504].includes(Number(status))) return true
  if (![400, 404, 415, 422].includes(Number(status))) return false
  if (!Array.isArray(payload?.tools) || payload.tools.length === 0) return false
  return /tool|function|parallel_tool_calls|tool_choice|unsupported|not supported|unknown field|invalid parameter/i.test(String(message || ''))
}
