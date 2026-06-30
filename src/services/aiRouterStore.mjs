import { createHash, randomBytes, randomUUID } from 'crypto'
import { privateKeyToAccount } from 'viem/accounts'
import { atomicWriteJsonFile, readJsonFile } from './jsonFileStore.mjs'

const DB_FILE = process.env.AI_ROUTER_DB || './ai-router-db.json'
const state = globalThis.__arcoxAiRouterStore || load()
globalThis.__arcoxAiRouterStore = state

function load() {
  return normalize(readJsonFile(DB_FILE, {}))
}

function normalize(input) {
  return {
    users: input.users || {},
    apiKeys: input.apiKeys || {},
    sessionChallenges: input.sessionChallenges || {},
    apiSessions: input.apiSessions || {},
    autoPayPolicy: input.autoPayPolicy || {},
    payments: input.payments || {},
    usageLogs: (input.usageLogs || []).map(sanitizeUsageLog).slice(0, 1000),
    agentJobs: input.agentJobs || {},
    modelRegistry: input.modelRegistry || {},
    providerHealth: input.providerHealth || {},
  }
}

export function saveAiRouterStore() {
  state.usageLogs = state.usageLogs.slice(0, 1000)
  state.payments = newestRecords(state.payments, 1000)
  state.agentJobs = newestRecords(state.agentJobs, 500)
  state.sessionChallenges = newestRecords(state.sessionChallenges, 500)
  state.apiSessions = newestRecords(state.apiSessions, 1000)
  atomicWriteJsonFile(DB_FILE, state)
}

export function hashApiKey(key) {
  return createHash('sha256').update(String(key)).digest('hex')
}

export function issueApiKey({ ownerAddress, agentId = '', label = 'ARCOX AI Router', scopes = ['ai:chat', 'ai:models'] }) {
  const key = `arx_sk_${randomBytes(24).toString('base64url')}`
  const now = new Date().toISOString()
  const id = `key_${randomUUID().replaceAll('-', '')}`
  const rec = {
    id,
    ownerAddress: normalizeOwner(ownerAddress),
    agentId: /^\d+$/.test(String(agentId || '')) ? String(agentId) : '',
    label,
    keyHash: hashApiKey(key),
    keyPreview: `${key.slice(0, 10)}...${key.slice(-4)}`,
    scopes,
    status: 'active',
    createdAt: now,
    rotatedAt: null,
    revokedAt: null,
  }
  state.apiKeys[id] = rec
  ensureUser(ownerAddress)
  saveAiRouterStore()
  return { apiKey: key, record: publicApiKey(rec) }
}

export function prepareApiKey({ ownerAddress, agentId = '', label = 'ARCOX AI Router', scopes = ['ai:chat', 'ai:models'] }) {
  const now = new Date().toISOString()
  const id = `key_${randomUUID().replaceAll('-', '')}`
  const rec = {
    id,
    apiKeyIdHash: `0x${createHash('sha256').update(id).digest('hex')}`,
    ownerAddress: normalizeOwner(ownerAddress),
    agentId: /^\d+$/.test(String(agentId || '')) ? String(agentId) : '',
    label,
    keyHash: '',
    keyPreview: '',
    scopes,
    status: 'pending_mint',
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  }
  state.apiKeys[id] = rec
  ensureUser(ownerAddress)
  saveAiRouterStore()
  return publicApiKey(rec)
}

export function activateApiKey(id, ownerAddress, { sbtTokenId, mintTxHash, apiPassAddress }) {
  const rec = state.apiKeys[id]
  if (!rec || rec.ownerAddress !== normalizeOwner(ownerAddress) || rec.status !== 'pending_mint') return null
  const key = `arx_sk_${randomBytes(24).toString('base64url')}`
  rec.keyHash = hashApiKey(key)
  rec.keyPreview = `${key.slice(0, 10)}...${key.slice(-4)}`
  rec.sbtTokenId = String(sbtTokenId)
  rec.apiPassAddress = normalizeOwner(apiPassAddress)
  rec.mintTxHash = String(mintTxHash || '')
  rec.status = 'active'
  rec.activatedAt = new Date().toISOString()
  rec.updatedAt = rec.activatedAt
  saveAiRouterStore()
  return { apiKey: key, record: publicApiKey(rec) }
}

export function findApiKey(secret) {
  const keyHash = hashApiKey(secret || '')
  return Object.values(state.apiKeys).find(key => key.keyHash === keyHash && key.status === 'active') || null
}

export function findApiKeyForCredential(secret) {
  const keyHash = hashApiKey(secret || '')
  return Object.values(state.apiKeys).find(key => key.keyHash === keyHash) || null
}

export function getApiKey(id) {
  return state.apiKeys[id] || null
}

export function listApiKeys(ownerAddress) {
  const owner = normalizeOwner(ownerAddress)
  return Object.values(state.apiKeys).filter(key => key.ownerAddress === owner).map(publicApiKey)
}

export function revokeApiKey(id, ownerAddress) {
  const key = state.apiKeys[id]
  if (!key || key.ownerAddress !== normalizeOwner(ownerAddress)) return null
  key.status = 'revoked'
  key.revokedAt = new Date().toISOString()
  saveAiRouterStore()
  return publicApiKey(key)
}

export function disableApiKey(id, ownerAddress) {
  const key = state.apiKeys[id]
  if (!key || key.ownerAddress !== normalizeOwner(ownerAddress)) return null
  key.status = 'disabled_pending_burn'
  key.disabledAt = new Date().toISOString()
  key.updatedAt = key.disabledAt
  revokeSessionsForKey(id)
  saveAiRouterStore()
  return publicApiKey(key)
}

export function finalizeApiKeyRevocation(id, ownerAddress, burnTxHash = '') {
  const key = state.apiKeys[id]
  if (!key || key.ownerAddress !== normalizeOwner(ownerAddress)) return null
  key.status = 'revoked'
  key.burnTxHash = String(burnTxHash || '')
  key.revokedAt = new Date().toISOString()
  key.updatedAt = key.revokedAt
  revokeSessionsForKey(id)
  saveAiRouterStore()
  return publicApiKey(key)
}

export function createSessionChallenge(apiKey, messageFactory) {
  const id = `challenge_${randomUUID().replaceAll('-', '')}`
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + Number(process.env.ARCOX_API_CHALLENGE_TTL_SECONDS || 300) * 1000)
  const nonce = randomBytes(24).toString('base64url')
  const challenge = {
    id,
    apiKeyId: apiKey.id,
    ownerAddress: apiKey.ownerAddress,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    usedAt: null,
  }
  challenge.message = messageFactory(challenge)
  state.sessionChallenges[id] = challenge
  saveAiRouterStore()
  return { ...challenge }
}

export function consumeSessionChallenge(id, apiKeyId) {
  const challenge = state.sessionChallenges[id]
  if (!challenge || challenge.apiKeyId !== apiKeyId || challenge.usedAt || Date.now() > Date.parse(challenge.expiresAt)) return null
  challenge.usedAt = new Date().toISOString()
  saveAiRouterStore()
  return { ...challenge }
}

export function getSessionChallenge(id, apiKeyId) {
  const challenge = state.sessionChallenges[id]
  if (!challenge || challenge.apiKeyId !== apiKeyId || challenge.usedAt || Date.now() > Date.parse(challenge.expiresAt)) return null
  return { ...challenge }
}

export function issueApiSession(apiKey, signerAddress) {
  const token = `arx_sess_${randomBytes(32).toString('base64url')}`
  const now = new Date()
  const expiresAt = new Date(now.getTime() + Number(process.env.ARCOX_API_SESSION_TTL_SECONDS || 900) * 1000)
  const id = `session_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  state.apiSessions[id] = {
    id,
    tokenHash: hashApiKey(token),
    apiKeyId: apiKey.id,
    ownerAddress: apiKey.ownerAddress,
    signerAddress: normalizeOwner(signerAddress),
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }
  saveAiRouterStore()
  return { sessionToken: token, expiresAt: expiresAt.toISOString(), apiKey: publicApiKey(apiKey) }
}

export function findApiSession(token) {
  const tokenHash = hashApiKey(token || '')
  const session = Object.values(state.apiSessions).find(item => item.tokenHash === tokenHash)
  if (!session) return { status: 'invalid' }
  if (session.status !== 'active' || Date.now() > Date.parse(session.expiresAt)) return { status: 'expired', session }
  const apiKey = state.apiKeys[session.apiKeyId]
  if (!apiKey) return { status: 'invalid' }
  return { status: 'active', session, apiKey }
}

function revokeSessionsForKey(apiKeyId) {
  for (const session of Object.values(state.apiSessions)) {
    if (session.apiKeyId === apiKeyId && session.status === 'active') {
      session.status = 'revoked'
      session.updatedAt = new Date().toISOString()
    }
  }
}

export function publicApiKey(key) {
  if (!key) return null
  return {
    id: key.id,
    ownerAddress: key.ownerAddress,
    agentId: key.agentId || '',
    label: key.label,
    keyPreview: key.keyPreview,
    apiKeyIdHash: key.apiKeyIdHash || '',
    sbtTokenId: key.sbtTokenId || '',
    apiPassAddress: key.apiPassAddress || '',
    mintTxHash: key.mintTxHash || '',
    burnTxHash: key.burnTxHash || '',
    scopes: key.scopes,
    status: key.status,
    createdAt: key.createdAt,
    rotatedAt: key.rotatedAt,
    revokedAt: key.revokedAt,
    activatedAt: key.activatedAt || null,
  }
}

export function ensureUser(ownerAddress) {
  const owner = normalizeOwner(ownerAddress)
  if (!owner) return null
  if (!state.users[owner]) {
    state.users[owner] = {
      ownerAddress: owner,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }
  return state.users[owner]
}

export function setActiveAgentIdentity(ownerAddress, agentId) {
  const user = ensureUser(ownerAddress)
  user.activeAgentId = /^\d+$/.test(String(agentId || '')) ? String(agentId) : ''
  user.updatedAt = new Date().toISOString()
  saveAiRouterStore()
  return user.activeAgentId
}

export function getActiveAgentId(ownerAddress) {
  return String(state.users[normalizeOwner(ownerAddress)]?.activeAgentId || '')
}

export function getPolicy(ownerAddress) {
  const owner = normalizeOwner(ownerAddress)
  const fallback = {
    ownerAddress: owner,
    enabled: false,
    monthlyLimit: process.env.AI_ROUTER_DEFAULT_MONTHLY_LIMIT_USDC || '2.00',
    source: 'unified_balance',
    delegateStatus: 'not_configured',
    delegateAddress: delegateAddress(),
    delegateChains: [],
    status: 'deposit_required',
  }
  const current = { ...fallback, ...(state.autoPayPolicy[owner] || {}) }
  const configuredDelegate = delegateAddress()
  if (!validEvmAddress(current.delegateAddress) || (configuredDelegate && current.delegateAddress.toLowerCase() !== configuredDelegate.toLowerCase())) {
    current.delegateAddress = configuredDelegate
    current.delegateStatus = 'not_configured'
    current.delegateChains = []
    current.enabled = false
  }
  if (current.enabled && current.delegateAddress?.toLowerCase() === owner) {
    current.delegateStatus = 'ready'
    current.delegateChains = ['Arc_Testnet', 'Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia'].map(chain => ({ chain, status: 'ready' }))
  }
  current.delegateStatus = current.delegateStatus || 'not_configured'
  if (current.delegateStatus === 'none') current.delegateStatus = 'not_configured'
  current.status = current.enabled
    ? current.delegateStatus === 'ready' ? 'ready' : 'auto_pay_required'
    : current.status === 'off' ? 'off' : 'deposit_required'
  delete current.dailyLimit
  return current
}

export function setPolicy(ownerAddress, input = {}) {
  const owner = normalizeOwner(ownerAddress)
  ensureUser(owner)
  const current = getPolicy(owner)
  const delegateStatus = normalizeAutoPayStatus(input.delegateStatus || current.delegateStatus || 'not_configured')
  const nextDelegateAddress = validEvmAddress(input.delegateAddress) ? input.delegateAddress : validEvmAddress(current.delegateAddress) ? current.delegateAddress : delegateAddress()
  const delegateChains = normalizeDelegateChains(input.delegateChains ?? current.delegateChains)
  state.autoPayPolicy[owner] = {
    ...current,
    enabled: Boolean(input.enabled),
    monthlyLimit: normalizeUsdc(input.monthlyLimit || current.monthlyLimit),
    source: 'unified_balance',
    delegateStatus,
    delegateAddress: nextDelegateAddress,
    delegateChains,
    status: input.enabled && delegateStatus === 'ready' ? 'ready' : input.enabled ? 'auto_pay_required' : 'off',
    updatedAt: new Date().toISOString(),
  }
  saveAiRouterStore()
  return state.autoPayPolicy[owner]
}

function normalizeDelegateChains(value) {
  const supported = new Set(['Arc_Testnet', 'Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia'])
  if (!Array.isArray(value)) return []
  return value
    .filter(item => supported.has(String(item?.chain || '')))
    .map(item => ({ chain: String(item.chain), status: normalizeAutoPayStatus(item.status) }))
}

export function createPaymentIntent({ ownerAddress, agentId = '', amount, requestId, model }) {
  const owner = normalizeOwner(ownerAddress)
  ensureUser(owner)
  const id = requestId || `air_pay_${randomUUID().replaceAll('-', '').slice(0, 14)}`
  const now = new Date().toISOString()
  const payment = {
    id,
    ownerAddress: owner,
    agentId: /^\d+$/.test(String(agentId || '')) ? String(agentId) : '',
    amount: normalizeUsdc(amount),
    asset: 'USDC',
    network: 'arc-testnet',
    status: 'created',
    paymentStatus: 'created',
    paymentMethod: 'delegated_unified_balance',
    recipient: treasuryAddress(),
    sourceAccount: owner,
    delegateAddress: delegateAddress(),
    model: model || '',
    createdAt: now,
    updatedAt: now,
  }
  state.payments[id] = payment
  saveAiRouterStore()
  return payment
}

export function markPaymentSettled(id, patch = {}) {
  const payment = state.payments[id]
  if (!payment) return null
  payment.status = 'paid'
  payment.paymentStatus = 'paid'
  payment.txHash = patch.txHash || payment.txHash || ''
  payment.transferId = patch.transferId || payment.transferId || ''
  payment.memoId = patch.memoId || payment.memoId || ''
  payment.memoTxHash = patch.memoTxHash || payment.memoTxHash || ''
  if (patch.amount) payment.amount = normalizeUsdc(patch.amount)
  if (patch.serviceAmount) payment.serviceAmount = normalizeUsdc(patch.serviceAmount)
  if (patch.totalFee) payment.totalFee = normalizeUsdc(patch.totalFee)
  if (Array.isArray(patch.sourceAllocations)) payment.sourceAllocations = patch.sourceAllocations.slice(0, 4)
  payment.settledAt = new Date().toISOString()
  payment.updatedAt = payment.settledAt
  saveAiRouterStore()
  return payment
}

export function markPaymentStatus(id, status, patch = {}) {
  const payment = state.payments[id]
  if (!payment) return null
  payment.status = status
  payment.paymentStatus = status
  Object.assign(payment, patch)
  payment.updatedAt = new Date().toISOString()
  saveAiRouterStore()
  return payment
}

export function addUsageLog(entry) {
  const log = sanitizeUsageLog({
    requestId: entry.requestId || `air_req_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    apiKeyIdHash: entry.apiKeyIdHash || hashApiKey(entry.apiKeyId || ''),
    sbtTokenId: String(entry.sbtTokenId || ''),
    ownerAddress: normalizeOwner(entry.ownerAddress),
    agentId: /^\d+$/.test(String(entry.agentId || '')) ? String(entry.agentId) : '',
    model: entry.model || '',
    providerUsed: entry.providerUsed || '',
    inputTokens: Number(entry.inputTokens || 0),
    outputTokens: Number(entry.outputTokens || 0),
    cost: normalizeUsdc(entry.cost || '0'),
    paymentId: entry.paymentId || '',
    txHash: entry.txHash || '',
    memoId: entry.memoId || '',
    jobId: entry.jobId || '',
    fallbackCount: Number(entry.fallbackCount || 0),
    status: entry.status || 'created',
    latency: Number(entry.latency || 0),
    error: entry.error || '',
    createdAt: entry.createdAt || new Date().toISOString(),
  })
  state.usageLogs.unshift(log)
  state.usageLogs = state.usageLogs.slice(0, 1000)
  saveAiRouterStore()
  return log
}

export function usageForOwner(ownerAddress, limit = 25) {
  const owner = normalizeOwner(ownerAddress)
  return state.usageLogs.filter(log => log.ownerAddress === owner).slice(0, Number(limit) || 25)
}

export function spendToday(ownerAddress) {
  const owner = normalizeOwner(ownerAddress)
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  return state.usageLogs
    .filter(log => log.ownerAddress === owner && log.status === 'success' && Date.parse(log.createdAt) >= start.getTime())
    .reduce((sum, log) => sumUsdc(sum, log.cost), '0.000000')
}

export function getAiRouterStatus(ownerAddress) {
  const owner = normalizeOwner(ownerAddress)
  ensureUser(owner)
  const policy = getPolicy(owner)
  return {
    ownerAddress: owner,
    activeAgentId: getActiveAgentId(owner),
    unifiedBalance: {
      available: 'read_with_circle_appkit_getBalances',
      source: 'user-owned Unified Balance',
    },
    autoPay: policy,
    delegate: {
      status: policy.delegateStatus || 'not_configured',
      address: policy.delegateAddress || delegateAddress(),
      sourceAccount: owner,
    },
    apiKeys: listApiKeys(owner),
    usageLogs: usageForOwner(owner, 5),
    modelList: Object.values(state.modelRegistry),
  }
}

export function recordAgentJob(entry = {}) {
  const id = String(entry.jobId || entry.id || '')
  if (!/^\d+$/.test(id)) throw new Error('Invalid agent job ID')
  const job = {
    jobId: id,
    agentId: String(entry.agentId || ''),
    ownerAddress: normalizeOwner(entry.ownerAddress),
    txHash: String(entry.txHash || ''),
    memoId: String(entry.memoId || ''),
    status: String(entry.status || 'created'),
    createdAt: entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  state.agentJobs[id] = { ...(state.agentJobs[id] || {}), ...job }
  saveAiRouterStore()
  return state.agentJobs[id]
}

export function listAgentJobs(ownerAddress, agentId, limit = 50) {
  const owner = normalizeOwner(ownerAddress)
  return Object.values(state.agentJobs)
    .filter(job => job.ownerAddress === owner && (!agentId || String(job.agentId) === String(agentId)))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, Math.min(Math.max(Number(limit) || 50, 1), 500))
}

export function normalizeOwner(ownerAddress) {
  return String(ownerAddress || '').trim().toLowerCase()
}

function normalizeAutoPayStatus(value) {
  if (value === true) return 'ready'
  if (value === false || value === null) return 'not_configured'
  const raw = typeof value === 'string' ? value : value?.status || value?.state || value?.delegateStatus || value?.readiness || ''
  const normalized = String(raw || '').toLowerCase().replaceAll('_', ' ').trim()
  if (['ready', 'enabled', 'active', 'approved', 'allowed', 'complete', 'completed', 'success', 'delegated'].includes(normalized)) return 'ready'
  if (['none', 'missing', 'disabled', 'not configured', 'not ready'].includes(normalized)) return 'not_configured'
  if (normalized.includes('ready') || normalized.includes('enabled') || normalized.includes('active')) return 'ready'
  if (normalized.includes('pending') || normalized.includes('processing')) return 'pending'
  return normalized || 'not_configured'
}

function validEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim())
}

export function treasuryAddress() {
  return process.env.AI_ROUTER_TREASURY_ADDRESS || process.env.ARCOX_TREASURY_WALLET_ADDRESS || process.env.X402_RECIPIENT_ADDRESS || process.env.CIRCLE_X402_TREASURY_ADDRESS || ''
}

export function delegateAddress() {
  return [
    process.env.AI_ROUTER_DELEGATE_ADDRESS,
    privateKeyAddress(),
    process.env.CIRCLE_DELEGATE_ADDRESS,
  ].find(validEvmAddress) || ''
}

function privateKeyAddress() {
  const key = process.env.AI_ROUTER_DELEGATE_PRIVATE_KEY || process.env.EOA_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY || ''
  if (!key) return ''
  try {
    const privateKey = key.startsWith('0x') ? key : `0x${key}`
    return privateKeyToAccount(privateKey).address
  } catch {
    return ''
  }
}

export function normalizeUsdc(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid USDC amount')
  return n.toFixed(6)
}

export function compareUsdc(a, b) {
  const ai = BigInt(toUnits(a))
  const bi = BigInt(toUnits(b))
  return ai === bi ? 0 : ai > bi ? 1 : -1
}

function sumUsdc(a, b) {
  return fromUnits(BigInt(toUnits(a)) + BigInt(toUnits(b)))
}

export function toUnits(value) {
  const normalized = normalizeUsdc(value)
  const [whole, fraction = ''] = normalized.split('.')
  return String(BigInt(whole || '0') * 1_000_000n + BigInt((fraction + '000000').slice(0, 6)))
}

function fromUnits(value) {
  const n = BigInt(value)
  const whole = n / 1_000_000n
  const fraction = `${n % 1_000_000n}`.padStart(6, '0')
  return `${whole}.${fraction}`
}

function sanitizeUsageLog(entry = {}) {
  return {
    requestId: String(entry.requestId || ''),
    agentId: /^\d+$/.test(String(entry.agentId || '')) ? String(entry.agentId) : '',
    apiKeyIdHash: String(entry.apiKeyIdHash || (entry.apiKeyId ? hashApiKey(entry.apiKeyId) : '')),
    sbtTokenId: String(entry.sbtTokenId || ''),
    ownerAddress: normalizeOwner(entry.ownerAddress),
    paymentId: String(entry.paymentId || ''),
    txHash: String(entry.txHash || ''),
    memoId: String(entry.memoId || ''),
    jobId: String(entry.jobId || ''),
    model: String(entry.model || '').slice(0, 96),
    providerUsed: String(entry.providerUsed || '').slice(0, 96),
    inputTokens: Number(entry.inputTokens || 0),
    outputTokens: Number(entry.outputTokens || 0),
    cost: normalizeUsdc(entry.cost || '0'),
    fallbackCount: Number(entry.fallbackCount || 0),
    status: String(entry.status || 'created').slice(0, 32),
    latency: Number(entry.latency || 0),
    error: String(entry.error || '').slice(0, 240),
    createdAt: entry.createdAt || new Date().toISOString(),
  }
}

function newestRecords(records, limit) {
  return Object.fromEntries(Object.entries(records || {})
    .sort(([, a], [, b]) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
    .slice(0, limit))
}

export { state as aiRouterState }
