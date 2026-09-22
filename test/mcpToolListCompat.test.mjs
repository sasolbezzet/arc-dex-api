import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Isolate the stores so creating an MCP server never touches real state.
const tempDir = mkdtempSync(join(tmpdir(), 'mcp-tool-list-compat-'))
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
process.env.VAULT_ACTIVITY_PATH = join(tempDir, 'activity.json')
writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
process.env.SERVER_URL = 'https://arcoxdex.vercel.app'

const { createMcpServer } = await import('../src/services/mcpServer.mjs')

const EOA = '0x19d0730c4a4b1c509eba5d59b6dc0d46bd3ac807'

async function listTools() {
  const server = createMcpServer(EOA, {
    agent: 'Grok',
    clientId: 'arcox_test-client',
    boundMscaWalletAddress: '0x73d76C53E5B9DdF4216B25A6765345f3d8a9178E',
  })
  const handler = server.server._requestHandlers.get('tools/list')
  assert.ok(handler, 'tools/list handler terdaftar')
  const result = await handler({ method: 'tools/list', params: {} }, {})
  await server.close()
  return result
}

test('tools/list tidak memuat field tasks-extension `execution`', async () => {
  const result = await listTools()
  assert.ok(Array.isArray(result.tools) && result.tools.length > 20, 'server mengekspos daftar tool')
  // Nilai `undefined` tidak ikut terserialisasi, jadi yang diperiksa adalah
  // nilai-nya bukan keberadaan key pada objek di memori.
  const offenders = result.tools.filter(tool => tool.execution !== undefined)
  assert.deepEqual(offenders.map(t => t.name), [], 'tidak ada tool dengan field execution')
  // Payload yang benar-benar dikirim ke klien juga harus bersih, karena klien
  // dengan skema ketat gagal mem-parse seluruh tools/list bila ada field asing.
  assert.ok(!JSON.stringify(result).includes('"execution"'), 'payload terserialisasi bersih')
  assert.ok(!JSON.stringify(result).includes('taskSupport'), 'taskSupport tidak ikut terkirim')
})

test('setiap tool tetap punya name + inputSchema yang valid', async () => {
  const result = await listTools()
  for (const tool of result.tools) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.inputSchema, 'object')
    assert.equal(tool.inputSchema.type, 'object')
  }
})

test('tool inti ARCOX tetap tersedia untuk agent Grok', async () => {
  const result = await listTools()
  const names = result.tools.map(t => t.name)
  for (const required of ['arcox_wallet_balances', 'arcox_quote_bridge', 'arcox_execute_bridge', 'arcox_agent_status']) {
    assert.ok(names.includes(required), `${required} ada di tools/list`)
  }
})
