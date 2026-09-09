import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentReadiness } from '../src/services/agentReadiness.mjs'

test('Hermes can have an active MCP token while execution is blocked by destination authorization', () => {
  const readiness = buildAgentReadiness({
    agentKey: 'arcox_conn_demo|0x1111111111111111111111111111111111111111',
    clientId: 'arcox_conn_demo',
    agentType: 'hermes',
    binding: { active: true },
    tokenActive: true,
    tokenExpiresAt: '2026-12-01T00:00:00.000Z',
    mcpSessionActive: true,
    sessionActive: true,
    chainAuthorizationStatus: {
      'arc-testnet': 'authorized',
      'base-sepolia': 'failed',
      'arbitrum-sepolia': 'authorized',
    },
  })

  assert.equal(readiness.mcp.connected, true)
  assert.equal(readiness.execution.ready, false)
  assert.equal(readiness.execution.reason, 'destination_session_not_authorized')
  assert.equal(readiness.execution.destinations['base-sepolia'], false)
})

test('revocation blocks execution without changing MCP token observability', () => {
  const readiness = buildAgentReadiness({
    agentKey: 'arcox_conn_demo|0x1111111111111111111111111111111111111111',
    clientId: 'arcox_conn_demo',
    agentType: 'hermes',
    binding: { active: false },
    tokenActive: true,
    mcpSessionActive: true,
    sessionActive: true,
    chainAuthorizationStatus: {
      'arc-testnet': 'authorized',
      'base-sepolia': 'authorized',
      'arbitrum-sepolia': 'authorized',
    },
  })

  assert.equal(readiness.mcp.connected, true)
  assert.equal(readiness.execution.ready, false)
  assert.equal(readiness.execution.reason, 'agent_binding_revoked')
})

test('Claude and ChatGPT readiness remains isolated by agent key', () => {
  const base = {
    binding: { active: true },
    tokenActive: true,
    mcpSessionActive: true,
    sessionActive: true,
    chainAuthorizationStatus: {
      'arc-testnet': 'authorized',
      'base-sepolia': 'authorized',
      'arbitrum-sepolia': 'authorized',
    },
  }
  const claude = buildAgentReadiness({ ...base, agentKey: 'claude|0x1111', clientId: 'claude', agentType: 'claude' })
  const chatgpt = buildAgentReadiness({ ...base, agentKey: 'chatgpt|0x1111', clientId: 'chatgpt', agentType: 'chatgpt' })
  assert.equal(claude.execution.ready, true)
  assert.equal(chatgpt.execution.ready, true)
  assert.notEqual(claude.agentKey, chatgpt.agentKey)
  assert.notEqual(claude.clientId, chatgpt.clientId)
})

test('readiness never becomes execution-ready without an active session or Arc authorization', () => {
  const noSession = buildAgentReadiness({
    agentKey: 'arcox_conn_demo|0x1111111111111111111111111111111111111111',
    clientId: 'arcox_conn_demo',
    agentType: 'hermes',
    binding: { active: true },
    tokenActive: true,
    sessionActive: false,
    chainAuthorizationStatus: {
      'arc-testnet': 'authorized',
      'base-sepolia': 'authorized',
      'arbitrum-sepolia': 'authorized',
    },
  })
  assert.equal(noSession.execution.ready, false)
  assert.equal(noSession.execution.reason, 'session_inactive')

  const noArcAuthorization = buildAgentReadiness({
    agentKey: 'arcox_conn_demo|0x1111111111111111111111111111111111111111',
    clientId: 'arcox_conn_demo',
    agentType: 'hermes',
    binding: { active: true },
    tokenActive: true,
    sessionActive: true,
    chainAuthorizationStatus: {
      'arc-testnet': 'failed',
      'base-sepolia': 'authorized',
      'arbitrum-sepolia': 'authorized',
    },
  })
  assert.equal(noArcAuthorization.execution.ready, false)
  assert.equal(noArcAuthorization.execution.reason, 'arc_session_not_authorized')
})
