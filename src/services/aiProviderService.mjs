export function configuredProviders() {
  const providers = []
  for (let i = 1; i <= 8; i += 1) {
    const name = process.env[`AI_PROVIDER_${i}_NAME`]
    const baseUrl = process.env[`AI_PROVIDER_${i}_BASE_URL`]
    const model = process.env[`AI_PROVIDER_${i}_MODEL`]
    const singleKey = process.env[`AI_PROVIDER_${i}_API_KEY`]
    const namedKeys = name ? process.env[`AI_PROVIDER_${name.toUpperCase()}_API_KEYS`] : ''
    const keys = [
      ...(singleKey ? [singleKey] : []),
      ...(namedKeys ? namedKeys.split(',').map(v => v.trim()).filter(Boolean) : []),
    ]
    if (name && baseUrl && model && keys.length) {
      keys.forEach((apiKey, keyIndex) => {
        providers.push({
          id: `${name}_${keyIndex + 1}`,
          name,
          baseUrl: baseUrl.replace(/\/$/, ''),
          apiKey,
          model,
        })
      })
    }
  }
  return providers
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
      const timeout = setTimeout(() => controller.abort(), Number(process.env.AI_PROVIDER_TIMEOUT_MS || 45_000))
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          ...(process.env.AI_ROUTER_HTTP_REFERER ? { 'HTTP-Referer': process.env.AI_ROUTER_HTTP_REFERER } : {}),
          ...(process.env.AI_ROUTER_APP_TITLE ? { 'X-OpenRouter-Title': process.env.AI_ROUTER_APP_TITLE } : {}),
        },
        body: JSON.stringify(providerPayload(payload, provider.model)),
      }).finally(() => clearTimeout(timeout))
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { data = { raw: text } }
      if (!response.ok) {
        const err = new Error(data?.error?.message || data?.message || `Provider ${provider.name} HTTP ${response.status}`)
        err.status = response.status
        err.provider = provider.name
        if (shouldFallback(response.status)) {
          errors.push({ provider: provider.name, status: response.status, message: err.message })
          fallbackCount += 1
          continue
        }
        throw err
      }
      validateProviderChatData(data, provider)
      return {
        data,
        meta: {
          providerUsed: provider.name,
          providerModel: provider.model,
          fallbackCount,
          latency: Date.now() - started,
          errors,
        },
      }
    } catch (error) {
      const status = error?.name === 'AbortError' ? 504 : Number(error?.status || 0)
      if (shouldFallback(status)) {
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

function providerPayload(payload, model) {
  const body = { ...(payload || {}), model, stream: false }
  delete body.stream_options
  delete body.streamOptions
  return body
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
  if (requestedModel === 'arcox/auto') return providers
  const candidates = providers.filter(provider => modelMatches(provider.model, requestedModel))
  if (candidates.length) return candidates
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

function shouldFallback(status) {
  return [0, 408, 429, 500, 502, 503, 504].includes(Number(status))
}
