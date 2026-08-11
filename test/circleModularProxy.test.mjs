import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCircleModularTarget, circleModularProxyHeaders, isAllowedCircleModularMethod } from '../src/services/circleModularProxy.mjs'

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
