import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Isolate every store so the test never touches real state.
const tempDir = mkdtempSync(join(tmpdir(), 'mcp-unknown-session-'))
process.env.VAULT_PATH = join(tempDir, 'vault.json')
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [], sessionKeys: {} }))
process.env.VAULT_ACTIVITY_PATH = join(tempDir, 'activity.json')
writeFileSync(process.env.VAULT_ACTIVITY_PATH, '[]')
process.env.VAULT_SESSION_PATH = join(tempDir, 'vault-sessions.json')
writeFileSync(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }))
process.env.SESSION_KEYS_PATH = join(tempDir, 'session-keys.json')
writeFileSync(process.env.SESSION_KEYS_PATH, JSON.stringify({ keys: {} }))
process.env.OAUTH_PATH = join(tempDir, 'oauth-clients.json')
process.env.OAUTH_TOKENS_PATH = join(tempDir, 'oauth-tokens.json')
process.env.OAUTH_STATE_PATH = join(tempDir, 'oauth-state.json')
process.env.SUPABASE_PERSISTENCE_MODE = 'off'
process.env.SERVER_URL = 'https://arcoxdex.vercel.app'

const { mcpHttpHandler, issueConnectionToken } = await import('../src/services/mcpServer.mjs')

const OWNER = '0x19d0730c4a4b1c509eba5d59b6dc0d46bd3ac807'
const MSCA = '0x73d76c53e5b9ddf4216b25a6765345f3d8a9178e'
const STALE_SESSION = '11111111-2222-3333-4444-555555555555'

// Minimal Express compatibility on top of a real Node server response: the
// handler answers authentication and session errors with res.status().json(),
// while the SDK transport streams through the plain Node response.
function startServer() {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        req.body = body ? JSON.parse(body) : undefined
        res.status = code => { res.statusCode = code; return res }
        res.json = payload => {
          if (!res.headersSent) res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(payload))
          return res
        }
        mcpHttpHandler(req, res).catch(() => {
          if (!res.headersSent) res.statusCode = 500
          res.end()
        })
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const { server, port } = await startServer()
const endpoint = `http://127.0.0.1:${port}/mcp`
const { token } = issueConnectionToken({ agentKey: 'arcox_conn_test|' + OWNER, clientName: 'Grok', userId: OWNER, mscaWalletAddress: MSCA })

function call(body, { sessionId, accept = 'application/json', method = 'POST' } = {}) {
  return fetch(endpoint, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
}

const toolsListCall = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

test('tools/list tanpa Mcp-Session-Id tetap dilayani (klien stateless)', async () => {
  const res = await call(toolsListCall)
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.ok(payload.result.tools.length > 20, 'daftar tool tersedia')
})

test('tools/list dengan Mcp-Session-Id yang tidak dikenal tetap dilayani', async () => {
  // Grok menutup sesinya sendiri (DELETE /mcp) di akhir setiap discovery, dan
  // restart backend mengosongkan peta sesi. Request berikutnya memakai id mati
  // ini; sebelumnya dibalas `400 Bad Request: Server not initialized`.
  const res = await call(toolsListCall, { sessionId: STALE_SESSION })
  assert.equal(res.status, 200, 'bukan 400 Server not initialized')
  const payload = await res.json()
  assert.ok(payload.result.tools.length > 20, 'tool tetap terbaca setelah sesi mati')
})

test('tools/call dengan Mcp-Session-Id yang tidak dikenal tidak lagi gagal total', async () => {
  const res = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'arcox_mcp_info', arguments: {} } }, { sessionId: STALE_SESSION })
  assert.equal(res.status, 200)
  const payload = await res.json()
  assert.equal(payload.error, undefined, payload.error?.message)
  assert.ok(payload.result, 'hasil tool tersedia')
})

test('GET dengan Mcp-Session-Id yang tidak dikenal dijawab 404 agar klien re-initialize', async () => {
  const res = await call(undefined, { sessionId: STALE_SESSION, accept: 'application/json, text/event-stream', method: 'GET' })
  assert.equal(res.status, 404)
  const payload = await res.json()
  assert.equal(payload.error.code, -32001)
})

test('session id yang masih hidup tetap dipakai ulang tanpa initialize baru', async () => {
  const init = await call({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'grok-connectors-manager', version: '0.1.0' } },
  }, { accept: 'application/json, text/event-stream' })
  assert.equal(init.status, 200)
  const sessionId = init.headers.get('mcp-session-id')
  assert.ok(sessionId, 'initialize membalas Mcp-Session-Id')
  const res = await call(toolsListCall, { sessionId })
  assert.equal(res.status, 200)
  // A session created with an SSE-capable Accept keeps streaming that way, so
  // the assertion accepts either framing.
  const raw = (await res.text()).replace(/^event: message\ndata: /, '').trim()
  const payload = JSON.parse(raw)
  assert.ok(payload.result.tools.length > 20)
})

test.after(() => server.close())
