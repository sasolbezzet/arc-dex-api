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
    models.set(provider.model, {
      id: provider.model,
      object: 'model',
      created: 0,
      owned_by: provider.name,
    })
  }
  if (!models.has('arcox/auto')) {
    models.set('arcox/auto', { id: 'arcox/auto', object: 'model', created: 0, owned_by: 'arcox' })
  }
  return [...models.values()]
}

export async function callChatCompletionWithFallback(payload, options = {}) {
  const providers = configuredProviders()
  if (!providers.length) {
    const err = new Error('No AI providers configured')
    err.status = 503
    throw err
  }
  const requestedModel = payload.model || 'arcox/auto'
  const candidates = providers.filter(p => requestedModel === 'arcox/auto' || p.model === requestedModel)
  const queue = candidates.length ? candidates : providers
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
        body: JSON.stringify({ ...payload, model: requestedModel === 'arcox/auto' ? provider.model : requestedModel }),
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

function shouldFallback(status) {
  return [0, 408, 429, 500, 502, 503, 504].includes(Number(status))
}
