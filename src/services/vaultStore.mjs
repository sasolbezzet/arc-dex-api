import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { randomUUID } from 'crypto'

const VAULT_PATH = process.env.VAULT_PATH || './data/vault.json'
const ACTIVITY_PATH = process.env.VAULT_ACTIVITY_PATH || './data/vault-activity.json'

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

export function createApproval(owner, { agent, action, amount, token, source, to, details }) {
  const v = loadVault()
  const limits = getLimits(owner)
  const withinLimit = limits.autoApprove && Number(amount) <= limits.maxPerTx

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
    status: withinLimit ? 'auto_approved' : 'pending',
    createdAt: Date.now(),
  }
  v.approvals.push(approval)
  saveVault(v)
  logActivity(owner, withinLimit ? 'auto_approved' : 'approval_requested', { action, amount, token, source })
  return approval
}

export function approveRequest(owner, id) {
  const v = loadVault()
  const a = v.approvals.find(x => x.owner === owner && x.id === id && x.status === 'pending')
  if (!a) return null
  a.status = 'approved'
  a.approvedAt = Date.now()
  saveVault(v)
  logActivity(owner, 'approval_approved', { id, action: a.action, amount: a.amount })
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
