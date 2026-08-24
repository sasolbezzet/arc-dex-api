import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, statSync } from 'fs'
import { dirname } from 'path'

function vaultPath() { return process.env.VAULT_PATH || './data/vault.json' }
function activityPath() { return process.env.VAULT_ACTIVITY_PATH || './data/vault-activity.json' }
function sessionPath() { return process.env.VAULT_SESSION_PATH || './data/vault-sessions.json' }

// ── Session tokens (persisted to disk, TTL 24h) ──
// Backend session tokens used to live only in memory, so every backend restart
// (systemd Restart=always, cron */5 restart-if-down) silently logged every user
// out — the frontend held a token the server no longer knew and got 401 on the
// vault deep-link. Persisting them to a JSON file survives restarts.
const SESSION_TTL_MS = 86400000 // 24h
function loadSessions() {
  const data = readJsonFile(sessionPath(), { tokens: {} })
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
  atomicWriteJsonFile(sessionPath(), { tokens: Object.fromEntries(map) })
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
// `lastActivity` is retained for observability, but an MCP connection is not
// marked inactive merely because the agent has been idle for a day.
const mcpSessions = new Map() // userId -> [{ clientId, agent, connectedAt, lastActivity }]
export function registerMcpSession(userId, clientId, agent, active = true) {
  if (!mcpSessions.has(userId)) mcpSessions.set(userId, [])
  const sessions = mcpSessions.get(userId)
  const now = Date.now()
  const existing = sessions.find(s => s.clientId === clientId)
  if (existing) {
    existing.lastActivity = now
    existing.active = active === true
  } else {
    sessions.push({ clientId, agent, connectedAt: now, lastActivity: now, active: active === true })
  }
}
export function listMcpSessions(userId) {
  return mcpSessions.get(userId) || []
}

// ── Helpers ──
function loadVault() {
  return readJsonFile(vaultPath(), { credentials: [], limits: {}, approvals: [] })
}
function saveVault(v) {
  atomicWriteJsonFile(vaultPath(), v)
}

// Credential setup can be retried concurrently by multiple frontend callbacks.
// Serialize the read-modify-write section across Node processes so idempotency
// is preserved even when more than one worker serves the vault endpoint.
function withVaultLock(fn) {
  const lockPath = `${vaultPath()}.lock`
  const ownerToken = `${process.pid}:${randomUUID()}`
  const ownerPath = `${lockPath}/owner`
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + 5000
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    try {
      mkdirSync(lockPath)
      // The directory creation is the lock acquisition. Write the owner only
      // after acquisition so a stale-lock reclaimer can identify ownership.
      atomicWriteJsonFile(ownerPath, { token: ownerToken, acquiredAt: Date.now() })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const owner = readJsonFile(`${lockPath}/owner`, null)
        const acquiredAt = Number(owner?.acquiredAt || 0)
        if (acquiredAt && Date.now() - acquiredAt > 15000) rmSync(lockPath, { recursive: true, force: true })
      } catch { /* another worker may be acquiring/releasing the lock */ }
      if (Date.now() >= deadline) throw new Error('Vault mutation lock timeout')
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  try {
    return fn()
  } finally {
    // Never remove a lock that was replaced after stale-lock recovery.
    try {
      const current = readJsonFile(ownerPath, null)
      if (current?.token === ownerToken) rmSync(lockPath, { recursive: true, force: true })
    } catch { /* lock may already have been removed after a timeout */ }
  }
}
function loadActivity() {
  return readJsonFile(activityPath(), [])
}
function saveActivity(a) {
  // Keep last 500 entries
  if (a.length > 500) a = a.slice(-500)
  atomicWriteJsonFile(activityPath(), a)
}

// ── Credentials ──
// Each credential: { id, type, label, value (masked), createdAt }
// type: 'eoa' | 'circle' | 'solana' | 'api_key'
// Wallet credentials auto-registered from frontend. API key credentials manually added.

function credentialValueKey(type, value) {
  const normalized = String(value || '').trim()
  // EVM addresses are case-insensitive; preserve case for opaque/API-key values.
  return ['eoa', 'circle'].includes(String(type || '').toLowerCase()) && /^0x[0-9a-f]{40}$/i.test(normalized)
    ? normalized.toLowerCase()
    : normalized
}

function collapseCredentialDuplicates(v, owner) {
  const normalizedOwner = String(owner || '').toLowerCase()
  const seen = new Set()
  const kept = []
  let removed = 0
  for (const credential of v.credentials) {
    if (String(credential.owner || '').toLowerCase() !== normalizedOwner) {
      kept.push(credential)
      continue
    }
    const key = `${String(credential.type || '').toLowerCase()}\u0000${credentialValueKey(credential.type, credential.value)}`
    if (seen.has(key)) {
      removed++
      continue
    }
    seen.add(key)
    kept.push(credential)
  }
  if (removed > 0) v.credentials = kept
  return removed
}

export function listCredentials(owner) {
  return withVaultLock(() => {
    const v = loadVault()
    const removed = collapseCredentialDuplicates(v, owner)
    // Heal legacy bloat on the normal read path; list remains idempotent.
    if (removed > 0) saveVault(v)
    const normalizedOwner = String(owner || '').toLowerCase()
    return v.credentials
      .filter(c => String(c.owner || '').toLowerCase() === normalizedOwner)
      .map(c => ({ ...c, value: maskValue(c.value) }))
  })
}

export function addCredential(owner, { type, label, value }) {
  return withVaultLock(() => {
    const v = loadVault()
    const normalizedOwner = String(owner || '').toLowerCase()
    // Heal legacy duplicates before checking for an existing record. This
    // makes repeated registration idempotent even when old bloat is still in
    // the vault and the caller has not listed credentials first.
    const removed = collapseCredentialDuplicates(v, owner)
    if (removed > 0) saveVault(v)
    const normalizedType = String(type || '').toLowerCase()
    const normalizedLabel = String(label || '').trim()
    const normalizedValue = String(value || '').trim()
    // Credential registration is idempotent: repeated frontend setup callbacks
    // must not create another secret record for the same owner/type/value.
    const existing = v.credentials.find(c => String(c.owner || '').toLowerCase() === normalizedOwner
      && String(c.type || '').toLowerCase() === normalizedType
      && credentialValueKey(normalizedType, c.value) === credentialValueKey(normalizedType, normalizedValue))
    if (existing) return { ...existing, value: maskValue(existing.value), deduplicated: true }
    const cred = { id: randomUUID(), owner, type: normalizedType, label: normalizedLabel, value: normalizedValue, createdAt: Date.now() }
    v.credentials.push(cred)
    saveVault(v)
    logActivity(owner, 'credential_added', { type: normalizedType, label: normalizedLabel })
    return { ...cred, value: maskValue(cred.value), deduplicated: false }
  })
}

export function deduplicateCredentials(owner) {
  const removed = withVaultLock(() => {
    const v = loadVault()
    const count = collapseCredentialDuplicates(v, owner)
    if (count > 0) {
      saveVault(v)
      logActivity(owner, 'credentials_deduplicated', { removed: count })
    }
    return count
  })
  return { removed, credentials: listCredentials(owner) }
}

export function revealCredential(owner, id) {
  const v = loadVault()
  const normalizedOwner = String(owner || '').toLowerCase()
  const cred = v.credentials.find(c => String(c.owner || '').toLowerCase() === normalizedOwner && c.id === id)
  if (!cred) return null
  logActivity(owner, 'credential_revealed', { id, label: cred.label })
  return cred
}

export function deleteCredential(owner, id) {
  const v = loadVault()
  const normalizedOwner = String(owner || '').toLowerCase()
  const idx = v.credentials.findIndex(c => String(c.owner || '').toLowerCase() === normalizedOwner && c.id === id)
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

  const createdAt = Date.now()
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
    createdAt,
    // `auto_approved` records the approval decision, not completion of a
    // value-moving execution. Keep the execution `completedAt` unset until a
    // terminal execution status is observed; expose a separate timestamp for
    // consumers auditing the approval lifecycle.
    ...(withinLimit ? { approvedAt: createdAt, approvalCompletedAt: createdAt } : {}),
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
  a.updatedAt = Date.now()
  if (extra.txHash) a.txHash = extra.txHash
  if (extra.explorerUrl) a.explorerUrl = extra.explorerUrl
  if (extra.userOpHash) a.userOpHash = extra.userOpHash
  if (extra.error) a.error = extra.error
  if (extra.details !== undefined) {
    try {
      const previous = JSON.parse(a.details || '{}')
      const next = typeof extra.details === 'string' ? JSON.parse(extra.details) : extra.details
      a.details = JSON.stringify({ ...previous, ...(next && typeof next === 'object' ? next : {}) })
    } catch {
      a.details = String(extra.details)
    }
  }
  if (['approved', 'auto_approved'].includes(status) && !a.approvedAt) a.approvedAt = Date.now()
  if (['success', 'error', 'rejected', 'denied'].includes(status) && !a.completedAt) a.completedAt = Date.now()
  saveVault(v)
  logActivity(owner, `approval_${status}`, { id, action: a.action, txHash: extra.txHash || '' })
  return a
}

/**
 * Reconcile a Circle Wallets webhook against bridge approvals without trusting
 * the webhook as proof of settlement. The webhook is an event hint: receipt,
 * CCTP attestation, and destination nonce checks still decide final success.
 */
export function reconcileCircleWalletWebhook({ walletAddress, txHash, userOpHash, status, eventId, eventType } = {}) {
  const normalizedWallet = String(walletAddress || '').toLowerCase()
  const normalizedTx = String(txHash || '').toLowerCase()
  const normalizedUserOp = String(userOpHash || '').toLowerCase()
  const failed = ['failed', 'reverted', 'denied', 'rejected', 'cancelled', 'canceled', 'error'].includes(String(status || '').toLowerCase())
  const successful = ['complete', 'completed', 'confirmed', 'success', 'succeeded'].includes(String(status || '').toLowerCase())
  // A wallet address identifies an owner, not one bridge operation. Never use
  // it as the sole correlation key: a duplicate/late notification could then
  // mutate an unrelated pending bridge for the same MSCA.
  if (!normalizedTx && !normalizedUserOp) return { matched: 0, updated: 0, ignored: true, reason: 'webhook_reference_missing' }
  const matches = withVaultLock(() => {
    const v = loadVault()
    const candidates = []
    for (const approval of v.approvals || []) {
      let details = {}
      try { details = JSON.parse(approval.details || '{}') } catch { details = {} }
      if (approval.action !== 'bridge' && details.action !== 'bridge') continue
      const txMatch = normalizedTx && [approval.txHash, details.txHash, details.burnTxHash, details.webhookTxHash].some(value => String(value || '').toLowerCase() === normalizedTx)
      const userOpMatch = normalizedUserOp && [approval.userOpHash, details.sourceUserOpHash, details.destinationUserOpHash, details.webhookUserOpHash].some(value => String(value || '').toLowerCase() === normalizedUserOp)
      if (!txMatch && !userOpMatch) continue
      // The HTTP route deduplicates notificationId; keep this guard here too so
      // direct callers and concurrent workers remain idempotent.
      if (eventId && details.webhookEventId === eventId) continue
      candidates.push({ approval, details })
    }
    // A hash must identify exactly one approval. Refuse to mutate anything when
    // old/duplicated records make the reference ambiguous.
    if (candidates.length > 1) return { ambiguous: true, matches: [] }
    const changed = []
    for (const { approval, details } of candidates) {
      const previousStatus = approval.status
      details.webhookEventId = eventId || details.webhookEventId || null
      details.webhookEventType = eventType || details.webhookEventType || null
      details.webhookStatus = status || null
      details.webhookObservedAt = new Date().toISOString()
      if (normalizedWallet) details.webhookWalletAddress = walletAddress
      if (normalizedTx) details.webhookTxHash = txHash
      if (normalizedUserOp) details.webhookUserOpHash = userOpHash
      let nextStatus = previousStatus
      if (failed && !['success', 'error', 'rejected', 'denied'].includes(previousStatus)) nextStatus = 'error'
      else if (successful && !['success', 'error', 'rejected', 'denied'].includes(previousStatus)) nextStatus = 'pending_confirmation'
      approval.status = nextStatus
      approval.details = JSON.stringify(details)
      if (normalizedTx) approval.txHash = txHash
      if (normalizedUserOp) approval.userOpHash = userOpHash
      if (failed) approval.error = `Circle Wallet webhook reported ${status}`
      if (nextStatus === 'error' && !approval.completedAt) approval.completedAt = Date.now()
      changed.push({ id: approval.id, owner: approval.owner, previousStatus, status: nextStatus, details })
    }
    if (changed.length) saveVault(v)
    return { ambiguous: false, matches: changed }
  })
  if (matches.ambiguous) return { matched: 0, updated: 0, ignored: true, reason: 'webhook_reference_ambiguous' }
  if (!matches.matches.length) return { matched: 0, updated: 0, ignored: true, reason: 'webhook_reference_not_found' }
  for (const match of matches.matches) logActivity(match.owner, 'approval_webhook_reconciled', { id: match.id, eventId, eventType, status, txHash, userOpHash })
  return { matched: matches.matches.length, updated: matches.matches.length, matches: matches.matches }
}

// ── Session key info (lightweight, stored in vault) ──
// Full delegate private key stored in sessionKeyService (separate file).
// This stores only the public address + wallet address for the vault UI.
export async function getSessionKeyInfo(owner) {
  const key = String(owner || '').toLowerCase()
  // The session-key store is authoritative for signer activity. Vault UI data
  // can outlive a revoke or a failed setup and must never re-enable execution.
  try {
    const { getSessionKey } = await import('./sessionKeyService.mjs')
    // Status reads are intentionally side-effect free. An inactive session must
    // stay inactive after the 24-hour inactivity cutoff; reactivation requires
    // an explicit passkey flow through /api/session/setup, which independently
    // verifies the stored authorization UserOperation before activation.
    const entry = getSessionKey(key, { sweep: false })
    if (entry) return {
      walletAddress: entry.walletAddress,
      delegateAddress: entry.delegateAddress,
      active: entry.active === true,
      pendingAuthorization: entry.pendingAuthorization === true,
      authorizationUserOpHash: entry.authorizationUserOpHash || '',
      createdAt: entry.createdAt,
      activatedAt: entry.activatedAt,
      lastUsedAt: entry.lastUsedAt,
      chain: entry.chain,
      statusReason: entry.active === true
        ? 'active'
        : entry.revokeReason === 'inactivity_24h'
          ? 'inactivity_24h'
          : entry.revokeReason === 'manual'
            ? 'manual_revoke'
      : entry.lastAuthorizationOutcome === 'failed'
        ? 'authorization_failed'
        : entry.lastAuthorizationOutcome === 'unknown'
          ? 'authorization_unknown'
          : entry.pendingAuthorization
            ? 'authorization_pending'
            : entry.authorizationUserOpHash
              ? 'reauthorization_required'
              : 'setup_required',
    }
  } catch { /* fall through to legacy public record for display only */ }
  const v = loadVault()
  const info = v.sessionKeys?.[key] || null
  return info ? { ...info, active: false, stale: true } : null
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

export function logActivity(owner, type, data = {}) {
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
