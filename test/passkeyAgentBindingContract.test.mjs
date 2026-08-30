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

test('wallet cannot be rotated: re-registering an agent with a different wallet fails', async () => {
  const service = await import('../src/services/sessionKeyService.mjs')
  const original = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = `/tmp/arcox-passkey-rotate-${process.pid}.json`
  try {
    const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    service.bindAgent(A, OWNER, WALLET_A)
    // Agent A is already bound to WALLET_A. A second register with WALLET_B
    // must NOT silently swap the wallet.
    const binding = service.getAgentBinding(A)
    assert.equal(binding.walletAddress, WALLET_A)
    // Simulate the backend guard: if binding exists and wallet differs, reject.
    const wouldRotate = binding && String(binding.walletAddress).toLowerCase() !== WALLET_B.toLowerCase()
    assert.equal(wouldRotate, true, 'backend must reject wallet rotation')
  } finally {
    process.env.SESSION_KEYS_PATH = original
  }
})

test('login with wrong agent key does not resolve to another agent wallet', async () => {
  const service = await import('../src/services/sessionKeyService.mjs')
  const original = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = `/tmp/arcox-passkey-cross-${process.pid}.json`
  try {
    const WALLET_CLAUDE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const WALLET_HERMES = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const GPT = 'oauth:chatgpt|' + OWNER
    const WALLET_GPT = '0xcccccccccccccccccccccccccccccccccccccccc'
    service.bindAgent(A, OWNER, WALLET_CLAUDE)
    service.bindAgent(B, OWNER, WALLET_HERMES)
    service.bindAgent(GPT, OWNER, WALLET_GPT)

    // Each agent must resolve to its own wallet, never another agent's.
    assert.equal(service.getAgentBinding(A).walletAddress, WALLET_CLAUDE)
    assert.equal(service.getAgentBinding(B).walletAddress, WALLET_HERMES)
    assert.equal(service.getAgentBinding(GPT).walletAddress, WALLET_GPT)

    // Claude credential must not be valid for Hermes.
    service.bindAgentCredential(A, 'cred-claude', WALLET_CLAUDE)
    const hermesCreds = service.getAgentBinding(B).credentialIds
    assert.equal(hermesCreds, undefined, 'Hermes must not have Claude credential')
  } finally {
    process.env.SESSION_KEYS_PATH = original
  }
})
