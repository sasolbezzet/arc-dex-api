import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Tool yang dipakai halaman Plugin (dashboard agent Claude/ChatGPT): status
// Agent Wallet MSCA, status session key, dan info server. Handler-nya belum
// diuji langsung oleh suite lain — yang ada baru bentuk `tools/list`.
// Pagar penting: output status tidak boleh membawa materi kunci.
const tempDir = mkdtempSync(join(tmpdir(), 'mcp-plugin-tools-'))
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }))
process.env.VAULT_ACTIVITY_PATH = join(tempDir, 'activity.json')
writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
process.env.VAULT_SESSION_PATH = join(tempDir, 'vault-sessions.json')
writeFileSync(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
process.env.SESSION_KEYS_PATH = join(tempDir, 'session-keys.json')
process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
process.env.SERVER_URL = 'https://arcoxdex.vercel.app'

const EOA = '0x1111111111111111111111111111111111111111'
const MSCA = '0x2222222222222222222222222222222222222222'
const DELEGATE = '0x3333333333333333333333333333333333333333'

const textOf = result => JSON.parse(result.content[0].text)

// Setiap skenario menulis store-nya sendiri lalu memuat modul dengan query unik,
// sama seperti mcpIdentityBinding.test.mjs, supaya cache modul tidak bocor antar
// kasus (store dibaca sekali saat modul dimuat).
async function loadServer(store, options = {}) {
  writeFileSync(process.env.SESSION_KEYS_PATH, JSON.stringify(store))
  const mod = await import(`../src/services/mcpServer.mjs?plugin-${Date.now()}-${Math.random()}`)
  return mod.createMcpServer(EOA, options)
}

test('arcox_agent_status mengarahkan ke Plugin saat MSCA belum aktif', async () => {
  const server = await loadServer({ users: {}, aliases: {} })
  try {
    const result = textOf(await server._registeredTools.arcox_agent_status.handler({}))
    assert.equal(result.status, 'no_session')
    assert.equal(result.reason, 'no_session')
    assert.equal(result.rejected, true)
    assert.match(result.message, /Plugin page/)
  } finally {
    await server.close()
  }
})

test('arcox_session_status melaporkan belum aktif sebagai hasil normal', async () => {
  const server = await loadServer({ users: {}, aliases: {} })
  try {
    const result = textOf(await server._registeredTools.arcox_session_status.handler({}))
    assert.equal(result.active, false)
    assert.match(result.message, /Plugin page/)
  } finally {
    await server.close()
  }
})

test('arcox_agent_status mengembalikan MSCA terikat tanpa materi kunci', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ balances: { 'arc-mainnet': { status: 'ok', nativeBalance: '1' } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
  let server
  try {
    server = await loadServer({
      users: {
        [MSCA.toLowerCase()]: {
          walletAddress: MSCA,
          delegateAddress: DELEGATE,
          active: true,
          authorizationUserOpHash: '0x' + 'a'.repeat(64),
        },
      },
      aliases: {},
    }, { boundMscaWalletAddress: MSCA })
    const result = textOf(await server._registeredTools.arcox_agent_status.handler({}))
    assert.equal(result.status, 'active')
    assert.equal(result.active, true)
    assert.equal(result.walletAddress, MSCA)
    assert.equal(result.delegateAddress, DELEGATE)
    assert.deepEqual(result.balances, { 'arc-mainnet': { status: 'ok', nativeBalance: '1' } })
    assert.doesNotMatch(JSON.stringify(result), /privateKey|sessionKey|encryptedKey|authorizationUserOpHash/i)
  } finally {
    globalThis.fetch = previousFetch
    await server?.close()
  }
})

test('arcox_mcp_info tetap menyatakan server ini MSCA-only', async () => {
  const server = await loadServer({ users: {}, aliases: {} })
  try {
    const result = textOf(await server._registeredTools.arcox_mcp_info.handler({}))
    assert.equal(result.server, 'arcox-mcp')
    assert.ok(result.tool_count > 50, `tool terdaftar (${result.tool_count})`)
    assert.match(result.safety, /MSCA-ONLY/)
    assert.ok(result.services.includes('session_key'))
    assert.ok(result.execution_guide.swap.join(' ').includes('arcox_quote_swap'))
  } finally {
    await server.close()
  }
})
