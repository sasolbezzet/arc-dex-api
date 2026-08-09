import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EOA = '0x1111111111111111111111111111111111111111'
const MSCA = '0x2222222222222222222222222222222222222222'
const DELEGATE = '0x3333333333333333333333333333333333333333'

test('intel token aliases are normalized before x402 resource lookup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-intel-alias-'))
  const previousSessionPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousBackend = process.env.ARCOX_BACKEND_URL
  const previousFetch = globalThis.fetch
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.ARCOX_BACKEND_URL = 'http://intel.test'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA, delegateAddress: DELEGATE, active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    },
    aliases: { [EOA.toLowerCase()]: MSCA },
  }), 'utf8')
  let requestedUrl = ''
  globalThis.fetch = async url => {
    requestedUrl = String(url)
    return new Response(JSON.stringify({ ok: true, symbol: 'BTC' }), { status: 200 })
  }
  try {
    const { createMcpServer } = await import('../src/services/mcpServer.mjs?intel-alias-' + Date.now() + '-' + Math.random())
    const server = createMcpServer(EOA)
    const response = await server._registeredTools.arcox_intel_get_token.handler({ id: 'BTC' })
    assert.equal(JSON.parse(response.content[0].text).symbol, 'BTC')
    assert.match(requestedUrl, /\/api\/intel\/token\/bitcoin$/)
  } finally {
    globalThis.fetch = previousFetch
    if (previousSessionPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousSessionPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousBackend === undefined) delete process.env.ARCOX_BACKEND_URL
    else process.env.ARCOX_BACKEND_URL = previousBackend
    await rm(dir, { recursive: true, force: true })
  }
})
