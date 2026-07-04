import test from 'node:test'
import assert from 'node:assert/strict'

process.env.ARCOX_ENV_FILE = '/tmp/arcox-ai-provider-test-missing.env'
for (let i = 1; i <= 8; i += 1) {
  delete process.env[`AI_PROVIDER_${i}_NAME`]
  delete process.env[`AI_PROVIDER_${i}_BASE_URL`]
  delete process.env[`AI_PROVIDER_${i}_MODEL`]
  delete process.env[`AI_PROVIDER_${i}_API_KEY`]
  delete process.env[`AI_PROVIDER_${i}_SUPPORTS_TOOLS`]
}

const { callChatCompletionWithFallback, normalizeForcedArcoxToolCall, providerPayload } = await import('../src/services/aiProviderService.mjs')

test('provider payload preserves the complete OpenAI tool surface', () => {
  const tools = Array.from({ length: 24 }, (_, index) => ({
    type: 'function',
    function: {
      name: `tool_${index}`,
      description: `Tool ${index}`,
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
    },
  }))
  const result = providerPayload({
    model: 'arcox/auto',
    messages: [{ role: 'user', content: 'use a tool' }],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: true,
    stream: true,
    stream_options: { include_usage: true },
  }, 'provider/model')

  assert.equal(result.model, 'provider/model')
  assert.equal(result.stream, false)
  assert.equal(result.stream_options, undefined)
  assert.equal(result.tools.length, 24)
  assert.equal(result.tools[23].function.name, 'tool_23')
  assert.equal(result.tool_choice, 'auto')
  assert.equal(result.parallel_tool_calls, true)
})

test('natural swap requests immediately select the ARCOX quote tool', () => {
  const quoteTool = {
    type: 'function',
    function: {
      name: 'mcp_arcox_arcox_quote_swap',
      description: 'Quote an Arc swap',
      parameters: { type: 'object', properties: {} },
    },
  }
  const result = providerPayload({
    messages: [{ role: 'user', content: 'swap 1 eurc ke usdc' }],
    tools: [quoteTool, { type: 'function', function: { name: 'skill_view', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  }, 'openai/gpt-oss-120b')

  assert.deepEqual(result.tool_choice, {
    type: 'function',
    function: { name: 'mcp_arcox_arcox_quote_swap' },
  })
})

test('swap routing does not force the quote tool again after a tool result', () => {
  const result = providerPayload({
    messages: [
      { role: 'user', content: 'swap 1 eurc ke usdc' },
      { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp_arcox_arcox_quote_swap', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"previewId":"preview_1"}' },
    ],
    tools: [{ type: 'function', function: { name: 'mcp_arcox_arcox_quote_swap', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  }, 'openai/gpt-oss-120b')

  assert.equal(result.tool_choice, 'auto')
})

test('forced ARCOX quote produces concise deterministic tool arguments', () => {
  const payload = providerPayload({
    messages: [{ role: 'user', content: 'swap 1 eurc ke usdc' }],
    tools: [{ type: 'function', function: { name: 'mcp_arcox_arcox_quote_swap', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  }, 'fallback-model')
  const data = {
    choices: [{
      message: { role: 'assistant', content: 'Long internal instructions', reasoning_content: 'Long reasoning' },
      finish_reason: 'length',
    }],
  }
  normalizeForcedArcoxToolCall(data, payload)
  assert.equal(data.choices[0].finish_reason, 'tool_calls')
  assert.equal(data.choices[0].message.content, null)
  assert.equal(data.choices[0].message.reasoning_content, undefined)
  assert.equal(data.choices[0].message.tool_calls[0].function.name, 'mcp_arcox_arcox_quote_swap')
  assert.deepEqual(JSON.parse(data.choices[0].message.tool_calls[0].function.arguments), {
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '1',
  })
})

test('tool requests fall back when the preferred provider rejects tool calling', async () => {
  Object.assign(process.env, {
    AI_PROVIDER_1_NAME: 'NO_TOOLS',
    AI_PROVIDER_1_BASE_URL: 'https://provider-one.test/v1',
    AI_PROVIDER_1_MODEL: 'model-one',
    AI_PROVIDER_1_API_KEY: 'key-one',
    AI_PROVIDER_1_SUPPORTS_TOOLS: 'true',
    AI_PROVIDER_2_NAME: 'TOOLS',
    AI_PROVIDER_2_BASE_URL: 'https://provider-two.test/v1',
    AI_PROVIDER_2_MODEL: 'model-two',
    AI_PROVIDER_2_API_KEY: 'key-two',
    AI_PROVIDER_2_SUPPORTS_TOOLS: 'true',
    AI_ROUTER_AUTO_MODEL: 'model-one',
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    if (String(url).includes('provider-one')) {
      return new Response(JSON.stringify({ error: { message: 'tools are not supported' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await callChatCompletionWithFallback({
      model: 'arcox/auto',
      messages: [{ role: 'user', content: 'run terminal' }],
      tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object', properties: {} } } }],
    })
    assert.equal(calls.length, 2)
    assert.match(calls[0].url, /provider-one/)
    assert.match(calls[1].url, /provider-two/)
    assert.equal(calls[1].body.tools[0].function.name, 'terminal')
    assert.equal(result.data.choices[0].message.tool_calls[0].function.name, 'terminal')
    assert.equal(result.meta.toolsForwarded, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an explicitly requested model can fall back after a temporary provider failure', async () => {
  Object.assign(process.env, {
    AI_PROVIDER_1_NAME: 'PRIMARY',
    AI_PROVIDER_1_BASE_URL: 'https://primary.test/v1',
    AI_PROVIDER_1_MODEL: 'requested-model',
    AI_PROVIDER_1_API_KEY: 'primary-key',
    AI_PROVIDER_1_TIMEOUT_MS: '1000',
    AI_PROVIDER_2_NAME: 'FALLBACK',
    AI_PROVIDER_2_BASE_URL: 'https://fallback.test/v1',
    AI_PROVIDER_2_MODEL: 'fallback-model',
    AI_PROVIDER_2_API_KEY: 'fallback-key',
    AI_ROUTER_ALLOW_MODEL_FALLBACK: 'true',
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    if (String(url).includes('primary.test')) {
      return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-fallback',
      model: 'fallback-model',
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await callChatCompletionWithFallback({
      model: 'requested-model',
      messages: [{ role: 'user', content: 'reply OK' }],
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].body.model, 'requested-model')
    assert.equal(calls[1].body.model, 'fallback-model')
    assert.equal(result.meta.providerModel, 'fallback-model')
    assert.equal(result.meta.fallbackCount, 1)
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.AI_ROUTER_ALLOW_MODEL_FALLBACK
  }
})
