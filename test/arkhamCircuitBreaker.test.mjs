import test from 'node:test'
import assert from 'node:assert/strict'
import { ArkhamService, circuitStatus, degradedForProviderPath } from '../src/services/arkhamService.mjs'

async function withEnv(vars, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(vars)) previous[key] = process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function failingFetch(status) {
  return async () => ({
    ok: false,
    status,
    text: async () => JSON.stringify({ message: `Arkham HTTP ${status}` }),
  })
}

function okFetch(body = {}) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  })
}

test('circuit breaker opens after repeated provider 5xx and gates fresh requests', async () => {
  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => { fetchCalls += 1; return failingFetch(500)() }
  globalThis.__arcoxArkhamCircuits?.clear?.()
  globalThis.__arcoxArkhamCache?.clear?.()
  try {
    await withEnv({ ARKHAM_API_KEY: 'test-key', ARCOX_INTEL_CIRCUIT_FAILURES: '2', ARCOX_INTEL_CIRCUIT_WINDOW_MS: '60000', ARCOX_INTEL_CIRCUIT_COOLDOWN_MS: '60000' }, async () => {
      const service = new ArkhamService()
      await assert.rejects(() => service.get('/risk/address/0x123'), /Arkham HTTP 500/)
      await assert.rejects(() => service.get('/risk/address/0x123'), /Arkham HTTP 500/)
      assert.equal(fetchCalls, 4, 'two get() calls each retry once, so four provider hits')
      // Third call must be blocked by the circuit without any fetch
      await assert.rejects(() => service.get('/risk/address/0x123'), error => {
        assert.equal(error.status, 503)
        assert.equal(error.circuitOpen, true)
        return true
      })
      assert.equal(fetchCalls, 4, 'no fetch after circuit opened')
      const states = circuitStatus()
      const risk = states.find(state => state.key === 'risk/address')
      assert.ok(risk, 'circuit state recorded for risk/address')
      assert.equal(risk.state, 'open')
      assert.equal(degradedForProviderPath('/risk/address/0x456'), true)
    })
  } finally {
    globalThis.fetch = previousFetch
    globalThis.__arcoxArkhamCircuits?.clear?.()
    globalThis.__arcoxArkhamCache?.clear?.()
  }
})

test('circuit breaker half-open probe succeeds and closes the circuit', async () => {
  const previousFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => { fetchCalls += 1; return failingFetch(500)() }
  globalThis.__arcoxArkhamCircuits?.clear?.()
  globalThis.__arcoxArkhamCache?.clear?.()
  try {
    await withEnv({ ARKHAM_API_KEY: 'test-key', ARCOX_INTEL_CIRCUIT_FAILURES: '1', ARCOX_INTEL_CIRCUIT_WINDOW_MS: '60000', ARCOX_INTEL_CIRCUIT_COOLDOWN_MS: '0' }, async () => {
      const service = new ArkhamService()
      await assert.rejects(() => service.get('/flow/address/0x123'), /Arkham HTTP 500/)
      assert.equal(circuitStatus().find(state => state.key === 'flow/address').state, 'open')
      // Cooldown is 0 -> the next call is a half-open probe
      fetchCalls = 0
      globalThis.fetch = async () => { fetchCalls += 1; return okFetch({ data: 'recovered' })() }
      const result = await service.get('/flow/address/0x123')
      assert.equal(result.ok, true)
      assert.equal(fetchCalls, 1, 'probe hit the provider once')
      const state = circuitStatus().find(item => item.key === 'flow/address')
      assert.equal(state.state, 'closed')
      assert.equal(state.failureCount, 0)
      assert.equal(degradedForProviderPath('/flow/address/0x123'), false)
    })
  } finally {
    globalThis.fetch = previousFetch
    globalThis.__arcoxArkhamCircuits?.clear?.()
    globalThis.__arcoxArkhamCache?.clear?.()
  }
})

test('404 does not trip the circuit breaker', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = failingFetch(404)
  globalThis.__arcoxArkhamCircuits?.clear?.()
  globalThis.__arcoxArkhamCache?.clear?.()
  try {
    await withEnv({ ARKHAM_API_KEY: 'test-key', ARCOX_INTEL_CIRCUIT_FAILURES: '1', ARCOX_INTEL_CIRCUIT_WINDOW_MS: '60000', ARCOX_INTEL_CIRCUIT_COOLDOWN_MS: '60000' }, async () => {
      const service = new ArkhamService()
      await assert.rejects(() => service.get('/tag/nonexistent/summary'), /Arkham HTTP 404/)
      const state = circuitStatus().find(item => item.key === 'tag/nonexistent')
      // A 404 means "data does not exist" (refund path), never a provider fault.
      assert.equal(state, undefined, 'no circuit state recorded for 404s')
      await assert.rejects(() => service.get('/tag/nonexistent/summary'), /Arkham HTTP 404/, 'subsequent 404s still reach the provider')
    })
  } finally {
    globalThis.fetch = previousFetch
    globalThis.__arcoxArkhamCircuits?.clear?.()
    globalThis.__arcoxArkhamCache?.clear?.()
  }
})
