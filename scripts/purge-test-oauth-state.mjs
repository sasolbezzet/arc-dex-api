#!/usr/bin/env node
/**
 * Review and optionally purge known test OAuth state.
 *
 * Safe default: read-only dry-run. Apply requires both:
 *   node scripts/purge-test-oauth-state.mjs --apply --confirm PURGE \
 *     --allow-client <clientId> [--allow-token <tokenId>]
 *
 * Never prints token values. Paths are environment-overridable so this can be
 * tested against a temporary directory instead of the production data store.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const confirmation = valueAfter('--confirm')
const allowedClients = new Set(valuesAfter('--allow-client'))
const allowedTokens = new Set(valuesAfter('--allow-token'))
const clientPath = process.env.OAUTH_PATH || './data/oauth-clients.json'
const tokenPath = process.env.OAUTH_TOKENS_PATH || './data/oauth-tokens.json'
const now = Date.now()
const oldAccessCutoff = now - 30 * 24 * 60 * 60 * 1000
const testName = /^(mcp-oauth|mcp-resource|good)$/

const clientsStore = readJson(clientPath, { clients: {} })
const tokensStore = readJson(tokenPath, { tokens: {}, refresh: {} })
const clients = clientsStore.clients && typeof clientsStore.clients === 'object' ? clientsStore.clients : {}
const access = tokensStore.tokens && typeof tokensStore.tokens === 'object' ? tokensStore.tokens : {}
const refresh = tokensStore.refresh && typeof tokensStore.refresh === 'object' ? tokensStore.refresh : {}
const liveAccessClients = new Set(Object.values(access)
  .filter(auth => Number(auth?.expires || 0) > now)
  .map(auth => String(auth.clientId || '')))

const clientCandidates = []
for (const [clientId, client] of Object.entries(clients)) {
  if (testName.test(String(client?.clientName || ''))) {
    clientCandidates.push({ kind: 'client', id: clientId, clientId, name: client.clientName, reason: 'test_client_name' })
  }
}

const tokenCandidates = []
for (const [tokenId, auth] of Object.entries(refresh)) {
  if (!liveAccessClients.has(String(auth?.clientId || ''))) {
    tokenCandidates.push({ kind: 'refresh', id: tokenId, clientId: String(auth?.clientId || ''), reason: 'refresh_without_live_access' })
  }
}
for (const [tokenId, auth] of Object.entries(access)) {
  const expires = Number(auth?.expires || 0)
  if (expires > 0 && expires < oldAccessCutoff) {
    tokenCandidates.push({ kind: 'access', id: tokenId, clientId: String(auth?.clientId || ''), reason: 'access_expired_over_30_days' })
  }
}

const candidates = [...clientCandidates, ...tokenCandidates]
const clientIdsToRemove = new Set(clientCandidates.map(item => item.clientId))
const accessIdsToRemove = new Set()
const refreshIdsToRemove = new Set()
for (const item of tokenCandidates) {
  if (allowedTokens.has(item.id) || allowedClients.has(item.clientId) || clientIdsToRemove.has(item.clientId)) {
    if (item.kind === 'access') accessIdsToRemove.add(item.id)
    else refreshIdsToRemove.add(item.id)
  }
}
for (const [tokenId, auth] of Object.entries(access)) {
  if (clientIdsToRemove.has(String(auth?.clientId || ''))) accessIdsToRemove.add(tokenId)
}
for (const [tokenId, auth] of Object.entries(refresh)) {
  if (clientIdsToRemove.has(String(auth?.clientId || ''))) refreshIdsToRemove.add(tokenId)
}

console.log(`OAuth purge ${apply ? 'APPLY' : 'DRY-RUN'}`)
console.log(`Clients file: ${clientPath}`)
console.log(`Tokens file: ${tokenPath}`)
console.log(`Candidates: ${candidates.length}`)
for (const item of clientCandidates) console.log(`  CLIENT ${item.id} (${item.name}) — ${item.reason}`)
for (const item of tokenCandidates) console.log(`  ${item.kind.toUpperCase()} ${maskId(item.id)} client=${item.clientId || '(none)'} — ${item.reason}`)

if (!apply) {
  console.log('\nNo files changed. Review this list, then provide explicit --allow-client/--allow-token and --confirm PURGE before apply.')
  process.exit(0)
}

if (confirmation !== 'PURGE') fail('Refusing apply: add --confirm PURGE after reviewing the dry-run.')
const missingClients = clientCandidates.filter(item => !allowedClients.has(item.clientId))
const missingTokens = tokenCandidates.filter(item => !clientIdsToRemove.has(item.clientId) && !allowedClients.has(item.clientId) && !allowedTokens.has(item.id))
if (missingClients.length || missingTokens.length) {
  console.error('Refusing apply: every candidate needs an explicit client/token whitelist.')
  for (const item of missingClients) console.error(`  missing --allow-client ${item.clientId}`)
  for (const item of missingTokens) console.error(`  missing --allow-token ${item.id}`)
  process.exit(2)
}
if (!candidates.length) {
  console.log('Nothing to purge.')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
backup(clientPath, stamp)
backup(tokenPath, stamp)
const nextClients = { ...clients }
for (const clientId of clientIdsToRemove) delete nextClients[clientId]
const nextAccess = { ...access }
for (const tokenId of accessIdsToRemove) delete nextAccess[tokenId]
const nextRefresh = { ...refresh }
for (const tokenId of refreshIdsToRemove) delete nextRefresh[tokenId]
writeJson(clientPath, { ...clientsStore, clients: nextClients })
writeJson(tokenPath, { ...tokensStore, tokens: nextAccess, refresh: nextRefresh })
console.log(`Applied. Removed clients=${clientIdsToRemove.size}, access=${accessIdsToRemove.size}, refresh=${refreshIdsToRemove.size}. Backups suffix=.pre-purge-${stamp}`)

function valueAfter(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] || '' : ''
}

function valuesAfter(flag) {
  const values = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1])
  }
  return values
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) { fail(`Cannot parse ${path}: ${error.message}`) }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

function backup(path, stamp) {
  if (!existsSync(path)) fail(`Cannot back up missing file: ${path}`)
  const destination = `${path}.pre-purge-${stamp}`
  copyFileSync(path, destination)
  console.log(`Backup: ${basename(destination)}`)
}

function maskId(value) {
  const text = String(value || '')
  if (text.length <= 12) return '<redacted>'
  return `${text.slice(0, 8)}…${text.slice(-6)}`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
