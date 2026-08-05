import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { randomUUID } from 'crypto'

const VAULT_PATH = process.env.VAULT_PATH || './data/vault.json'
const ACTIVITY_PATH = process.env.VAULT_ACTIVITY_PATH || './data/vault-activity.json'
const SESSION_PATH = process.env.VAULT_SESSION_PATH || './data/vault-sessions.json'

// ── Session tokens (persisted to disk, TTL 24h) ──
// Backend session tokens used to live only in memory, so every backend restart
// (systemd Restart=always, cron */5 restart-if-down) silently logged every user
// out — the frontend held a token the server no longer knew and got 401 on the
// vault deep-link. Persisting them to a JSON file survives restarts.
const SESSION_TTL_MS = 86400000 // 24h
function loadSessions() {
  const data = readJsonFile(SESSION_PATH, { tokens: {} })
  const map = new Map(Object.entries(data.tokens || {}))
  // Drop anything already expired at load time.
  const now = Date.now()
  let changed = false
  for (const [tok, s] of map) {
    if (!s || now > s.expires) { map.delete(tok); changed = true }
  }
  if (changed) persistSessions(map)
  return map
}
function persistSessions(map) {
  atomicWriteJsonFile(SESSION_PATH, { tokens: Object.fromEntries(map) })
}
const sessionTokens = loadSessions() // token -> { userId, expires }

export function createSession(userId) {
  const token = 'arx_vs_' + randomUUID().replace(/-/g, '')
  sessionTokens.set(token, { userId, expires: Date.now() + SESSION_TTL_MS })
  persistSessions(sessionTokens)
  return token
}

export function validateSession(token) {
  const s = sessionTokens.get(token)
  if (!s) return null
  if (Date.now() > s.expires) { sessionTokens.delete(token); persistSessions(sessionTokens); return null }
  return s.userId
}

// ── Pending SIWE challenges (in-memory, TTL 5 min) ──
const challenges = new Map() // nonce -> { address, message, expires }
export function createChallenge(address) {
  const nonce = randomUUID().slice(0, 8)
  const domain = 'arcoxdex.vercel.app'
  const message = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nAuthorize ARCOX Vault Access\n\nURI: https://arcoxdex.vercel.app\nVersion: 1\nChain ID: 5042002\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`
  challenges.set(nonce, { address: address.toLowerCase(), message, expires: Date.now() + 300000 })
  return { nonce, message }
}
export function getChallenge(nonce) {
  const c = challenges.get(nonce)
  if (!c) return null
  if (Date.now() > c.expires) { challenges.delete(nonce); return null }
  return c
}
export function consumeChallenge(nonce) {
  const c = challenges.get(nonce)
  challenges.delete(nonce)
  return c
}

// ── MCP session tracking ──
const mcpSessions = new Map() // userId -> [{ clientId, agent, connectedAt, lastActivity }]
export function registerMcpSession(userId, clientId, agent) {
  if (!mcpSessions.has(userId)) mcpSessions.set(userId, [])
  const sessions = mcpSessions.get(userId)
  const existing = sessions.find(s => s.clientId === clientId)
  if (existing) {
    existing.lastActivity = Date.now()
    existing.active = true
  } else {
    sessions.push({ clientId, agent, connectedAt: Date.now(), lastActivity: Date.now(), active: true })
  }
}
export function listMcpSessions(userId) {
  return mcpSessions.get(userId) || []
}

// ── Helpers ──
function loadVault() {
  return readJsonFile(VAULT_PATH, { credentials: [], limits: {}, approvals: [] })
}
function saveVault(v) {
  atomicWriteJsonFile(VAULT_PATH, v)
}
function loadActivity() {
  return readJsonFile(ACTIVITY_PATH, [])
}
function saveActivity(a) {
  // Keep last 500 entries
  if (a.length > 500) a = a.slice(-500)
  atomicWriteJsonFile(ACTIVITY_PATH, a)
}

// ── Credentials ──
// Each credential: { id, type, label, value (masked), createdAt }
// type: 'eoa' | 'circle' | 'solana' | 'api_key'
// Wallet credentials auto-registered from frontend. API key credentials manually added.

export function listCredentials(owner) {
  const v = loadVault()
  return v.credentials
    .filter(c => c.owner === owner)
    .map(c => ({ ...c, value: maskValue(c.value) }))
}

export function addCredential(owner, { type, label, value }) {
  const v = loadVault()
  const cred = { id: randomUUID(), owner, type, label, value, createdAt: Date.now() }
  v.credentials.push(cred)
  saveVault(v)
  logActivity(owner, 'credential_added', { type, label })
  return { ...cred, value: maskValue(cred.value) }
}

export function revealCredential(owner, id) {
  const v = loadVault()
  const cred = v.credentials.find(c => c.owner === owner && c.id === id)
  if (!cred) return null
  logActivity(owner, 'credential_revealed', { id, label: cred.label })
  return cred
}

export function deleteCredential(owner, id) {
  const v = loadVault()
  const idx = v.credentials.findIndex(c => c.owner === owner && c.id === id)
  if (idx === -1) return false
  const cred = v.credentials[idx]
  v.credentials.splice(idx, 1)
  saveVault(v)
  logActivity(owner, 'credential_deleted', { id, label: cred.label })
  return true
}

// ── Limits ──
export function getLimits(owner) {
  const v = loadVault()
  return v.limits[owner] || { maxPerTx: 100, dailyLimit: 500, autoApprove: true, whitelist: [] }
}

export function setLimits(owner, limits) {
  const v = loadVault()
  v.limits[owner] = { ...getLimits(owner), ...limits }
  saveVault(v)
  logActivity(owner, 'limits_updated', limits)
  return v.limits[owner]
}

// ── Approvals ──
export function listApprovals(owner) {
  const v = loadVault()
  return v.approvals.filter(a => a.owner === owner)
}

export function createApproval(owner, { agent, action, amount, token, source, to, details, forcePending }) {
  const v = loadVault()
  const limits = getLimits(owner)
  // Agent-initiated (MCP) transactions ALWAYS require the user to sign via
  // MetaMask on the frontend, so they must stay actionable (pending) even when
  // within auto-approve limits. Auto-approve only makes sense for flows that can
  // execute without a browser signature — which the remote MCP server cannot do.
  const withinLimit = !forcePending && limits.autoApprove && Number(amount) <= limits.maxPerTx

  const approval = {
    id: randomUUID(),
    owner,
    agent: agent || 'unknown',
    action,
    amount: String(amount),
    token: token || 'USDC',
    source: source || 'eoa',
    to: to || '',
    details: details || '',
    // Lifecycle: pending → approved → pending_signature → pending_confirmation → success/error
    // Or: pending → rejected, denied, error
    status: withinLimit ? 'auto_approved' : 'pending',
    paramHash: '', // ponytail: operation-bound hash — add when security hardened
    createdAt: Date.now(),
  }
  v.approvals.push(approval)
  saveVault(v)
  logActivity(owner, withinLimit ? 'auto_approved' : 'approval_requested', { action, amount, token, source })
  return approval
}

export function approveRequest(owner, id, extra = {}) {
  const v = loadVault()
  const a = v.approvals.find(x => x.owner === owner && x.id === id && x.status === 'pending')
  if (!a) return null
  a.status = 'approved'
  a.approvedAt = Date.now()
  if (extra.txHash) a.txHash = extra.txHash
  if (extra.explorerUrl) a.explorerUrl = extra.explorerUrl
  saveVault(v)
  logActivity(owner, 'approval_approved', { id, action: a.action, amount: a.amount, txHash: extra.txHash || '' })
  return a
}

export function rejectRequest(owner, id) {
  const v = loadVault()
  const a = v.approvals.find(x => x.owner === owner && x.id === id && x.status === 'pending')
  if (!a) return null
  a.status = 'rejected'
  a.rejectedAt = Date.now()
  saveVault(v)
  logActivity(owner, 'approval_rejected', { id, action: a.action, amount: a.amount })
  return a
}

// ── Lifecycle status transitions ──
// pending → approved → pending_signature → pending_confirmation → success/error
// pending → rejected, denied
export function updateApprovalStatus(owner, id, status, extra = {}) {
  const v = loadVault()
  const a = v.approvals.find(x => x.owner === owner && x.id === id)
  if (!a) return null
  a.status = status
  if (extra.txHash) a.txHash = extra.txHash
  if (extra.explorerUrl) a.explorerUrl = extra.explorerUrl
  if (extra.userOpHash) a.userOpHash = extra.userOpHash
  if (extra.error) a.error = extra.error
  if (status === 'success') a.completedAt = Date.now()
  saveVault(v)
  logActivity(owner, `approval_${status}`, { id, action: a.action, txHash: extra.txHash || '' })
  return a
}

// ── Session key info (lightweight, stored in vault) ──
// Full delegate private key stored in sessionKeyService (separate file).
// This stores only the public address + wallet address for the vault UI.
export function getSessionKeyInfo(owner) {
  const v = loadVault()
  return v.sessionKeys?.[owner] || null
}

export function setSessionKeyInfo(owner, info) {
  const v = loadVault()
  if (!v.sessionKeys) v.sessionKeys = {}
  v.sessionKeys[owner] = { ...info, updatedAt: Date.now() }
  saveVault(v)
  logActivity(owner, 'session_key_updated', { walletAddress: info.walletAddress, delegateAddress: info.delegateAddress, active: info.active })
  return v.sessionKeys[owner]
}

export function clearSessionKeyInfo(owner) {
  const v = loadVault()
  if (v.sessionKeys?.[owner]) {
    v.sessionKeys[owner].active = false
    v.sessionKeys[owner].revokedAt = Date.now()
    saveVault(v)
    logActivity(owner, 'session_key_revoked', {})
  }
  return v.sessionKeys?.[owner] || null
}

// ── Activity ──
export function listActivity(owner, limit = 50) {
  const a = loadActivity()
  return a.filter(x => x.owner === owner).slice(-limit).reverse()
}

function logActivity(owner, type, data = {}) {
  const a = loadActivity()
  a.push({ id: randomUUID(), owner, type, data, ts: Date.now() })
  saveActivity(a)
}

// ── Masking ──
function maskValue(val) {
  if (!val || typeof val !== 'string') return '••••'
  if (val.length <= 8) return '••••'
  return val.slice(0, 4) + '••••' + val.slice(-4)
}
