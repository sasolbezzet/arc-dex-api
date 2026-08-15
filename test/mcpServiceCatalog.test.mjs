import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The metadata/doc tools are self-contained; the owner-scoped and payment
// tools need a real backend, so here we assert registration + deterministic
// read-only behavior only.
async function freshServer() {
  const dir = mkdtempSync(join(tmpdir(), 'arcox-catalog-'))
  const previous = {
    keys: process.env.SESSION_KEYS_PATH,
    vault: process.env.VAULT_PATH,
    enc: process.env.SESSION_KEY_ENCRYPTION_KEY,
  }
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'vault-activity.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  writeFileSync(process.env.SESSION_KEYS_PATH, JSON.stringify({ users: {}, aliases: {} }))
  writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
  writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
  const { createMcpServer } = await import('../src/services/mcpServer.mjs?catalog-' + Date.now() + '-' + Math.random())
  const server = createMcpServer('0x1111111111111111111111111111111111111111', {})
  const cleanup = () => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { server, cleanup }
}

test('plugin registers the ported arcox-mcp service tools', async () => {
  const { server, cleanup } = await freshServer()
  try {
    const names = Object.keys(server._registeredTools)
    const required = [
      'arcox_search_docs', 'arcox_read_doc', 'arcox_service_catalog', 'arcox_catalog',
      'arcox_execution_guide', 'arcox_ui_map', 'arcox_action_plan', 'arcox_agent_status',
      'arcox_create_payment_request', 'arcox_get_payment_request', 'arcox_quote_payment_request',
      'arcox_pay_payment_request', 'arcox_check_payment_status',
      'arcox_pay_get_payment_status', 'arcox_pay_list_recent_payments',
      'arcox_intel_quote_wallet_report', 'arcox_intel_execute_wallet_report',
      'get_ai_router_status', 'list_agent_identities', 'select_agent_identity',
      'get_ai_router_api_keys', 'create_ai_api_key', 'revoke_ai_api_key',
      'list_ai_models', 'get_usage_logs', 'call_ai_model', 'list_agent_jobs', 'create_agent_job',
    ]
    for (const name of required) assert.ok(names.includes(name), `missing ${name}`)
  } finally { cleanup() }
})

test('docs search and read doc return deterministic results', async () => {
  const { server, cleanup } = await freshServer()
  try {
    const search = JSON.parse((await server._registeredTools.arcox_search_docs.handler({ query: 'bridge retry' })).content[0].text)
    assert.ok(search.results.length >= 1)
    assert.equal(search.results[0].id, 'bridge-retry')
    const doc = JSON.parse((await server._registeredTools.arcox_read_doc.handler({ id: 'bridge-retry' })).content[0].text)
    assert.match(doc.body, /retry mint/)
    const missing = JSON.parse((await server._registeredTools.arcox_read_doc.handler({ id: 'nope' })).content[0].text)
    assert.match(missing.error, /Unknown ARCOX doc id/)
  } finally { cleanup() }
})

test('service catalog, execution guide, ui map, and action plan respond', async () => {
  const { server, cleanup } = await freshServer()
  try {
    const catalog = JSON.parse((await server._registeredTools.arcox_service_catalog.handler({})).content[0].text)
    assert.ok(Array.isArray(catalog.services) && catalog.services.length >= 6)
    const alias = JSON.parse((await server._registeredTools.arcox_catalog.handler({})).content[0].text)
    assert.equal(alias.project, catalog.project)
    const guide = JSON.parse((await server._registeredTools.arcox_execution_guide.handler({ intent: 'bridge' })).content[0].text)
    assert.ok(guide.flows.length >= 1 && guide.flows[0].intent === 'bridge')
    const ui = JSON.parse((await server._registeredTools.arcox_ui_map.handler({})).content[0].text)
    assert.ok(Array.isArray(ui.pages) && ui.pages.some(p => p.id === 'bridge'))
    const plan = JSON.parse((await server._registeredTools.arcox_action_plan.handler({ intent: 'bridge 1 usdc arc ke base' })).content[0].text)
    assert.equal(plan.status, 'planned')
    assert.ok(plan.matchedAction.id === 'bridge')
  } finally { cleanup() }
})

test('legacy pay compatibility tools return disabled guidance', async () => {
  const { server, cleanup } = await freshServer()
  try {
    const status = JSON.parse((await server._registeredTools.arcox_pay_get_payment_status.handler({ payment_id: 'x' })).content[0].text)
    assert.equal(status.status, 'disabled')
    const list = JSON.parse((await server._registeredTools.arcox_pay_list_recent_payments.handler({})).content[0].text)
    assert.equal(list.status, 'disabled')
  } finally { cleanup() }
})

test('agent job and ai model tools fail closed without an API key', async () => {
  const { server, cleanup } = await freshServer()
  try {
    const jobs = JSON.parse((await server._registeredTools.list_agent_jobs.handler({})).content[0].text)
    assert.match(jobs.error, /API key required/)
    const model = JSON.parse((await server._registeredTools.call_ai_model.handler({ prompt: 'hi' })).content[0].text)
    assert.match(model.error, /API key is required/)
  } finally { cleanup() }
})
