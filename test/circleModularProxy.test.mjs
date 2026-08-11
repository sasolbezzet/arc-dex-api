import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCircleModularTarget, circleModularProxyHeaders, isAllowedCircleModularMethod, normalizeCircleModularResponse } from '../src/services/circleModularProxy.mjs'

test('Circle Modular proxy does not duplicate an already configured tenant path', () => {
  assert.equal(
    buildCircleModularTarget('https://modular-sdk.circle.com/v1/rpc/w3s/buidl', '/w3s/buidl'),
    'https://modular-sdk.circle.com/v1/rpc/w3s/buidl',
  )
})

test('Circle Modular proxy appends the tenant path to a base RPC URL once', () => {
  assert.equal(
    buildCircleModularTarget('https://modular-sdk.circle.com/v1/rpc', '/w3s/buidl'),
    'https://modular-sdk.circle.com/v1/rpc/w3s/buidl',
  )
})

test('Circle Modular proxy preserves request query parameters', () => {
  assert.equal(
    buildCircleModularTarget('https://modular-sdk.circle.com/v1/rpc/w3s/buidl', '/w3s/buidl?region=test'),
    'https://modular-sdk.circle.com/v1/rpc/w3s/buidl?region=test',
  )
})

test('Circle Modular proxy joins nested tenant requests without duplication', () => {
  assert.equal(
    buildCircleModularTarget('https://modular-sdk.circle.com/v1/rpc/w3s/buidl', '/w3s/buidl/rp_getLoginOptions'),
    'https://modular-sdk.circle.com/v1/rpc/w3s/buidl/rp_getLoginOptions',
  )
})

test('Circle Modular proxy only overlaps complete path segments', () => {
  assert.equal(
    buildCircleModularTarget('https://modular-sdk.circle.com/v1/rpc/not-w3s/buidl', '/w3s/buidl'),
    'https://modular-sdk.circle.com/v1/rpc/not-w3s/buidl/w3s/buidl',
  )
})

test('Circle Modular proxy always uses the server-owned credential', () => {
  assert.deepEqual(circleModularProxyHeaders('server-key', 'test-app'), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer server-key',
    'X-AppInfo': 'test-app',
  })
})

test('Circle Modular proxy allows the MSCA address resolution used after passkey login', () => {
  assert.equal(isAllowedCircleModularMethod('circle_getAddress'), true)
})

test('Circle Modular proxy allows passkey and required wallet methods only', () => {
  assert.equal(isAllowedCircleModularMethod('rp_getLoginOptions'), true)
  assert.equal(isAllowedCircleModularMethod('eth_getUserOperationReceipt'), true)
  assert.equal(isAllowedCircleModularMethod('circle_getAddressMapping'), true)
  assert.equal(isAllowedCircleModularMethod('pm_getPaymasterData'), true)
  assert.equal(isAllowedCircleModularMethod('debug_traceCall'), false)
  assert.equal(isAllowedCircleModularMethod('admin_stop'), false)
})

test('Circle Modular proxy normalizes an HTML upstream gateway failure to JSON-RPC', () => {
  const result = normalizeCircleModularResponse({ status: 502, contentType: 'text/html', text: '<html>secret upstream page</html>', id: 7 })
  assert.equal(result.status, 502)
  assert.equal(result.passthrough, false)
  assert.equal(result.body.jsonrpc, '2.0')
  assert.equal(result.body.id, 7)
  assert.equal(result.body.error.code, -32000)
  assert.equal(result.body.error.data.upstreamStatus, 502)
  assert.equal('preview' in result.body.error.data, false)
})

test('Circle Modular proxy normalizes malformed JSON content to JSON-RPC', () => {
  const result = normalizeCircleModularResponse({ status: 200, contentType: 'application/json', text: '{broken', id: 8 })
  assert.equal(result.status, 502)
  assert.equal(result.body.id, 8)
  assert.match(result.body.error.message, /invalid JSON-RPC/)
})

test('Circle Modular proxy rejects a plain JSON object that is not JSON-RPC', () => {
  const result = normalizeCircleModularResponse({ status: 200, contentType: 'application/json', text: '{}', id: 10 })
  assert.equal(result.status, 502)
  assert.equal(result.passthrough, false)
  assert.equal(result.body.id, 10)
  assert.match(result.body.error.message, /invalid JSON-RPC/)
})

test('Circle Modular proxy passes through valid JSON-RPC bodies unchanged', () => {
  const body = { jsonrpc: '2.0', id: 9, result: '0x4cef52' }
  const result = normalizeCircleModularResponse({ status: 200, contentType: 'application/json', text: JSON.stringify(body), id: 9 })
  assert.equal(result.status, 200)
  assert.equal(result.passthrough, true)
  assert.deepEqual(result.body, body)
})

test('Circle Modular proxy makes body-compatible status for valid JSON-RPC 204 responses', () => {
  const body = { jsonrpc: '2.0', id: 11, error: { code: -32000, message: 'pending' } }
  const result = normalizeCircleModularResponse({ status: 204, contentType: 'application/json', text: JSON.stringify(body), id: 11 })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, body)
})
