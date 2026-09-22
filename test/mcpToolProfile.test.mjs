import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDir = mkdtempSync(join(tmpdir(), 'mcp-tool-profile-'))
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
process.env.VAULT_ACTIVITY_PATH = join(tempDir, 'activity.json')
writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
process.env.SERVER_URL = 'https://arcoxdex.vercel.app'

const { createMcpServer, resolveToolProfile } = await import('../src/services/mcpServer.mjs')

const EOA = '0x19d0730c4a4b1c509eba5d59b6dc0d46bd3ac807'

async function toolNames(toolProfile) {
  const server = createMcpServer(EOA, {
    agent: 'Grok',
    clientId: 'arcox_test-client',
    boundMscaWalletAddress: '0x73d76C53E5B9DdF4216B25A6765345f3d8a9178E',
    toolProfile,
  })
  const handler = server.server._requestHandlers.get('tools/list')
  const result = await handler({ method: 'tools/list', params: {} }, {})
  await server.close()
  return result.tools.map(tool => tool.name)
}

test('profil default mengembalikan seluruh tool', async () => {
  const names = await toolNames('')
  assert.ok(names.length > 80, `daftar penuh tersedia (${names.length})`)
  assert.ok(names.includes('arcox_intel_get_polymarket'), 'tool intel lengkap ikut')
  assert.ok(names.includes('arcox_card_spend'), 'tool card ikut')
})

test('profil lite hanya mengekspos tool inti transaksi', async () => {
  const names = await toolNames('lite')
  assert.ok(names.length >= 10 && names.length <= 20, `daftar ringkas (${names.length})`)
  assert.deepEqual([...names].sort(), [
    'arcox_bridge_status', 'arcox_execute_bridge', 'arcox_execute_send', 'arcox_execute_swap',
    'arcox_get_request', 'arcox_mcp_info', 'arcox_quote_bridge', 'arcox_quote_send', 'arcox_quote_swap',
    'arcox_route_status', 'arcox_search_docs', 'arcox_session_status', 'arcox_wallet_balances',
  ])
  assert.ok(!names.some(name => name.startsWith('arcox_intel_')), 'tanpa tool intel berbayar')
})

test('profil core memuat intel dasar dan card, bukan tool mahal lain', async () => {
  const names = await toolNames('core')
  assert.ok(names.includes('arcox_intel_get_address'), 'intel dasar tersedia')
  assert.ok(names.includes('arcox_card_spend'), 'card spend tersedia')
  assert.ok(!names.includes('arcox_card_fund'), 'card fund tidak diekspos di core')
  assert.ok(names.length < 45, `masih jauh lebih kecil dari daftar penuh (${names.length})`)
})

test('quote dan execute selalu berpasangan di setiap profil', async () => {
  for (const profile of ['lite', 'core']) {
    const names = await toolNames(profile)
    for (const action of ['swap', 'bridge', 'send']) {
      assert.ok(names.includes(`arcox_quote_${action}`), `quote ${action} ada di ${profile}`)
      assert.ok(names.includes(`arcox_execute_${action}`), `execute ${action} ada di ${profile}`)
    }
  }
})

test('nama profil tak dikenal jatuh kembali ke daftar penuh', async () => {
  assert.equal(resolveToolProfile('turbo').name, 'full')
  assert.equal(resolveToolProfile('LITE').name, 'lite')
  const names = await toolNames('turbo')
  assert.ok(names.length > 80, 'profil tidak dikenal tidak memotong tool')
})
