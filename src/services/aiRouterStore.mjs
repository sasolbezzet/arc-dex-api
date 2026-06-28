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
    autoPayPolicy: input.autoPayPolicy || {},
    payments: input.payments || {},
    usageLogs: input.usageLogs || [],
    modelRegistry: input.modelRegistry || {},
    providerHealth: input.providerHealth || {},
  }
}

export function saveAiRouterStore() {
  atomicWriteJsonFile(DB_FILE, state)
}

export function hashApiKey(key) {
  return createHash('sha256').update(String(key)).digest('hex')
}

export function issueApiKey({ ownerAddress, label = 'ARCOX AI Router', scopes = ['ai:chat', 'ai:models'] }) {
  const key = `arx_sk_${randomBytes(24).toString('base64url')}`
  const now = new Date().toISOString()
  const id = `key_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const rec = {
    id,
    ownerAddress: normalizeOwner(ownerAddress),
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

export function findApiKey(secret) {
  const keyHash = hashApiKey(secret || '')
  return Object.values(state.apiKeys).find(key => key.keyHash === keyHash && key.status === 'active') || null
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

export function publicApiKey(key) {
  if (!key) return null
  return {
    id: key.id,
    ownerAddress: key.ownerAddress,
    label: key.label,
    keyPreview: key.keyPreview,
    scopes: key.scopes,
    status: key.status,
    createdAt: key.createdAt,
    rotatedAt: key.rotatedAt,
    revokedAt: key.revokedAt,
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

export function getPolicy(ownerAddress) {
  const owner = normalizeOwner(ownerAddress)
  const fallback = {
    ownerAddress: owner,
    enabled: false,
    maxPerRequest: process.env.AI_ROUTER_DEFAULT_MAX_PER_REQUEST_USDC || '0.02',
    monthlyLimit: process.env.AI_ROUTER_DEFAULT_MONTHLY_LIMIT_USDC || '2.00',
    source: 'unified_balance',
    delegateStatus: 'not_configured',
    delegateAddress: delegateAddress(),
    status: 'deposit_required',
  }
  const current = { ...fallback, ...(state.autoPayPolicy[owner] || {}) }
  const configuredDelegate = delegateAddress()
  if (!validEvmAddress(current.delegateAddress) || (configuredDelegate && current.delegateAddress.toLowerCase() !== configuredDelegate.toLowerCase())) {
    current.delegateAddress = configuredDelegate
    current.delegateStatus = 'not_configured'
    current.enabled = false
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
  const delegateStatus = normalizeAutoPayStatus(input.delegateStatus || current.delegateStatus || (input.enabled ? 'ready' : 'not_configured'), Boolean(input.enabled))
  const nextDelegateAddress = validEvmAddress(input.delegateAddress) ? input.delegateAddress : validEvmAddress(current.delegateAddress) ? current.delegateAddress : delegateAddress()
  state.autoPayPolicy[owner] = {
    ...current,
    enabled: Boolean(input.enabled),
    maxPerRequest: normalizeUsdc(input.maxPerRequest || current.maxPerRequest),
    monthlyLimit: normalizeUsdc(input.monthlyLimit || current.monthlyLimit),
    source: 'unified_balance',
    delegateStatus,
    delegateAddress: nextDelegateAddress,
    status: input.enabled && delegateStatus === 'ready' ? 'ready' : input.enabled ? 'auto_pay_required' : 'off',
    updatedAt: new Date().toISOString(),
  }
  saveAiRouterStore()
  return state.autoPayPolicy[owner]
}

export function createPaymentIntent({ ownerAddress, amount, requestId, model }) {
  const owner = normalizeOwner(ownerAddress)
  ensureUser(owner)
  const id = requestId || `air_pay_${randomUUID().replaceAll('-', '').slice(0, 14)}`
  const now = new Date().toISOString()
  const payment = {
    id,
    ownerAddress: owner,
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
  payment.estimate = patch.estimate || payment.estimate || null
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
  const log = {
    requestId: entry.requestId || `air_req_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    apiKeyId: entry.apiKeyId || '',
    ownerAddress: normalizeOwner(entry.ownerAddress),
    model: entry.model || '',
    providerUsed: entry.providerUsed || '',
    inputTokens: Number(entry.inputTokens || 0),
    outputTokens: Number(entry.outputTokens || 0),
    cost: normalizeUsdc(entry.cost || '0'),
    paymentId: entry.paymentId || '',
    txHash: entry.txHash || '',
    fallbackCount: Number(entry.fallbackCount || 0),
    status: entry.status || 'created',
    latency: Number(entry.latency || 0),
    error: entry.error || '',
    createdAt: entry.createdAt || new Date().toISOString(),
  }
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

export function normalizeOwner(ownerAddress) {
  return String(ownerAddress || '').trim().toLowerCase()
}

function normalizeAutoPayStatus(value, setupEnabled = false) {
  if (value === true) return 'ready'
  if (value === false || value === null) return setupEnabled ? 'ready' : 'not_configured'
  const raw = typeof value === 'string' ? value : value?.status || value?.state || value?.delegateStatus || value?.readiness || ''
  const normalized = String(raw || '').toLowerCase().replaceAll('_', ' ').trim()
  if (['ready', 'enabled', 'active', 'approved', 'allowed', 'complete', 'completed', 'success', 'delegated'].includes(normalized)) return 'ready'
  if (['none', 'missing', 'disabled', 'not configured', 'not ready'].includes(normalized)) return setupEnabled ? 'ready' : 'not_configured'
  if (normalized.includes('ready') || normalized.includes('enabled') || normalized.includes('active')) return 'ready'
  if (normalized.includes('pending') || normalized.includes('processing')) return setupEnabled ? 'ready' : 'pending'
  return setupEnabled ? 'ready' : normalized || 'not_configured'
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

export { state as aiRouterState }
