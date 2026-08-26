import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'arcox-purge-'))
  const clients = join(root, 'oauth-clients.json')
  const tokens = join(root, 'oauth-tokens.json')
  const expired = Date.now() - 31 * 24 * 60 * 60 * 1000
  const state = {
    clients: {
      'client-test': { clientName: 'mcp-oauth', clientSecret: 'secret' },
      'client-live': { clientName: 'real-user', clientSecret: 'secret' },
    },
  }
  const tokenState = {
    tokens: {
      'access-test': { clientId: 'client-test', expires: expired },
      'access-live-user': { clientId: 'client-live', expires: expired },
    },
    refresh: {
      'refresh-test': { clientId: 'client-test', expires: expired },
      'refresh-live-user': { clientId: 'client-live', expires: expired },
    },
  }
  writeFileSync(clients, JSON.stringify(state, null, 2))
  writeFileSync(tokens, JSON.stringify(tokenState, null, 2))
  return { root, clients, tokens, state, tokenState }
}

function run(clients, tokens, args = []) {
  return execFileSync(process.execPath, ['scripts/purge-test-oauth-state.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, OAUTH_PATH: clients, OAUTH_TOKENS_PATH: tokens },
    encoding: 'utf8',
  })
}

test('OAuth purge defaults to read-only dry-run', () => {
  const { clients, tokens, state, tokenState } = fixture()
  const output = run(clients, tokens)
  assert.match(output, /DRY-RUN/)
  assert.match(output, /mcp-oauth/)
  assert.deepEqual(JSON.parse(readFileSync(clients, 'utf8')), state)
  assert.deepEqual(JSON.parse(readFileSync(tokens, 'utf8')), tokenState)
})

test('OAuth purge requires explicit confirmation and whitelist before apply', () => {
  const { root, clients, tokens } = fixture()
  assert.throws(() => run(clients, tokens, ['--apply', '--confirm', 'PURGE']), /missing --allow-client client-test/)
  run(clients, tokens, [
    '--apply', '--confirm', 'PURGE',
    '--allow-client', 'client-test',
    '--allow-client', 'client-live',
  ])
  const afterClients = JSON.parse(readFileSync(clients, 'utf8'))
  const afterTokens = JSON.parse(readFileSync(tokens, 'utf8'))
  assert.equal(afterClients.clients['client-test'], undefined)
  assert.equal(afterClients.clients['client-live'].clientName, 'real-user')
  assert.deepEqual(afterTokens.tokens, {})
  assert.deepEqual(afterTokens.refresh, {})
  assert.equal(readdirSync(root).filter(file => file.startsWith('oauth-clients.json.pre-purge-')).length, 1)
  assert.equal(readdirSync(root).filter(file => file.startsWith('oauth-tokens.json.pre-purge-')).length, 1)
  assert.equal(existsSync(clients), true)
})
