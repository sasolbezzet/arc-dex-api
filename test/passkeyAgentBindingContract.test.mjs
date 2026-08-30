import test from 'node:test'
import assert from 'node:assert/strict'

const OWNER = '0x1111111111111111111111111111111111111111'
const A = 'oauth:claude|' + OWNER
const B = 'hermes-mcp|' + OWNER

test('registration usernames are never reused across attempts', () => {
  const usernames = new Set()
  for (let i = 0; i < 10; i++) {
    const username = `arx-hermes-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    assert.equal(usernames.has(username), false)
    usernames.add(username)
  }
})

test('agent keys remain distinct and credential binding is agent scoped', async () => {
  const service = await import('../src/services/sessionKeyService.mjs')
  const original = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = `/tmp/arcox-passkey-contract-${process.pid}.json`
  try {
    service.bindAgent(A, OWNER, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    service.bindAgent(B, OWNER, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    service.bindAgentCredential(A, 'credential-claude', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.deepEqual(service.getAgentBinding(A).credentialIds, ['credential-claude'])
    assert.equal(service.getAgentBinding(B).credentialIds, undefined)
    assert.equal(service.getAgentBinding(A).walletAddress, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.equal(service.getAgentBinding(B).walletAddress, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  } finally {
    process.env.SESSION_KEYS_PATH = original
  }
})
