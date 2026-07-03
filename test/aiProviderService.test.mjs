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

const { callChatCompletionWithFallback, providerPayload } = await import('../src/services/aiProviderService.mjs')

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
