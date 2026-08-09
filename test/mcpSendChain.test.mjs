import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EOA = '0x1111111111111111111111111111111111111111'
const MSCA = '0x2222222222222222222222222222222222222222'
const DELEGATE = '0x3333333333333333333333333333333333333333'

async function withSessionStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-send-chain-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA,
        delegateAddress: DELEGATE,
        active: true,
        chain: 'base-sepolia',
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
        authorizationUserOpHashes: { 'base-sepolia': '0x' + 'b'.repeat(64) },
      },
    },
    aliases: { [EOA.toLowerCase()]: MSCA },
  }), 'utf8')
  try {
    const { createMcpServer } = await import('../src/services/mcpServer.mjs?send-chain-' + Date.now() + '-' + Math.random())
    return await fn(createMcpServer(EOA, { agent: 'claude-mcp' }))
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    await rm(dir, { recursive: true, force: true })
  }
}

function resultOf(response) {
  return JSON.parse(response.content[0].text)
}

test('send quote rejects missing or unsupported chain instead of falling back to Arc', async () => {
  await withSessionStore(async server => {
    const missing = resultOf(await server._registeredTools.arcox_quote_send.handler({
      to: EOA, amount: '0.1', token: 'USDC', source: 'session',
    }))
    assert.equal(missing.rejected, true)
    assert.equal(missing.reason, 'unsupported_chain')

    const unsupported = resultOf(await server._registeredTools.arcox_quote_send.handler({
      to: EOA, amount: '0.1', token: 'USDC', fromChain: 'base-mainnet', source: 'session',
    }))
    assert.equal(unsupported.rejected, true)
    assert.equal(unsupported.reason, 'unsupported_chain')
  })
})

test('send quote includes canonical chain in preview and binds it to execution quote', async () => {
  await withSessionStore(async server => {
    const preview = resultOf(await server._registeredTools.arcox_quote_send.handler({
      to: EOA, amount: '0.1', token: 'USDC', fromChain: 'base_sepolia', source: 'session',
    }))
    assert.equal(preview.schemaVersion, 1)
    assert.equal(preview.preview, true)
    assert.equal(preview.action, 'send')
    assert.equal(preview.fromChain, 'base-sepolia')
    assert.equal(preview.chain, 'base-sepolia')
    assert.ok(preview.previewId)
  })
})

test('session send denies an unauthorized chain before any UserOperation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-send-auth-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA, delegateAddress: DELEGATE, active: true, chain: 'base-sepolia',
        authorizationUserOpHash: '0x' + 'a'.repeat(64), authorizationUserOpHashes: {},
      },
    }, aliases: { [EOA.toLowerCase()]: MSCA },
  }), 'utf8')
  try {
    const { sendViaSession } = await import('../src/services/sessionKeyService.mjs?send-auth-' + Date.now() + '-' + Math.random())
    const result = await sendViaSession(EOA, EOA, '0.1', 'USDC', { chainKey: 'base-sepolia' })
    assert.equal(result.status, 'denied')
    assert.equal(result.reason, 'session_chain_not_authorized')
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    await rm(dir, { recursive: true, force: true })
  }
})
