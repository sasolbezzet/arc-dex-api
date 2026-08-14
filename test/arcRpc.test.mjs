import test from 'node:test'
import assert from 'node:assert/strict'

const moduleUrl = '../src/config/arcRpc.mjs?rpc-test-' + Date.now()
const { ARC_RPC_LOG_CHUNK_SIZE, resolveArcRpc, arcRpcUrls, PUBLIC_ARC_RPC } = await import(moduleUrl)

test('Arc RPC resolver accepts an explicit Canteen environment endpoint', () => {
  assert.equal(resolveArcRpc({ preferCanteen: true, configuredRpc: 'https://canteen.example/rpc', canteenRpc: '', applicationRpc: 'https://application.example/rpc' }), 'https://canteen.example/rpc')
})

test('Arc RPC resolver uses application RPC when Canteen preference is disabled', () => {
  assert.equal(resolveArcRpc({ preferCanteen: false, configuredRpc: '', canteenRpc: 'https://canteen.example/rpc', applicationRpc: 'https://application.example/rpc' }), 'https://application.example/rpc')
})

test('Arc log scans use a conservative Canteen-safe chunk size', () => {
  assert.equal(ARC_RPC_LOG_CHUNK_SIZE, 2_000n)
})

test('Arc RPC fallback list contains only valid non-duplicate endpoints', () => {
  const urls = arcRpcUrls({ preferCanteen: true, configuredRpc: 'https://canteen.example/rpc', canteenRpc: '', applicationRpc: '' })
  assert.equal(urls[0], 'https://canteen.example/rpc')
  assert.ok(urls.includes(PUBLIC_ARC_RPC))
  assert.equal(new Set(urls).size, urls.length)
})
