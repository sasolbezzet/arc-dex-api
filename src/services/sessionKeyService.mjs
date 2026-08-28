// sessionKeyService.mjs — Circle Modular Wallet session key management.
// Pattern: user creates MSCA via passkey (frontend), then maps a delegate EOA
// as an additional owner via createAddressMapping. The delegate EOA's private
// key is stored server-side and used to sign UserOperations on behalf of the
// agent — no passkey touch needed per tx, within policy limits.
//
// Lifecycle:
//   1. generateSessionKey() → new EOA keypair (stored encrypted in vault)
//   2. installSessionKey(walletAddress, delegateAddress, chainKey) → createAddressMapping
//   3. executeViaSession(walletAddress, calls, paymaster, chainKey) → sendUserOperation
//   4. revokeSessionKey(walletAddress, delegateAddress) → remove mapping
//
// ponytail: no on-chain spend limit enforcement yet — limits checked in
// backend (vaultStore). Upgrade to ERC-6900 session key module for on-chain
// enforcement when Circle ships the module SDK.
// Node.js polyfill: Circle SDK's nested viem@2.45.3 references `window` in
// its HTTP transport retry logic.  Must run before any @circle-fin import.
import '../polyfill-node.mjs'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPublicClient, createWalletClient, http, encodeFunctionData, getAddress, defineChain, parseUnits } from 'viem'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { circleModularProxyHeaders } from './circleModularProxy.mjs'
import { getPaymasterData, getPaymasterStubData, sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { encrypt, decrypt } from './crypto.mjs'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { getLimits } from './vaultStore.mjs'
import { CHAINS, MSCA_SUPPORTED_CHAIN_KEYS } from './chains.mjs'
import { scheduleSessionMetadataSnapshot } from './supabasePersistence.mjs'
import { recordSpend, wouldExceedDailyLimit } from './agentSpendLedger.mjs'

const ADD_OWNERS_ABI = [{
  type: 'function',
  name: 'addOwners',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'ownersToAdd', type: 'address[]' },
    { name: 'weightsToAdd', type: 'uint256[]' },
    { name: 'publicKeyOwnersToAdd', type: 'tuple[]', components: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] },
    { name: 'publicKeyWeightsToAdd', type: 'uint256[]' },
    { name: 'newThresholdWeight', type: 'uint256' },
  ],
  outputs: [],
}]

const CLIENT_URL = process.env.CIRCLE_CLIENT_URL || ''
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY || ''
const BUNDLER_MIN_PRIORITY_FEE_WEI = 1_000_000_000n
const DESTINATION_VERIFICATION_GAS_LIMITS = {
  'arc-testnet': 270_000n,
  'base-sepolia': 270_000n,
  'arbitrum-sepolia': 125_000n,
}
const CIRCLE_GAS_PRICE_LEVELS = ['medium', 'fast', 'slow']

function parseFeeQuantity(value) {
  try {
    if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())) return BigInt(value)
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value)
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  } catch { /* invalid fee is handled by the caller */ }
  return null
}

export function normalizeUserOperationFees({ maxFeePerGas = 0n, maxPriorityFeePerGas = 0n, minPriorityFeePerGas = BUNDLER_MIN_PRIORITY_FEE_WEI } = {}) {
  let observedMax = parseFeeQuantity(maxFeePerGas) ?? 0n
  let observedPriority = parseFeeQuantity(maxPriorityFeePerGas) ?? 0n
  if (observedMax < 0n) observedMax = 0n
  if (observedPriority < 0n) observedPriority = 0n
  const minimum = parseFeeQuantity(minPriorityFeePerGas) ?? BUNDLER_MIN_PRIORITY_FEE_WEI
  const priority = observedPriority >= minimum ? observedPriority : minimum
  const max = observedMax >= priority ? observedMax + priority : priority * 2n
  return { maxFeePerGas: max, maxPriorityFeePerGas: priority }
}

export function classifyUserOperationPrecheckError(error) {
  const message = String(error?.message || error || '')
  if (/max operations .*reached for account|account.*unstaked/i.test(message)) return 'bundler_account_reputation_limit'
  if (/paymaster.*stake|signature aggregator.*stake|unstaked/i.test(message)) return 'bundler_stake_requirement'
  if (/precheck failed|maxPriorityFeePerGas|missing or invalid parameters|verification gas limit efficiency/i.test(message)) return 'user_operation_precheck_failed'
  return null
}

// Resolve on each store operation so tests and controlled runtime configuration
// can switch the backing file without retaining a stale path from module load.
function sessionKeysPath() {
  return process.env.SESSION_KEYS_PATH || './data/session-keys.json'
}

// ── Pending transactions (unsigned UserOps awaiting browser passkey signature) ──
const PENDING_TX_TTL = 5 * 60 * 1000 // 5 minutes
const pendingTxs = new Map() // txId -> { userId, walletAddress, calls, chainKey, paymaster, status, signedUserOp, txHash, explorerUrl, error, createdAt }

// ── Build viem chain object from CHAINS config ──
function buildViemChain(chainKey) {
  const c = CHAINS[chainKey]
  if (!c) throw new Error(`Unknown chain: ${chainKey}`)
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: [c.rpcUrl] } },
  })
}

// Circle's chain/bundler RPC requires the X-AppInfo header (platform + app
// origin) alongside the Bearer Client Key. The SDK's toModularTransport omits
// it, and Circle rejects those calls with 401 "Invalid credentials." — which
// broke authorization verification, reconciliation, and every session-key
// execution. Mirror server.mjs's circleModularHttpTransport: native viem http
// also avoids the SDK's browser-oriented transport under Node.js.
function circleModularHttpTransport(chainKey) {
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`)
  if (!CLIENT_URL || !CLIENT_KEY) throw new Error('CIRCLE_CLIENT_URL and CIRCLE_CLIENT_KEY must be set')
  const url = `${String(CLIENT_URL).replace(/\/+$/, '')}/${chain.transportSlug}`
  return http(url, {
    timeout: 12_000,
    retryCount: 1,
    fetchOptions: {
      headers: circleModularProxyHeaders(CLIENT_KEY),
    },
  })
}

// ── Session key store (per user) ──
function loadStore() {
  return readJsonFile(sessionKeysPath(), { users: {} })
}

function saveStore(data) {
  atomicWriteJsonFile(sessionKeysPath(), data)
  // Supabase receives metadata only. The encrypted delegate private key remains
  // in the local key store and is never included in the snapshot payload.
  try { scheduleSessionMetadataSnapshot(data) } catch { /* local session persistence remains authoritative */ }
}

/** True only for an explicit manual revoke.
 *
 * Records revoked by the inactivity sweeper carry `revokeReason: 'inactivity_24h'`
 * and manual revokes always write `'manual'`. Older sweeper versions left only
 * `revokedAt` with no reason at all — treating that as a manual revoke locks
 * those users out forever, because reconciliation refuses to resurrect
 * anything that does not look like inactivity. A missing reason therefore
 * means a legacy inactivity revoke: the on-chain owner was never removed, so
 * the session may be re-activated after a fresh passkey flow.
 */
export function isManuallyRevoked(entry) {
  return Boolean(entry?.revokedAt && entry.revokeReason !== undefined && entry.revokeReason !== 'inactivity_24h')
}

/** Convert Circle transport authentication failures into an actionable error.
 * Without this normalization, a 401 from the Modular Wallet endpoint is
 * swallowed by receipt polling and the UI incorrectly reports a generic
 * inactive/pending session. Circle requires a Client Key (not CIRCLE_API_KEY)
 * bound to the application's web domain.
 */
export function classifyCircleModularError(error) {
  const messages = []
  const seen = new Set()
  let current = error
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current)
    messages.push(String(current?.shortMessage || current?.message || current || ''))
    current = current?.cause
  }
  const message = messages.join(' ')
  if (/\b401\b|invalid credentials|malformed authorization|client key|domain.*bound|unauthorized/i.test(message)) {
    return 'circle_modular_client_key_invalid'
  }
  return null
}

function circleModularConfigurationError(error) {
  const wrapped = new Error('Circle Modular Client Key invalid/expired or domain belum terdaftar di Circle Console; gunakan CIRCLE_CLIENT_KEY (Client Key), bukan CIRCLE_API_KEY.', { cause: error })
  wrapped.code = 'circle_modular_client_key_invalid'
  return wrapped
}

/**
 * Kept as a compatibility no-op for maintenance callers from older releases.
 * Session keys are no longer revoked merely because an agent was idle; only an
 * explicit/manual revoke or failed authorization can make one inactive.
 */
export function sweepInactiveSessions() {
  return { revoked: 0, changed: false }
}

/**
 * Get session key info for a user.
 * Returns { walletAddress, delegateAddress, delegatePrivateKey, createdAt, active }
 * delegatePrivateKey is decrypted from vault storage.
 *
 * The key lookup resolves aliases: a user may authenticate as EOA (OAuth/SIWE
 * wallet identity) while the session key is stored against the MSCA address.
 * setup stores an `ownerAddress` alias so getSessionKey(EOA) finds the MSCA entry.
 */
export function hasExplicitSessionAlias(userId, walletAddress) {
  const owner = String(userId || '').toLowerCase()
  const wallet = String(walletAddress || '').toLowerCase()
  return Boolean(wallet && storeAliasWallet(owner) === wallet)
}

function storeAliasWallet(owner) {
  const store = loadStore()
  return String(store.aliases?.[String(owner || '').toLowerCase()] || '').toLowerCase()
}

export function getSessionKey(userId, { sweep = true } = {}) {
  // `sweep` remains accepted for API compatibility, but inactivity is not an
  // authorization rule. `lastUsedAt` is audit metadata only.
  void sweep
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = null
  const exact = store.users[key]
  const walletAddr = store.aliases?.[key]
  // An explicit EOA -> MSCA alias is the strongest identity binding. Resolve it
  // before an exact legacy EOA record so an old active EOA session cannot shadow
  // the passkey-selected Agent Wallet used by MCP.
  if (walletAddr && String(walletAddr).toLowerCase() !== key && store.users[String(walletAddr).toLowerCase()]) {
    entry = store.users[String(walletAddr).toLowerCase()]
  }
  // Fall back to an exact owner record only when no distinct explicit alias
  // exists. This preserves legacy direct-MScA lookups and diagnostics.
  if (!entry && exact?.active === true) entry = exact
  // Keep an exact inactive record visible for staleAuthorization diagnostics
  // when no explicit alias exists.
  if (!entry && exact) entry = exact
  if (!entry) return null
  // Do not promote an inactive record through walletAddress alone. Only the
  // explicit alias above may cross an OAuth/EOA → MSCA identity boundary.
  // Likewise, reject a stale exact record before considering any related data;
  // an active-but-unauthorized identity must never inherit another signer.
  if (entry.active === true && !/^0x[0-9a-fA-F]{64}$/.test(String(entry.authorizationUserOpHash || ''))) {
    return { ...entry, active: false, staleAuthorization: true }
  }
  // Decrypt delegate key for in-memory use only (never written back encrypted twice)
  if (entry.delegatePrivateKey && !entry._decrypted) {
    try {
      entry.delegatePrivateKey = decrypt(entry.delegatePrivateKey)
      entry._decrypted = true
    } catch { /* key was stored pre-encryption or corrupted */ }
  }
  return entry
}

/** Resolve the authorization proof for exactly one chain. Legacy fallback is
 * allowed only on the session's original chain; a destination chain must have
 * its own recorded UserOperation hash. */
export function resolveAuthorizationUserOpHash(entry, chainKey = 'arc-testnet') {
  if (!entry) return ''
  const key = String(chainKey)
  // `authorizationUserOpHash` is the legacy Arc authorization field. It must
  // never be reused as proof for Base/Arbitrum destination authorization,
  // even when an old record happens to have `chain` set to that destination.
  if (key === 'arc-testnet') {
    return String(entry.authorizationUserOpHashes?.[key] || entry.authorizationUserOpHash || '')
  }
  return String(entry.authorizationUserOpHashes?.[key] || '')
}

/** Return whether the active delegate was explicitly authorized on a chain. */
export function isSessionAuthorizedForChain(userId, chainKey = 'arc-testnet') {
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(String(chainKey))) return false
  const entry = getSessionKey(userId)
  if (!entry?.active) return false
  const key = String(chainKey)
  return /^0x[0-9a-fA-F]{64}$/.test(resolveAuthorizationUserOpHash(entry, key))
}

/** Record a passkey-confirmed authorization for an additional destination chain. */
export function recordSessionChainAuthorization(userId, { walletAddress, chainKey, authorizationUserOpHash } = {}) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const entry = store.users[wallet.toLowerCase()]
  if (!entry?.active) throw new Error('Active session key required')
  if (getAddress(entry.walletAddress) !== wallet) throw new Error('Session wallet mismatch')
  if (!CHAINS[chainKey]) throw new Error(`Unknown chain: ${chainKey}`)
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) throw new Error(`MSCA unsupported on ${CHAINS[chainKey].name}; use a supported Circle wallet product instead`)
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
  entry.authorizationUserOpHashes = { ...(entry.authorizationUserOpHashes || {}), [chainKey]: authorizationUserOpHash }
  entry.lastAuthorizedChainAt = Date.now()
  saveStore(store)
  return entry
}

/**
 * Generate a new EOA keypair for use as a session/delegate key.
 * Returns { address, privateKey } — caller must persist.
 */
export function generateSessionKey() {
  const pk = generatePrivateKey()
  const account = privateKeyToAccount(pk)
  return { address: account.address, privateKey: pk }
}

/**
 * Reserve an automation signer server-side before the passkey owner authorizes
 * it on-chain. The private key never returns to the browser; it is encrypted
 * at rest and remains inactive until activateReservedSessionKey is called.
 */
export function reserveSessionKey(userId, { walletAddress, chain = 'arc-testnet' } = {}) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const key = wallet.toLowerCase()
  const existing = store.users[key]
  if (existing?.active && /^0x[0-9a-fA-F]{64}$/.test(String(existing.authorizationUserOpHash || ''))) {
    return { address: existing.delegateAddress, walletAddress: wallet, pending: false }
  }
  // A manually revoked record is still eligible for an explicit fresh
  // passkey authorization. The browser must authorize the exact reserved
  // delegate again; no status read or backend boolean can resurrect it.
  // A manual revoke must never be silently resurrected by a passkey retry.
  // Inactivity is different: the on-chain owner is still valid, so the user
  // may explicitly re-activate that exact delegate after a fresh passkey flow.
  // A manual revoke clears the in-store marker only after a fresh passkey
  // authorization succeeds; the on-chain owner is never removed by revoke, so
  // an explicit passkey flow may re-activate the exact same delegate. Until
  // then the record stays protected from any status-read resurrection.
  if (isManuallyRevoked(existing)) {
    // Manual revoke is a local policy event; the old delegate may still be an
    // on-chain owner. Never submit addOwners for that same address again.
    // Rotate the server-held delegate only after the fresh passkey flow reaches
    // this reservation step, preserving the old address in the audit record.
    const generated = generateSessionKey()
    existing.previousDelegateAddress = existing.delegateAddress
    existing.delegateAddress = getAddress(generated.address)
    existing.delegatePrivateKey = encrypt(generated.privateKey)
    existing.pendingAuthorization = true
    existing.active = false
    existing.authorizationUserOpHash = ''
    existing.authorizationUserOpHashes = {}
    existing.revokeReason = undefined
    existing.revokedAt = undefined
    existing.manualRevokePending = false
    existing.createdAt = Date.now()
    existing.lastUsedAt = existing.createdAt
    saveStore(store)
    return { address: existing.delegateAddress, walletAddress: wallet, pending: true, reauthorization: true, rotatedAfterManualRevoke: true }
  }
  // Reuse an inactive delegate with a known authorization proof. Rotating here
  // would create a second owner attempt and could leave the UI/status split
  // across two delegates after a lost browser response.
  if (existing?.delegateAddress && /^0x[0-9a-fA-F]{64}$/.test(String(existing.authorizationUserOpHash || ''))) {
    return { address: existing.delegateAddress, walletAddress: wallet, pending: false, reactivation: true }
  }
  // Keep every pending reservation stable. A missing UserOperation hash is
  // ambiguous: the browser/backend may have lost the response even though
  // addOwners succeeded. Never rotate automatically, because that could create
  // a second active delegate. Recovery requires manual reconciliation and an
  // explicitly reviewed backend operation that records the old delegate.
  if (existing?.pendingAuthorization && existing.delegateAddress) {
    return { address: existing.delegateAddress, walletAddress: wallet, pending: true, hashless: !existing.authorizationUserOpHash }
  }
  const generated = generateSessionKey()
  store.users[key] = {
    walletAddress: wallet,
    delegateAddress: getAddress(generated.address),
    delegatePrivateKey: encrypt(generated.privateKey),
    chain,
    createdAt: Date.now(),
    active: false,
    pendingAuthorization: true,
    lastUsedAt: Date.now(),
  }
  if (!store.aliases) store.aliases = {}
  const aliasOwner = String(userId || '').toLowerCase()
  const boundWallet = String(store.aliases[aliasOwner] || '').toLowerCase()
  if (boundWallet && boundWallet !== key) throw new Error('Identity is already bound to another MSCA; revoke the old session before rebinding.')
  if (aliasOwner) store.aliases[aliasOwner] = wallet
  saveStore(store)
  return { address: getAddress(generated.address), walletAddress: wallet, pending: true }
}

/**
 * Bind an independently authenticated EOA identity to its selected MSCA.
 * `allowRebind` is reserved for callers that have separately proved control
 * of the new MSCA (currently the passkey-backed MCP OAuth flow). Ordinary
 * owner/session setup remains fail-closed and must explicitly revoke first.
 */
// ── Wallet family (append-only) ──
// Every Agent Wallet created or re-bound from a SIWE-verified EOA is linked to
// that EOA forever. The live `aliases` map keeps only the LATEST wallet per
// owner, so without this history a newly created wallet would orphan every
// earlier agent wallet (they would silently vanish from Connected Agents).
// Family links are display-only (agent/wallet listing) and never grant
// execution rights.
function recordWalletFamily(store, walletAddress, rootAddress) {
  const wallet = String(walletAddress || '').toLowerCase()
  const root = String(rootAddress || '').toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !/^0x[0-9a-f]{40}$/.test(root) || wallet === root) return
  if (!store.walletFamily || typeof store.walletFamily !== 'object') store.walletFamily = {}
  // First root wins: append-only, a later rebind must never re-parent a wallet.
  if (!store.walletFamily[wallet]) store.walletFamily[wallet] = root
}

export function bindSessionAlias(userId, ownerAddress, walletAddress, { allowRebind = false } = {}) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const owner = getAddress(ownerAddress).toLowerCase()
  const requester = String(userId || '').toLowerCase()
  const existingOwner = String(store.aliases?.[owner] || '').toLowerCase()
  const existingRequester = String(store.aliases?.[requester] || '').toLowerCase()
  const conflicts = (existingOwner && existingOwner !== wallet.toLowerCase()) || (existingRequester && existingRequester !== wallet.toLowerCase())
  if (conflicts && !allowRebind) {
    throw new Error('Identity is already bound to another MSCA; revoke the old session before rebinding.')
  }
  if (!store.aliases) store.aliases = {}
  // Preserve family history BEFORE the alias overwrite orphans the old wallet.
  if (existingOwner && existingOwner !== wallet.toLowerCase()) recordWalletFamily(store, existingOwner, owner)
  if (existingRequester && existingRequester !== wallet.toLowerCase()) recordWalletFamily(store, existingRequester, owner)
  store.aliases[requester] = wallet
  store.aliases[owner] = wallet
  recordWalletFamily(store, wallet, owner)
  saveStore(store)
  return { ownerAddress: owner, walletAddress: wallet, rebound: Boolean(conflicts) }
}

// ── Per-agent binding store ──
// One row per agent identity (`userId|delegateEoa`) mapping it to the Agent
// Wallet MSCA selected for that agent. Rows live beside users/aliases in the
// same atomic-write session key store; all addresses are stored lowercase.
function normalizeAgentKey(agentKey) {
  return String(agentKey || '').trim().toLowerCase()
}

function normalizeAddressHex(value, label) {
  const address = String(value || '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`${label} must be a valid address`)
  return address
}

/** Bind one agent identity to its Agent Wallet MSCA. Also fills the legacy
 * userId → wallet alias so getSessionKey(userId) keeps resolving to the
 * agent's wallet. An alias that already resolves to an existing user session
 * record (e.g. the passkey flow) is never clobbered here. */
export function bindAgent(agentKey, ownerAddress, walletAddress) {
  const key = normalizeAgentKey(agentKey)
  if (!key) throw new Error('agentKey required')
  const owner = normalizeAddressHex(ownerAddress, 'ownerAddress')
  const wallet = normalizeAddressHex(walletAddress, 'walletAddress')
  const store = loadStore()
  if (!store.agentBindings || typeof store.agentBindings !== 'object') store.agentBindings = {}
  const previous = store.agentBindings[key]
  const now = Date.now()
  store.agentBindings[key] = {
    ownerAddress: owner,
    walletAddress: wallet,
    boundAt: previous?.boundAt ?? now,
    lastUsedAt: now,
  }
  const legacyUserId = key.includes('|') ? key.slice(0, key.indexOf('|')) : ''
  if (legacyUserId) {
    if (!store.aliases || typeof store.aliases !== 'object') store.aliases = {}
    const currentAliasWallet = String(store.aliases[legacyUserId] || '').toLowerCase()
    if (!currentAliasWallet || !store.users?.[currentAliasWallet]) {
      store.aliases[legacyUserId] = wallet
    }
  }
  saveStore(store)
  return { agentKey: key, ownerAddress: owner, walletAddress: wallet, rebound: Boolean(previous) }
}

/** Return the binding row for one agent key, or null when unbound. */
export function getAgentBinding(agentKey) {
  const store = loadStore()
  return store.agentBindings?.[normalizeAgentKey(agentKey)] || null
}

export function bindAgentCredential(agentKey, credentialId, walletAddress) {
  const key = normalizeAgentKey(agentKey)
  const id = String(credentialId || '').trim()
  if (!key || !id) throw new Error('agentKey and credentialId required')
  const store = loadStore()
  const binding = store.agentBindings?.[key]
  if (!binding) throw new Error('agent_not_found')
  if (walletAddress && String(binding.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase()) throw new Error('agent_wallet_mismatch')
  binding.credentialIds = Array.from(new Set([...(binding.credentialIds || []), id]))
  saveStore(store)
  return { ...binding }
}

/** List every binding owned by one owner EOA. */
export function listAgentBindings(ownerAddress) {
  const owner = normalizeAgentKey(ownerAddress)
  const store = loadStore()
  return Object.entries(store.agentBindings || {})
    .filter(([, binding]) => String(binding?.ownerAddress || '').toLowerCase() === owner)
    .map(([agentKey, binding]) => ({ agentKey, ...binding }))
}

/** List bindings visible to a passkey session identity. The vault session
 * token authenticates the MSCA (passkey login), while bindings are keyed to
 * the owner EOA — so an identity is authoritative when it matches either the
 * binding owner EOA or the bound wallet MSCA (Fase 4/5 flow). */
export function listAgentBindingsForIdentity(identityAddress) {
  const identity = normalizeAgentKey(identityAddress)
  const store = loadStore()
  return Object.entries(store.agentBindings || {})
    .filter(([, binding]) =>
      String(binding?.ownerAddress || '').toLowerCase() === identity ||
      String(binding?.walletAddress || '').toLowerCase() === identity)
    .map(([agentKey, binding]) => ({ agentKey, ...binding }))
}

/** Resolve the canonical EOA owner for an authenticated identity/MSCA pair. */
export function resolveOwnerAddressForWallet(identityAddress, walletAddress = '') {
  const identity = normalizeAgentKey(identityAddress)
  const wallet = normalizeAgentKey(walletAddress || identity)
  const store = loadStore()
  // Prefer a distinct owner EOA over a self-alias: connection tokens issued
  // with ownerAddress = the MSCA itself used to trip the self-identity guard
  // in resolveActiveMsca. An EOA root keeps bindings stable across wallet
  // rotation (1 agent = 1 wallet, forever).
  let selfAlias = ''
  for (const [ownerAddress, boundWallet] of Object.entries(store.aliases || {})) {
    if (String(boundWallet || '').toLowerCase() !== wallet || !/^0x[0-9a-f]{40}$/i.test(ownerAddress)) continue
    const ownerK = ownerAddress.toLowerCase()
    if (ownerK !== wallet) return ownerK
    if (!selfAlias) selfAlias = ownerK
  }
  if (selfAlias) return selfAlias
  return /^0x[0-9a-f]{40}$/i.test(identity) ? identity : ''
}

/** True when an identity (EOA or its bound MSCA) owns the binding. */
export function identityOwnsAgentBinding(identityAddress, binding) {
  if (!binding) return false
  const identity = normalizeAgentKey(identityAddress)
  return String(binding.ownerAddress || '').toLowerCase() === identity ||
    String(binding.walletAddress || '').toLowerCase() === identity
}

/** Remove exactly one agent binding row. Returns whether a row was removed;
 * aliases and user session records are left untouched. */
export function revokeAgentBinding(agentKey) {
  const key = normalizeAgentKey(agentKey)
  const store = loadStore()
  const bindings = store.agentBindings
  if (!bindings || typeof bindings !== 'object' || !bindings[key]) return false
  const binding = bindings[key]
  delete bindings[key]
  // Revoke only this agent's session key and aliases when they point to the
  // same wallet; never invalidate another agent sharing the owner identity.
  if (store.users?.[binding.walletAddress]) {
    store.users[binding.walletAddress].active = false
    store.users[binding.walletAddress].revokedAt = Date.now()
    store.users[binding.walletAddress].revokeReason = 'agent_manual'
  }
  saveStore(store)
  return true
}

/** Advance lastUsedAt on one binding without touching any other field.
 * Returns the updated binding, or null when the key is unknown. */
export function touchAgentBinding(agentKey) {
  const key = normalizeAgentKey(agentKey)
  const store = loadStore()
  const binding = store.agentBindings?.[key]
  if (!binding) return null
  binding.lastUsedAt = Date.now()
  saveStore(store)
  return { ...binding }
}

/**
 * Persist a submitted authorization hash without activating the signer.
 * This closes the browser/backend race where the browser receives a hash but
 * times out waiting for its receipt before /api/session/setup is called.
 * A different hash can never replace an existing attempt for the same delegate.
 */
function withSessionStoreLock(fn) {
  const lockPath = `${sessionKeysPath()}.lock`
  const ownerToken = `${process.pid}:${randomUUID()}`
  const ownerPath = `${lockPath}/owner`
  const deadline = Date.now() + 5000
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  mkdirSync(dirname(lockPath), { recursive: true })
  while (true) {
    try {
      mkdirSync(lockPath)
      writeFileSync(ownerPath, JSON.stringify({ token: ownerToken, acquiredAt: Date.now() }), { mode: 0o600 })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
        if (Date.now() - Number(owner?.acquiredAt || 0) > 15000) rmSync(lockPath, { recursive: true, force: true })
      } catch {
        try { if (Date.now() - statSync(lockPath).mtimeMs > 15000) rmSync(lockPath, { recursive: true, force: true }) } catch { /* another worker owns/acquires it */ }
      }
      if (Date.now() >= deadline) throw new Error('Session authorization lock timeout')
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  try { return fn() } finally {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
      if (owner?.token === ownerToken) rmSync(lockPath, { recursive: true, force: true })
    } catch { /* stale recovery or another worker owns the lock */ }
  }
}

export function recordSessionAuthorizationAttempt(userId, { walletAddress, delegateAddress, authorizationUserOpHash, chainKey = 'arc-testnet', previousAuthorizationUserOpHash, previousOutcome = 'unknown' } = {}) {
  return withSessionStoreLock(() => {
    const store = loadStore()
    const wallet = getAddress(walletAddress)
    const delegate = getAddress(delegateAddress)
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
    if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(String(chainKey))) throw new Error(`MSCA unsupported authorization chain: ${chainKey}`)
  const entry = store.users[wallet.toLowerCase()]
  if (!entry?.pendingAuthorization && !entry?.active) throw new Error('No active automation signer reservation')
  if (getAddress(entry.delegateAddress) !== delegate) throw new Error('Automation signer mismatch')
  if (String(chainKey) !== 'arc-testnet' && !entry.authorizationUserOpHashes?.[String(chainKey)]) {
    // Destination-chain attempts require their own explicit reservation state;
    // an Arc legacy proof must never make Base/Arbitrum appear authorized.
    if (!entry.pendingAuthorization && !entry.active) throw new Error(`No reservation for authorization chain: ${chainKey}`)
  }
    const existingHash = resolveAuthorizationUserOpHash(entry, chainKey)
    if (existingHash && existingHash.toLowerCase() !== authorizationUserOpHash.toLowerCase()) {
      // A different hash may replace the previous one only when the old
      // operation is provably gone ('failed' reverted, or 'absent' — no
      // receipt and no indexed operation). Replacing a live 'success' or
      // 'pending' hash could create a duplicate owner.
      const replaceable = previousOutcome === 'failed' || previousOutcome === 'absent'
      if (!previousAuthorizationUserOpHash || existingHash.toLowerCase() !== String(previousAuthorizationUserOpHash).toLowerCase() || !replaceable) {
        throw new Error('A different authorization UserOperation is already recorded')
      }
    }
    entry.authorizationUserOpHashes = { ...(entry.authorizationUserOpHashes || {}), [chainKey]: authorizationUserOpHash }
    // The legacy field is reserved for the original Arc authorization only.
    // Destination-chain proofs must remain in the per-chain map and must never
    // become eligible through the legacy lookup path.
    if (chainKey === 'arc-testnet') entry.authorizationUserOpHash = authorizationUserOpHash
    delete entry.lastAuthorizationOutcome
    delete entry.lastAuthorizationErrorAt
    delete entry.lastAuthorizationTransactionHash
    entry.authorizationAttemptAt = entry.authorizationAttemptAt || Date.now()
    saveStore(store)
    return { walletAddress: wallet, delegateAddress: delegate, chainKey, authorizationUserOpHash }
  })
}

/** Activate only the exact reserved signer after passkey authorization. */
export function validateAuthorizationUserOperation({ walletAddress, delegateAddress, authorizationUserOpHash, receipt, operation } = {}) {
  const wallet = getAddress(walletAddress)
  const delegate = getAddress(delegateAddress)
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) return { ok: false, reason: 'authorizationUserOpHash required' }
  const receiptStatus = receipt?.receipt?.status
  const successfulReceipt = receipt?.success === true && (receiptStatus === 'success' || receiptStatus === '0x1' || receiptStatus === 1 || receiptStatus === true)
  if (!successfulReceipt) return { ok: false, reason: 'authorization UserOperation is not finalized successfully' }
  const receiptSender = receipt.sender || receipt.receipt?.from
  if (!receiptSender || getAddress(receiptSender) !== wallet) return { ok: false, reason: 'authorization sender mismatch' }
  const senderInOperation = operation?.userOperation?.sender || operation?.sender
  if (senderInOperation && getAddress(senderInOperation) !== wallet) return { ok: false, reason: 'indexed authorization sender mismatch' }
  const callData = String(operation?.userOperation?.callData || operation?.callData || '').toLowerCase()
  const expectedAddOwners = encodeFunctionData({
    abi: ADD_OWNERS_ABI,
    functionName: 'addOwners',
    // Circle's registerRecoveryAddress action uses zero to mean "leave the
    // existing weighted-owner threshold unchanged". Passing 1 here changes
    // the threshold during delegate registration and can revert in Circle's
    // MSCA simulation. The delegate still receives weight 1.
    args: [[delegate], [1n], [], [], 0n],
  }).toLowerCase()
  // The SDK's recovery action submits the plugin addOwners calldata directly.
  // Fail closed for wrappers or concatenated payloads: without a known wrapper
  // ABI, substring matching could authorize an unrelated operation.
  if (!callData || callData !== expectedAddOwners) return { ok: false, reason: 'delegate authorization calldata mismatch' }
  return { ok: true, walletAddress: wallet, delegateAddress: delegate, userOpHash: authorizationUserOpHash }
}

export async function getAuthorizationUserOperationOutcome(userOpHash, chainKey = 'arc-testnet') {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(userOpHash || ''))) return 'unknown'
  const chain = CHAINS[chainKey]
  if (!chain || !CLIENT_URL || !CLIENT_KEY) return 'unknown'
  const transport = circleModularHttpTransport(chainKey)
  const client = createPublicClient({ chain: buildViemChain(chainKey), transport })
  try {
    const receipt = await client.request({ method: 'eth_getUserOperationReceipt', params: [userOpHash] })
    if (receipt) {
      const status = receipt.receipt?.status
      if (receipt.success === true && ['success', '0x1', 1, true].includes(status)) return 'success'
      if (receipt.success === false || ['reverted', 'failed', '0x0', 0, false].includes(status)) return 'failed'
      return 'unknown'
    }
    // No receipt: distinguish a UserOperation that is still being processed by
    // the bundler (byHash returns it) from one that is genuinely gone from the
    // index. Only 'absent' may be safely replaced with a fresh addOwners;
    // replacing a still-pending operation could create a duplicate owner.
    const operation = await client.request({ method: 'eth_getUserOperationByHash', params: [userOpHash] }).catch(() => null)
    if (operation) return 'pending'
    return 'absent'
  } catch (error) {
    if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
    return 'unknown'
  }
}

/**
 * Check Circle's owner-to-wallet mapping before retrying an authorization.
 * UserOperation history is bounded in Circle's indexer, but the address mapping
 * is the durable signal needed to avoid submitting duplicate addOwners calls.
 */
export async function getDelegateOwnerMapping(walletAddress, delegateAddress, chainKey = 'arc-testnet') {
  const wallet = getAddress(walletAddress)
  const delegate = getAddress(delegateAddress)
  const chain = CHAINS[chainKey]
  if (!chain || !MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) return { known: false, reason: 'unsupported_chain' }
  if (!CLIENT_URL || !CLIENT_KEY) return { known: false, reason: 'circle_not_configured' }
  const transport = circleModularHttpTransport(chainKey)
  const client = createPublicClient({ chain: buildViemChain(chainKey), transport })
  try {
    const result = await client.request({
      method: 'circle_getAddressMapping',
      params: [{ owner: { type: 'EOAOWNER', identifier: { address: delegate } } }],
    })
    const mappings = Array.isArray(result) ? result : (Array.isArray(result?.mappings) ? result.mappings : [])
    const mapped = mappings.some(item => String(item?.walletAddress || '').toLowerCase() === wallet.toLowerCase())
    return { known: true, mapped, walletAddress: wallet, delegateAddress: delegate }
  } catch (error) {
    if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
    return { known: false, reason: 'owner_mapping_unavailable', walletAddress: wallet, delegateAddress: delegate }
  }
}

function authorizationUserOperationError(receipt, message = 'MSCA authorization UserOperation reverted') {
  const error = new Error(message)
  error.code = 'authorization_userop_failed'
  error.retryAllowed = true
  error.transactionHash = receipt?.receipt?.transactionHash || null
  error.receiptStatus = receipt?.receipt?.status ?? null
  return error
}

export async function verifySessionAuthorization(userId, { walletAddress, delegateAddress, authorizationUserOpHash, chainKey = 'arc-testnet' } = {}) {
  const wallet = getAddress(walletAddress)
  const delegate = getAddress(delegateAddress)
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
  const store = loadStore()
  const entry = store.users[wallet.toLowerCase()]
  if (!entry || (!entry.pendingAuthorization && !entry.active && !entry.authorizationUserOpHash)) throw new Error('No active automation signer reservation')
  if (isManuallyRevoked(entry)) throw new Error('Session key was manually revoked; create a new Agent Wallet or explicitly authorize a new delegate.')
  if (getAddress(entry.delegateAddress) !== delegate) throw new Error('Automation signer mismatch')
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`)
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) throw new Error(`MSCA unsupported on ${chain.name}; use a supported Circle wallet product instead`)
  if (!CLIENT_URL || !CLIENT_KEY) throw new Error('Circle bundler verification is not configured')

  // Do not trust a client-supplied hash merely because it has the right shape.
  // Query Circle's bundler and fail closed unless the operation is finalized,
  // successful, and was submitted by this exact MSCA.
  const transport = circleModularHttpTransport(chainKey)
  const client = createPublicClient({ chain: buildViemChain(chainKey), transport })
  let receipt = null
  let receiptFinalized = false
  // Circle can return the hash before its receipt/status is indexed, and the
  // browser and backend may hit different bundler replicas. Keep polling the
  // same official Client Key endpoint long enough for propagation; never
  // submit another addOwners operation while this hash is unresolved.
  for (let attempt = 0; attempt < 60; attempt++) {
    receipt = await client.request({ method: 'eth_getUserOperationReceipt', params: [authorizationUserOpHash] }).catch(error => {
      if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
      return null
    })
    const status = receipt?.receipt?.status
    const successfulStatus = status === 'success' || status === '0x1' || status === 1 || status === true
    const failedStatus = status === 'reverted' || status === 'failed' || status === '0x0' || status === 0 || status === false
    if (receipt?.success === false || failedStatus) {
      throw authorizationUserOperationError(receipt)
    }
    if (receipt?.success === true && successfulStatus) {
      receiptFinalized = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, attempt < 10 ? 500 : 1000))
  }
  if (!receiptFinalized) throw new Error('MSCA authorization UserOperation is not finalized successfully')

  // The bundler's indexed UserOperation is required as a second binding check.
  // It can lag behind the receipt, so poll it separately. The addOwners
  // selector and reserved delegate must both occur in callData; a successful
  // unrelated operation can never activate this reservation.
  let operation = null
  for (let attempt = 0; attempt < 20; attempt++) {
    operation = await client.request({ method: 'eth_getUserOperationByHash', params: [authorizationUserOpHash] }).catch(error => {
      if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
      return null
    })
    if (operation) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const validation = validateAuthorizationUserOperation({ walletAddress: wallet, delegateAddress: delegate, authorizationUserOpHash, receipt, operation })
  if (!validation.ok) throw new Error(validation.reason)
  return { ...validation, receipt }
}

/**
 * Reconcile an inactive record that still contains a previously successful
 * Arc authorization UserOperation. This is deliberately fail-closed:
 * - records explicitly revoked for a reason other than inactivity are never
 *   resurrected by a status read;
 * - the receipt and indexed operation are checked against the exact MSCA,
 *   delegate, and addOwners calldata before active is restored;
 * - missing/unknown bundler data leaves the record inactive.
 *
 * This repairs the historical split-brain state where vault.json said active
 * while the authoritative session-key store said inactive, without trusting
 * either the browser or stale vault metadata.
 */
export async function reconcileSessionKeyActivation(userId) {
  const store = loadStore()
  const requested = String(userId || '').toLowerCase()
  const walletKey = store.users[requested]
    ? requested
    : String(store.aliases?.[requested] || '').toLowerCase()
  const entry = walletKey ? store.users[walletKey] : null
  if (!entry) return { active: false, reason: 'no_session' }
  if (entry.active === true) return { active: true, walletAddress: entry.walletAddress, delegateAddress: entry.delegateAddress, reconciled: false }
  if (isManuallyRevoked(entry)) return { active: false, reason: 'revoked' }
  // A manual revoke is never resurrected by the on-chain fallback below. The
  // passkey owner must explicitly authorize the delegate again; report the
  // proof as missing so the browser submits a fresh addOwners instead of
  // silently reactivating the old delegate on the strength of its history.
  if (entry.manualRevokePending) return { active: false, reason: 'authorization_proof_missing' }

  const chainKey = entry.chain || 'arc-testnet'
  const hash = resolveAuthorizationUserOpHash(entry, chainKey)
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash || ''))) return { active: false, reason: 'authorization_proof_missing' }
  const chain = CHAINS[chainKey]
  if (!chain || !MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey) || !CLIENT_URL || !CLIENT_KEY) {
    return { active: false, reason: 'authorization_verification_unavailable' }
  }

  const transport = circleModularHttpTransport(chainKey)
  const client = createPublicClient({ chain: buildViemChain(chainKey), transport })
  const receipt = await client.request({ method: 'eth_getUserOperationReceipt', params: [hash] }).catch(error => {
    if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
    return null
  })
  const receiptStatus = receipt?.receipt?.status
  const failedReceipt = receipt?.success === false
    || ['reverted', 'failed', '0x0', 0, false].includes(receiptStatus)
  if (failedReceipt) {
    const transactionHash = receipt?.receipt?.transactionHash || null
    return withSessionStoreLock(() => {
      const latest = loadStore()
      const current = latest.users[walletKey]
      if (!current || current.active === true) return { active: current?.active === true, reconciled: false }
      if (isManuallyRevoked(current)) return { active: false, reason: 'revoked' }
      const currentHash = resolveAuthorizationUserOpHash(current, chainKey)
      if (String(currentHash).toLowerCase() !== String(hash).toLowerCase()) return { active: false, reason: 'authorization_changed' }
      current.lastAuthorizationOutcome = 'failed'
      current.lastAuthorizationErrorAt = Date.now()
      current.lastAuthorizationTransactionHash = transactionHash
      saveStore(latest)
      return {
        active: false,
        reason: 'authorization_failed',
        retryAllowed: true,
        userOpHash: hash,
        transactionHash,
      }
    })
  }
  if (!receipt) {
    // The UserOperation index is bounded. Check the durable Circle owner mapping
    // before treating a missing receipt as proof-missing and retrying addOwners.
    const mapping = await getDelegateOwnerMapping(entry.walletAddress, entry.delegateAddress, chainKey)
    if (mapping.known && mapping.mapped) {
      return withSessionStoreLock(() => {
        const latest = loadStore()
        const current = latest.users[walletKey]
        if (!current || current.active === true) return { active: current?.active === true, reconciled: false }
        if (isManuallyRevoked(current)) return { active: false, reason: 'revoked' }
        const currentHash = resolveAuthorizationUserOpHash(current, chainKey)
        if (String(currentHash).toLowerCase() !== String(hash).toLowerCase()) return { active: false, reason: 'authorization_changed' }
        current.active = true
        current.pendingAuthorization = false
        current.activatedAt = current.activatedAt || Date.now()
        current.lastUsedAt = Date.now()
        current.reconciledAt = Date.now()
        current.reconciledOnChain = true
        delete current.revokedAt
        delete current.revokeReason
        saveStore(latest)
        return { active: true, walletAddress: current.walletAddress, delegateAddress: current.delegateAddress, reconciled: true, userOpHash: hash, restoredOnChain: true }
      })
    }
    if (mapping.known && !mapping.mapped) {
      // A negative address-mapping result is not proof that an old addOwners
      // execution did not land: the mapping API and plugin owner index may
      // have different retention/visibility. Require explicit reconciliation
      // rather than risking a duplicate owner mutation.
      return { active: false, reason: 'authorization_proof_missing', retryAllowed: false, userOpHash: hash }
    }
    return { active: false, reason: 'authorization_unknown', retryAllowed: false, userOpHash: hash }
  }
  const operation = await client.request({ method: 'eth_getUserOperationByHash', params: [hash] }).catch(error => {
    if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
    return null
  })
  const validation = validateAuthorizationUserOperation({
    walletAddress: entry.walletAddress,
    delegateAddress: entry.delegateAddress,
    authorizationUserOpHash: hash,
    receipt,
    operation,
  })
  if (!validation.ok) return { active: false, reason: validation.reason, userOpHash: hash }

  return withSessionStoreLock(() => {
    const latest = loadStore()
    const current = latest.users[walletKey]
    if (!current || current.active === true) return { active: current?.active === true, reconciled: false }
    const currentHash = resolveAuthorizationUserOpHash(current, chainKey)
    if (String(currentHash).toLowerCase() !== String(hash).toLowerCase()) return { active: false, reason: 'authorization_changed' }
    if (isManuallyRevoked(current)) return { active: false, reason: 'revoked' }
    current.active = true
    current.pendingAuthorization = false
    current.activatedAt = current.activatedAt || Date.now()
    current.lastUsedAt = Date.now()
    delete current.revokedAt
    delete current.revokeReason
    current.reconciledAt = Date.now()
    saveStore(latest)
    return { active: true, walletAddress: current.walletAddress, delegateAddress: current.delegateAddress, reconciled: true, userOpHash: hash }
  })
}

export function activateReservedSessionKey(userId, { walletAddress, delegateAddress, authorizationUserOpHash } = {}) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const entry = store.users[wallet.toLowerCase()]
  if (!entry || (!entry.pendingAuthorization && !entry.authorizationUserOpHash)) throw new Error('No pending automation signer reservation')
  if (isManuallyRevoked(entry)) throw new Error('Session key was manually revoked; create a new Agent Wallet or explicitly authorize a new delegate.')
  if (getAddress(entry.delegateAddress) !== getAddress(delegateAddress)) throw new Error('Automation signer mismatch')
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
  entry.active = true
  entry.pendingAuthorization = false
  // Session setup is the original Arc authorization flow. Keep the legacy
  // field Arc-only; Base/Arbitrum authorization is recorded separately by
  // recordSessionChainAuthorization and never activates the signer here.
  const authorizationChain = 'arc-testnet'
  entry.authorizationUserOpHashes = { ...(entry.authorizationUserOpHashes || {}), [authorizationChain]: authorizationUserOpHash }
  entry.authorizationUserOpHash = authorizationUserOpHash
  entry.activatedAt = Date.now()
  entry.lastUsedAt = entry.activatedAt
  delete entry.revokedAt
  delete entry.revokeReason
  delete entry.manualRevokePending
  saveStore(store)
  return entry
}

/**
 * All addresses belonging to the same user cluster: the given identity plus
 * every MSCA session key this user owns. Lets MCP-connection queries aggregate
 * sessions across the EOA (OAuth/SIWE identity) and any MSCA wallet addresses.
 */
export function listRelatedAddresses(userId) {
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  const set = new Set([key])
  const users = Object.entries(store.users || {})
  const aliases = Object.entries(store.aliases || {})
  // Wallet family links: persisted (recorded at bind/rebind time) merged with
  // links derivable from the current store (agent bindings with a distinct
  // owner EOA + current alias rows). This keeps earlier agent wallets visible
  // no matter which wallet of the same account is currently active.
  const family = new Map()
  const addFamily = (wallet, root) => {
    const wk = String(wallet || '').toLowerCase()
    const rk = String(root || '').toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(wk) || !/^0x[0-9a-f]{40}$/.test(rk) || wk === rk) return
    if (!family.has(wk)) family.set(wk, rk)
  }
  for (const [w, root] of Object.entries(store.walletFamily || {})) addFamily(w, root)
  for (const [, b] of Object.entries(store.agentBindings || {})) addFamily(b?.walletAddress, b?.ownerAddress)
  for (const [aliasOwner, wallet] of aliases) addFamily(wallet, aliasOwner)
  // Forward and reverse alias links (EOA <-> MSCA)
  const aliasWallet = store.aliases?.[key]
  if (aliasWallet) set.add(aliasWallet.toLowerCase())
  // Single-pass transitive closure over owner <-> walletAddress, alias, and
  // family links.
  let grew = true
  while (grew) {
    grew = false
    for (const [aliasOwner, wallet] of aliases) {
      const ownerK = aliasOwner.toLowerCase()
      const walletK = String(wallet || '').toLowerCase()
      if (set.has(ownerK) && !set.has(walletK)) { set.add(walletK); grew = true }
      if (set.has(walletK) && !set.has(ownerK)) { set.add(ownerK); grew = true }
    }
    for (const [owner, entry] of users) {
      if (!entry) continue
      const ownerK = owner.toLowerCase()
      const walletK = entry.walletAddress ? String(entry.walletAddress).toLowerCase() : null
      if (set.has(ownerK) && walletK && !set.has(walletK)) { set.add(walletK); grew = true }
      if (walletK && set.has(walletK) && !set.has(ownerK)) { set.add(ownerK); grew = true }
    }
    for (const [wallet, root] of family) {
      if (set.has(wallet) && !set.has(root)) { set.add(root); grew = true }
      if (set.has(root) && !set.has(wallet)) { set.add(wallet); grew = true }
    }
  }
  return [...set]
}

/**
 * Mark an explicitly resolved session key as used now (updates lastUsedAt).
 * There is deliberately no global "latest active wallet" fallback: an OAuth
 * identity must have an explicit alias to an MSCA before it can execute.
 */
export function touchSessionKey(userId) {
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = null
  const walletAddr = store.aliases?.[key]
  // Keep touch and read resolution identical: an explicit EOA -> MSCA alias
  // must win over an active legacy EOA record.
  if (walletAddr && String(walletAddr).toLowerCase() !== key && store.users[String(walletAddr).toLowerCase()]) {
    entry = store.users[String(walletAddr).toLowerCase()]
  }
  if (!entry && store.users[key]?.active === true) entry = store.users[key]
  if (!entry || entry.active !== true) return null
  entry.lastUsedAt = Date.now()
  saveStore(store)
  return entry
}

/**
 * Store session key for a user (called after frontend passkey setup + mapping).
 * delegatePrivateKey is encrypted at rest using SESSION_KEY_ENCRYPTION_KEY.
 * @param options.chain — chain key (e.g., 'arc-testnet', 'ethereum-sepolia')
 */
// ── MSCA live-token probe (anti-cross-agent revoke) ──
// mcpServer.mjs registers this probe so storeSessionKey can ask whether any
// live OAuth token still references an MSCA before auto-revoking its session
// record during a new setup. One-way registration avoids an import cycle.
let mscaLiveTokenProbe = null
export function registerMscaLiveTokenProbe(fn) {
  mscaLiveTokenProbe = typeof fn === 'function' ? fn : null
}

function mscaHasLiveToken(walletAddress) {
  try {
    return mscaLiveTokenProbe ? Boolean(mscaLiveTokenProbe(String(walletAddress || '').toLowerCase())) : false
  } catch {
    // Fail open on probe errors: keep the old session alive rather than
    // killing another agent's active wallet because of a transient error.
    return true
  }
}

export function storeSessionKey(userId, { walletAddress, delegateAddress, delegatePrivateKey, chain = 'arc-testnet', ownerAddress }) {
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  // One active session key per identity. If a DIFFERENT MSCA is already active
  // for the same EOA owner, revoke it so auto-detect is unambiguous.
  if (ownerAddress) {
    const ownerKey = String(ownerAddress).toLowerCase()
    const staleAlias = store.aliases?.[ownerKey]
    if (staleAlias && staleAlias.toLowerCase() !== getAddress(walletAddress).toLowerCase()) {
      const old = store.users[staleAlias.toLowerCase()]
      if (old && old.active !== false && !mscaHasLiveToken(staleAlias)) {
        // Only deactivate when NO other agent still holds a live OAuth token
        // bound to this wallet (per-agent isolation).
        old.active = false; old.revokedAt = Date.now(); old.replacedBy = getAddress(walletAddress)
      }
    }
    // Also revoke old EOA entry if it exists with a different delegate
    const oldEoa = store.users[ownerKey]
    if (oldEoa && oldEoa.active !== false && oldEoa.delegateAddress !== delegateAddress && !mscaHasLiveToken(oldEoa.walletAddress)) {
      oldEoa.active = false; oldEoa.revokedAt = Date.now(); oldEoa.replacedBy = getAddress(walletAddress)
    }
  }
  store.users[key] = {
    walletAddress: getAddress(walletAddress),
    delegateAddress: getAddress(delegateAddress),
    delegatePrivateKey: encrypt(delegatePrivateKey),
    chain,
    createdAt: Date.now(),
    active: true,
    authorizationUserOpHash: '',
    authorizationUserOpHashes: {},
    lastUsedAt: Date.now(),
  }
  // Alias mapping: EOA (OAuth identity) -> MSCA walletAddress. Lets MCP sessions
  // authenticated as the EOA resolve the MSCA-owned session key.
  if (ownerAddress) {
    if (!store.aliases) store.aliases = {}
    store.aliases[String(ownerAddress).toLowerCase()] = getAddress(walletAddress)
    // Also normalize the reverse (userId -> MSCA) if it differs
    store.aliases[key] = getAddress(walletAddress)
  }
  saveStore(store)
  return store.users[key]
}

// ── Pending transaction queue ──
import { randomUUID } from 'crypto'

export function createPendingTx(userId, { walletAddress, calls, chainKey, paymaster }) {
  const txId = 'tx_' + randomUUID().slice(0, 12)
  const tx = { userId, walletAddress, calls, chainKey, paymaster, status: 'pending', createdAt: Date.now() }
  pendingTxs.set(txId, tx)
  return { txId, ...tx }
}

export function getPendingTx(txId) {
  const tx = pendingTxs.get(txId)
  if (!tx) return null
  if (Date.now() - tx.createdAt > PENDING_TX_TTL) { pendingTxs.delete(txId); return null }
  return tx
}

export function getPendingTxsForUser(userId) {
  const now = Date.now()
  const result = []
  for (const [txId, tx] of pendingTxs) {
    if (now - tx.createdAt > PENDING_TX_TTL) { pendingTxs.delete(txId); continue }
    if (tx.userId === userId) result.push({ txId, ...tx })
  }
  return result
}

export function completePendingTx(txId, { signedUserOp, txHash, explorerUrl, error }) {
  const tx = pendingTxs.get(txId)
  if (!tx) return null
  if (error) { tx.status = 'error'; tx.error = error }
  else if (txHash) { tx.status = 'submitted'; tx.txHash = txHash; tx.explorerUrl = explorerUrl }
  else if (signedUserOp) { tx.status = 'signed'; tx.signedUserOp = signedUserOp }
  return tx
}

// Sweep expired pending transactions. Session activity is audit metadata and
// never disables an otherwise authorized session key.
const _pendingSweep = setInterval(() => {
  const now = Date.now()
  for (const [txId, tx] of pendingTxs) if (now - tx.createdAt > PENDING_TX_TTL) pendingTxs.delete(txId)
}, 60_000)
if (_pendingSweep.unref) _pendingSweep.unref()

/**
 * Mark session key as revoked (does not delete — keep audit trail).
 */
export function revokeSessionKey(userId) {
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = store.users[key]
  if (!entry) {
    const walletAddr = store.aliases?.[key]
    if (walletAddr) entry = store.users[String(walletAddr).toLowerCase()]
  }
  if (!entry) return null
  entry.active = false
  entry.revokedAt = Date.now()
  entry.revokeReason = 'manual'
  entry.pendingAuthorization = false
  saveStore(store)
  return entry
}

/**
 * Check if user has an active session key and is within spending limits.
 */
export function canExecuteViaSession(userId, amount, chainKey, options = {}) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) return { ok: false, reason: 'no_session' }
  if (chainKey !== undefined && !MSCA_SUPPORTED_CHAIN_KEYS.includes(String(chainKey))) {
    return { ok: false, reason: 'msca_unsupported_chain', chain: chainKey }
  }
  if (chainKey !== undefined && !isSessionAuthorizedForChain(userId, chainKey)) {
    return { ok: false, reason: 'session_chain_not_authorized', chain: chainKey }
  }
  // Record real usage so auto-detect picks the MSCA most recently used.
  try { touchSessionKey(userId) } catch { /* non-fatal */ }
  const limits = getLimits(userId)
  // Tolerant parse: Claude/agent may pass "1.5 USDC", "$10", or "1e3".
  const parsed = parseHumanAmount(amount)
  if (parsed === null || parsed <= 0) return { ok: false, reason: 'bad_amount', message: `Amount tidak valid: "${amount}". Gunakan angka saja, contoh "1.5".` }
  const amt = parsed
  if (limits.autoApprove === false) return { ok: false, reason: 'auto_off' }
  if (amt > Number(limits.maxPerTx)) return { ok: false, reason: 'over_limit', limit: limits.maxPerTx }
  // Per-agent daily limit (Fase 3): enforced ONLY when a positive dailyLimit
  // is configured for this agent, and only when the caller identifies itself
  // with an agentKey. Owner-originated (web UI) paths stay on vault limits.
  const agentKey = String(options.agentKey || '').trim()
  const dailyLimit = Number(options.dailyLimit || 0)
  if (agentKey && Number.isFinite(dailyLimit) && dailyLimit > 0) {
    if (wouldExceedDailyLimit(agentKey, amt, dailyLimit)) {
      return { ok: false, reason: 'daily_limit_exceeded', limit: dailyLimit, agentKey }
    }
  }
  return { ok: true, entry, limits }
}

// Extract a positive number from a human amount string. Accepted: "1.5",
// "1,5", "$10", "0.01 USDC", "1e3", " 2 ". Returns null when unparseable.
export function parseHumanAmount(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  // Strip commas used as thousands separators (10,000 -> 10000) but not decimals.
  const cleaned = raw.replace(/,/g, '.')
  const m = cleaned.match(/[+-]?\d+(\.\d+)?([eE][+-]?\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  if (!Number.isFinite(n)) return null
  return n
}

/**
 * Build a viem wallet client for the delegate EOA.
 */
function amountToUnits(value, decimals) {
  const raw = String(value ?? '').trim().replace(',', '.')
  const match = raw.match(/[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
  if (!match) return null
  try {
    const units = parseUnits(match[0], decimals)
    return units > 0n ? units : null
  } catch {
    return null
  }
}

function delegateWalletClient(privateKey, chainKey = 'arc-testnet') {
  const account = privateKeyToAccount(privateKey)
  const chain = buildViemChain(chainKey)
  return createWalletClient({ account, chain, transport: http(CHAINS[chainKey].rpcUrl) })
}

/**
 * Build a Circle Smart Account client using the delegate EOA as owner.
 * This lets the delegate sign UserOperations for the MSCA.
 */
async function buildSmartAccountClient(walletAddress, delegatePrivateKey, chainKey = 'arc-testnet') {
  if (!CLIENT_URL || !CLIENT_KEY) throw new Error('CIRCLE_CLIENT_URL and CIRCLE_CLIENT_KEY must be set')
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`)
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) throw new Error(`MSCA unsupported on ${chain.name}; use a supported Circle wallet product instead`)

  const transport = circleModularHttpTransport(chainKey)
  const viemChain = buildViemChain(chainKey)
  const baseClient = createPublicClient({ chain: viemChain, transport })
  const modularClient = toCircleModularWalletClient({ client: baseClient })

  const ownerAccount = privateKeyToAccount(delegatePrivateKey)

  const smartAccount = await toCircleSmartAccount({
    address: walletAddress,
    client: modularClient,
    owner: ownerAccount,
  })

  return { smartAccount, modularClient, baseClient }
}

/** Build the exact UserOperation parameters used by sendUserOperation. */
export function buildUserOperationParams({ account, calls, chainKey, baseClient, feeProfile } = {}) {
  const params = { account, calls }
  const destinationBridge = ['arc-bridge', 'arc-destination', 'base-destination', 'arbitrum-destination', 'base-to-arc-source', 'arbitrum-to-arc-source', 'arc-pay'].includes(String(feeProfile || ''))
  if (chainKey !== 'arbitrum-sepolia' && !destinationBridge) return params
  return (async () => {
    // Use Circle's UserOperation gas-price recommendation first so the
    // destination operation matches the same envelope expected by Gas Station.
    // Public RPC values remain a fallback when the method is unavailable.
    let circleFees = null
    if (baseClient?.request) {
      const price = await baseClient.request({ method: 'circle_getUserOperationGasPrice', params: [] }).catch(() => null)
      for (const levelName of CIRCLE_GAS_PRICE_LEVELS) {
        const level = price?.[levelName]
        const maxFeePerGas = parseFeeQuantity(level?.maxFeePerGas)
        const maxPriorityFeePerGas = parseFeeQuantity(level?.maxPriorityFeePerGas)
        if (maxFeePerGas !== null && maxPriorityFeePerGas !== null && maxPriorityFeePerGas > 0n && maxFeePerGas >= maxPriorityFeePerGas) {
          circleFees = { maxFeePerGas, maxPriorityFeePerGas }
          break
        }
      }
    }
    const gasPrice = circleFees?.maxFeePerGas ?? (baseClient?.getGasPrice ? await baseClient.getGasPrice().catch(() => 0n) : 0n)
    const suggestedPriority = circleFees?.maxPriorityFeePerGas ?? (baseClient?.request ? await baseClient.request({ method: 'eth_maxPriorityFeePerGas' }).catch(() => 0n) : 0n)
    const fees = normalizeUserOperationFees({ maxFeePerGas: gasPrice, maxPriorityFeePerGas: suggestedPriority })
    params.maxFeePerGas = fees.maxFeePerGas
    params.maxPriorityFeePerGas = fees.maxPriorityFeePerGas
    // Circle's bundler requires a reasonable verification-gas efficiency. The
    // default 1.5M estimate is far above the actual MSCA signature cost and is
    // rejected for destination receiveMessage operations.
    if (destinationBridge) params.verificationGasLimit = DESTINATION_VERIFICATION_GAS_LIMITS[chainKey] || 290_000n
    return params
  })()
}

export function stripPaymasterFeeOverrides(response = {}) {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas: _maxPriorityFeePerGas, ...paymasterFields } = response || {}
  return paymasterFields
}

export function preserveUserOperationFeeEnvelope(response = {}, fees = {}) {
  const maxFeePerGas = parseFeeQuantity(fees.maxFeePerGas)
  const maxPriorityFeePerGas = parseFeeQuantity(fees.maxPriorityFeePerGas)
  if (maxFeePerGas === null || maxPriorityFeePerGas === null || maxPriorityFeePerGas <= 0n || maxFeePerGas < maxPriorityFeePerGas) {
    throw new Error('Complete non-zero UserOperation fee envelope required')
  }
  return { ...stripPaymasterFeeOverrides(response), maxFeePerGas, maxPriorityFeePerGas }
}

export function paymasterWithFeeOverrides(client, fees) {
  const requestFees = {
    maxFeePerGas: parseFeeQuantity(fees?.maxFeePerGas),
    maxPriorityFeePerGas: parseFeeQuantity(fees?.maxPriorityFeePerGas),
  }
  if (requestFees.maxFeePerGas === null || requestFees.maxPriorityFeePerGas === null) throw new Error('Complete UserOperation fee envelope required')
  return {
    getPaymasterStubData: async request => preserveUserOperationFeeEnvelope(await getPaymasterStubData(client, { ...request, ...requestFees }), requestFees),
    getPaymasterData: async request => preserveUserOperationFeeEnvelope(await getPaymasterData(client, { ...request, ...requestFees }), requestFees),
  }
}

export function resolveSessionPaymasterMode({ chainKey, feeProfile, requested = false } = {}) {
  if (requested !== true) return 'disabled'
  const profile = String(feeProfile || '')
  const arcSourceBridge = chainKey === 'arc-testnet' && ['arc-bridge', 'arbitrum-destination'].includes(profile)
  if (arcSourceBridge) return 'native'
  const circleGasStation = ['arc-destination', 'base-destination', 'arbitrum-destination', 'base-to-arc-source', 'arbitrum-to-arc-source', 'arc-pay'].includes(profile) || chainKey === 'arbitrum-sepolia'
  return circleGasStation ? 'circle-gas-station' : 'default'
}

// A receipt lookup can fail after Circle has already accepted the UserOperation.
// Keep the hash attached to the original error so bridge recovery can poll the
// exact operation instead of creating a hashless, unrecoverable lock.
export function annotateUserOperationError(error, userOpHash, explorerUrl) {
  const target = error instanceof Error ? error : new Error(String(error || 'UserOperation receipt unavailable'))
  if (userOpHash) target.userOpHash = userOpHash
  if (explorerUrl) target.explorerUrl = explorerUrl
  target.code = target.code || 'user_operation_receipt_unavailable'
  return target
}

/**
 * Keep the fee envelope authoritative when a paymaster response is merged into
 * the UserOperation. Some Circle/Arbitrum paymaster responses echo a zero tip;
 * returning those fields would overwrite the validated request immediately
 * before signing/submission. Fee fields are intentionally omitted from the
 * paymaster response because prepareUserOperation retains the request values.
 */
/**
 * Execute calls via the MSCA using the session/delegate key.
 * Returns { status, txHash, explorerUrl } or { status: 'pending_signature', ... }.
 *
 * @param userId — vault user ID (wallet address)
 * @param calls — array of { to, value, data } or { to, value, abi, functionName, args }
 * @param options — { paymaster: true/false, chainKey: string }
 */
export async function executeViaSession(userId, calls, options = {}) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) throw new Error('Session not available: no_session')
  // Record usage for auto-detect. Caller already validated amount — no re-check here.
  try { touchSessionKey(userId) } catch { /* non-fatal */ }

  const chainKey = options.chainKey || entry.chain || 'arc-testnet'
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error(`Session not available: unknown_chain (${chainKey})`)
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) throw new Error(`Session not available: msca_unsupported_chain (${chainKey})`)
  if (!isSessionAuthorizedForChain(userId, chainKey)) {
    throw new Error(`Session not authorized for chain: ${chainKey}`)
  }
  const { smartAccount, modularClient, baseClient } = await buildSmartAccountClient(entry.walletAddress, entry.delegatePrivateKey, chainKey)

  // Override: skip factory initCode when wallet is not yet deployed on-chain.
  // The backend doesn't have the original passkey owner data needed to generate
  // the correct CREATE2 initCode.  Without this override, the SDK sends factory
  // data based on the delegate key alone, which produces a different address
  // and the entry point rejects it ("does not return the expected sender").
  // The wallet must be deployed via the Plugin page (frontend) first.
  smartAccount.getFactoryArgs = async () => ({ factory: undefined, factoryData: undefined })

  // Normalize calls to { to, value, data }
  const normalizedCalls = calls.map(c => {
    if (c.data) return { to: c.to, value: c.value || 0n, data: c.data }
    if (c.abi && c.functionName) {
      return { to: c.to, value: c.value || 0n, data: encodeFunctionData(c) }
    }
    return { to: c.to, value: c.value || 0n, data: '0x' }
  })

  // Submit UserOperation with optional paymaster sponsorship
  const userOpParams = await buildUserOperationParams({ account: smartAccount, calls: normalizedCalls, chainKey, baseClient, feeProfile: options.feeProfile })

  // Arc bridge settlement can pay gas from the MSCA's native USDC balance;
  // using Circle paymaster there triggers the efficiency/stake guard. Rollup
  // destinations remain sponsored, but preserve the non-zero fee envelope
  // because the paymaster response can otherwise overwrite it with zero.
  const paymasterMode = resolveSessionPaymasterMode({ chainKey, feeProfile: options.feeProfile, requested: options.paymaster === true })
  if (paymasterMode === 'native') userOpParams.paymaster = false
  else if (paymasterMode === 'circle-gas-station') userOpParams.paymaster = paymasterWithFeeOverrides(modularClient, userOpParams)
  else if (paymasterMode === 'default') userOpParams.paymaster = true

  let userOpHash
  try {
    userOpHash = await sendUserOperation(modularClient, userOpParams)
  } catch (error) {
    const precheckReason = classifyUserOperationPrecheckError(error)
    if (precheckReason) {
      return { status: 'error', reason: precheckReason, safeToRetry: true, userOpAccepted: 'no', error: String(error?.message || error) }
    }
    // Return Circle/viem's original error so the official bundler response is
    // visible to the caller and can be debugged without local classification.
    throw error
  }
  const explorerBase = String(options.explorerBaseUrl || chain.explorerUrl + '/tx/').replace(/\/?$/, '/')

  // Bundlers can accept a UserOperation before the receipt indexer catches up.
  // Preserve the hash on timeout so callers can poll instead of submitting a
  // duplicate operation (which is especially dangerous for bridge burns).
  let receipt
  try {
    receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash })
  } catch (error) {
    const message = String(error?.message || '')
    const explorerUrl = `${explorerBase}${userOpHash}`
    const contextualError = annotateUserOperationError(error, userOpHash, explorerUrl)
    if (/timed out|timeout|timed-out/i.test(message)) {
      return {
        status: 'pending_confirmation',
        reason: 'user_operation_pending',
        userOpHash,
        explorerUrl,
        error: message,
      }
    }
    // Do not discard the hash on non-timeout receipt/indexer errors. The
    // caller must be able to query the exact operation before retrying.
    throw contextualError
  }

  const receiptTxHash = receipt?.receipt?.transactionHash || null
  const transactionStatus = receipt?.receipt?.status
  const transactionSucceeded = transactionStatus === 'success' || transactionStatus === '0x1' || transactionStatus === 1 || transactionStatus === true
  const transactionFailed = transactionStatus === 'reverted' || transactionStatus === 'failed' || transactionStatus === '0x0' || transactionStatus === 0 || transactionStatus === false
  const success = receipt?.success === true && (options.requireSuccessfulTransactionReceipt !== true || transactionSucceeded)
  if (receipt?.success === true && options.requireSuccessfulTransactionReceipt === true && transactionFailed) {
    return { status: 'error', reason: 'transaction_reverted', txHash: receiptTxHash || null, explorerUrl: receiptTxHash ? `${explorerBase}${receiptTxHash}` : null, userOpHash, receipt }
  }
  if (receipt?.success === true && options.requireSuccessfulTransactionReceipt === true && !transactionSucceeded) {
    return { status: 'pending_confirmation', reason: 'transaction_receipt_status_unavailable', userOpHash, receipt }
  }
  if (success && (options.requireTransactionHash === true || options.requireSuccessfulTransactionReceipt === true) && !receiptTxHash) {
    return {
      status: 'error',
      reason: 'transaction_hash_unavailable',
      userOpHash,
      receipt,
    }
  }
  // Existing send/swap callers retain the historical userOpHash fallback;
  // bridge callers opt into requireTransactionHash because they must query the
  // source receipt and router event before minting on the destination.
  const txHash = receiptTxHash || userOpHash
  const explorerUrl = `${explorerBase}${txHash}`

  return {
    status: success ? 'success' : 'error',
    reason: success ? undefined : (receipt?.success === false ? 'user_operation_failed' : 'transaction_failed'),
    txHash,
    explorerUrl,
    userOpHash,
    receipt,
  }
}

/**
 * Execute a USDC transfer via session key.
 * @param options.chainKey — which chain to execute on (default: session's chain)
 */
export async function sendViaSession(userId, to, amount, token = 'USDC', options = {}) {
  const requestedChain = options.chainKey
  if (requestedChain !== undefined && !CHAINS[requestedChain]) {
    return { status: 'denied', reason: 'unknown_chain', chain: requestedChain }
  }
  if (requestedChain !== undefined && !MSCA_SUPPORTED_CHAIN_KEYS.includes(requestedChain)) {
    return { status: 'denied', reason: 'msca_unsupported_chain', chain: requestedChain }
  }
  const agentKey = String(options.agentKey || '').trim()
  const gate = canExecuteViaSession(userId, amount, requestedChain, { agentKey, dailyLimit: options.dailyLimit || options.agentLimit })
  if (!gate.ok) return { status: 'denied', reason: gate.reason, chain: requestedChain }

  const chainKey = requestedChain || gate.entry?.chain || 'arc-testnet'
  const chain = CHAINS[chainKey]
  if (!chain) return { status: 'denied', reason: 'unknown_chain', chain: chainKey }
  if (!isSessionAuthorizedForChain(userId, chainKey)) {
    return { status: 'denied', reason: 'session_chain_not_authorized', chain: chainKey }
  }

  const tokenAddress = chain.tokens[token]
  if (!tokenAddress && token !== chain.nativeCurrency.symbol) {
    return { status: 'denied', reason: 'token_not_supported', chain: chainKey, token }
  }

  // ERC-20 transfer calldata
  const erc20Abi = [{
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  }]

  const decimals = token === 'USDC' || token === 'EURC' ? 6 : 18
  const parsedAmount = parseHumanAmount(amount)
  if (parsedAmount === null) return { status: 'denied', reason: 'bad_amount' }
  const amountBigInt = amountToUnits(amount, decimals)
  if (amountBigInt === null) return { status: 'denied', reason: 'bad_amount' }

  const executed = await executeViaSession(userId, [{
    to: tokenAddress,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(to), amountBigInt],
  }], { paymaster: true, chainKey })
  if (executed?.status === 'success' && agentKey) {
    recordSpend(agentKey, parsedAmount)
  }
  return executed
}

/**
 * Execute a swap via session key by calling the AMM router.
 * The actual swap routing is handled by the existing /api/swap endpoint —
 * this method signs the prepared calldata via the MSCA.
 *
 * ponytail: swap via session key currently just does a USDC transfer to the
 * treasury. Full AMM routing via MSCA needs the swap router calldata. Upgrade
 * by passing prepared calldata from /api/eoa-swap-prepare.
 */
export async function swapViaSession(userId, { tokenIn, tokenOut, amountIn, preparedCalldata, preparedCalls, chainKey, agentKey, dailyLimit }) {
  const gate = canExecuteViaSession(userId, amountIn, chainKey, { agentKey, dailyLimit })
  if (!gate.ok) return { status: 'denied', reason: gate.reason }

  const chain = chainKey || gate.entry?.chain || 'arc-testnet'

  const calls = Array.isArray(preparedCalls)
    ? preparedCalls
    : preparedCalldata?.to && preparedCalldata?.data
      ? [{ to: preparedCalldata.to, data: preparedCalldata.data, value: preparedCalldata.value || 0n }]
      : []
  if (calls.length > 0 && calls.every(call => call?.to && call?.data)) {
    const executed = await executeViaSession(userId, calls.map(call => ({
      to: getAddress(call.to),
      data: call.data,
      value: call.value || 0n,
    })), { paymaster: true, chainKey: chain })
    if (executed?.status === 'success' && agentKey) {
      recordSpend(agentKey, parseHumanAmount(amountIn) || 0)
    }
    return executed
  }

  // Never silently turn a swap into a treasury transfer. The caller must
  // provide verified router calldata prepared for this exact MSCA and quote.
  return { status: 'denied', reason: 'swap_calldata_required', message: 'Swap MSCA membutuhkan router calldata yang telah diverifikasi.' }
}

/**
 * Get the status of a previously submitted UserOperation.
 */
export function resolveUserOpChainKey(entry, requestedChainKey) {
  const chainKey = requestedChainKey || entry?.chain || 'arc-testnet'
  return { chainKey, explicit: Boolean(requestedChainKey) }
}

export async function getUserOpStatus(userId, userOpHash, requestedChainKey) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) return { status: 'error', reason: 'no_session' }

  const { chainKey } = resolveUserOpChainKey(entry, requestedChainKey)
  const chain = CHAINS[chainKey]
  if (!chain) return { status: 'error', reason: 'unknown_chain' }
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) return { status: 'error', reason: 'msca_unsupported_chain', chain: chainKey }
  if (!CLIENT_URL || !CLIENT_KEY) return { status: 'error', reason: 'circle_not_configured' }
  const transport = circleModularHttpTransport(chainKey)
  const baseClient = createPublicClient({ chain: buildViemChain(chainKey), transport })
  const modularClient = toCircleModularWalletClient({ client: baseClient })

  try {
    const receipt = await modularClient.getUserOperationReceipt({ hash: userOpHash })
    if (!receipt) return { status: 'pending_confirmation' }
    const txHash = receipt?.receipt?.transactionHash || null
    const transactionStatus = receipt?.receipt?.status
    const transactionSucceeded = transactionStatus === 'success'
      || transactionStatus === '0x1'
      || transactionStatus === 1
      || transactionStatus === true
    const transactionFailed = transactionStatus === 'reverted'
      || transactionStatus === 'failed'
      || transactionStatus === '0x0'
      || transactionStatus === 0
      || transactionStatus === false
    if (receipt.success === false || transactionFailed) {
      return { status: 'error', reason: transactionFailed ? 'transaction_reverted' : 'user_operation_failed', userOpHash, txHash, explorerUrl: txHash ? `${String(chain.explorerUrl || '').replace(/\/?$/, '')}/tx/${txHash}` : null, receipt }
    }
    // A UserOperation hash is not an EVM transaction hash. Without the latter
    // we cannot prove a source burn exists or safely continue a bridge.
    if (receipt.success === true && (!txHash || !transactionSucceeded)) {
      return { status: 'pending_confirmation', reason: 'transaction_hash_unavailable', userOpHash, receipt }
    }
    return {
      status: receipt.success ? 'success' : 'error',
      txHash,
      explorerUrl: txHash ? `${String(chain.explorerUrl || '').replace(/\/?$/, '')}/tx/${txHash}` : null,
      receipt,
    }
  } catch {
    return { status: 'pending_confirmation' }
  }
}
