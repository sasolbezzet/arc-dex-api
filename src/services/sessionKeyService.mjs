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
import { sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { encrypt, decrypt } from './crypto.mjs'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { getLimits } from './vaultStore.mjs'
import { CHAINS, MSCA_SUPPORTED_CHAIN_KEYS } from './chains.mjs'

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
const SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000

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
}

function activityTimestampMs(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  // Accept legacy Unix-second timestamps and normalize them in memory. Tiny
  // synthetic fixtures (1, 2, 1000) are treated as missing rather than stale.
  if (numeric >= 1_000_000_000 && numeric < 100_000_000_000) return numeric * 1000
  if (numeric >= 100_000_000_000) return numeric
  return null
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
 * Revoke sessions that have not been used by an agent for 24 hours.
 * The store is persistent, so this check also protects deployments after a
 * restart; the interval below is only a prompt cleanup mechanism.
 *
 * Legacy active records without an activity timestamp are migrated to "now"
 * rather than guessed as stale. New records always write lastUsedAt.
 */
export function sweepInactiveSessions(now = Date.now()) {
  const store = loadStore()
  let changed = false
  let revoked = 0
  for (const entry of Object.values(store.users || {})) {
    if (!entry || entry.active !== true) continue
    // Old records did not persist activity. Do not infer 24h of inactivity
    // from an unrelated creation timestamp; establish a safe migration
    // baseline and let the next 24h of real activity be measured.
    const rawLastActivity = entry.lastUsedAt ?? entry.activatedAt
    const lastActivity = activityTimestampMs(rawLastActivity)
    if (lastActivity === null) {
      entry.lastUsedAt = now
      changed = true
      continue
    }
    if (lastActivity !== Number(rawLastActivity)) {
      entry.lastUsedAt = lastActivity
      changed = true
    }
    if (now - lastActivity >= SESSION_INACTIVITY_MS) {
      entry.active = false
      entry.revokedAt = now
      entry.revokeReason = 'inactivity_24h'
      entry.pendingAuthorization = false
      changed = true
      revoked++
    }
  }
  if (changed) saveStore(store)
  return { revoked, changed }
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
  // Enforce inactivity expiry on every authorization/execution path, not only
  // on the background timer. Status metadata can opt out of persistence and
  // report the same expiry without mutating the store during a GET request.
  if (sweep) sweepInactiveSessions()
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = null
  // 1) Prefer an active exact owner record.
  // Legacy/inactive records for an old OAuth/EOA identity must not shadow an
  // explicit alias that points to the currently active MSCA session.
  const exact = store.users[key]
  if (exact?.active === true) entry = exact
  // 2) Explicit EOA alias -> MSCA walletAddress. Resolve this when the exact
  // record is absent, inactive, or stale; never fall back to a global wallet.
  if (!entry) {
    const walletAddr = store.aliases?.[key]
    if (walletAddr && store.users[String(walletAddr).toLowerCase()]) {
      entry = store.users[String(walletAddr).toLowerCase()]
    }
  }
  // 3) Keep an exact inactive record visible for staleAuthorization diagnostics
  // when no explicit alias exists.
  if (!entry && exact) entry = exact
  if (!entry) return null
  // Status reads may opt out of persistence. Still present an inactivity-expired
  // record as inactive to callers, while leaving the durable revoke marker to
  // the explicit sweep/execute path.
  if (!sweep && entry.active === true) {
    const lastActivity = activityTimestampMs(entry.lastUsedAt ?? entry.activatedAt)
    if (lastActivity !== null && Date.now() - lastActivity >= SESSION_INACTIVITY_MS) {
      return { ...entry, active: false, revokeReason: 'inactivity_24h', stale: true }
    }
  }
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
  if (existing?.revokedAt && existing.revokeReason !== 'inactivity_24h') {
    existing.pendingAuthorization = true
    existing.revokeReason = undefined
    existing.revokedAt = undefined
    saveStore(store)
    return { address: existing.delegateAddress, walletAddress: wallet, pending: true, reauthorization: true }
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

/** Bind an independently authenticated EOA identity to its selected MSCA. */
export function bindSessionAlias(userId, ownerAddress, walletAddress) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const owner = getAddress(ownerAddress).toLowerCase()
  const requester = String(userId || '').toLowerCase()
  const existingOwner = String(store.aliases?.[owner] || '').toLowerCase()
  const existingRequester = String(store.aliases?.[requester] || '').toLowerCase()
  if ((existingOwner && existingOwner !== wallet.toLowerCase()) || (existingRequester && existingRequester !== wallet.toLowerCase())) {
    throw new Error('Identity is already bound to another MSCA; revoke the old session before rebinding.')
  }
  if (!store.aliases) store.aliases = {}
  store.aliases[requester] = wallet
  store.aliases[owner] = wallet
  saveStore(store)
  return { ownerAddress: owner, walletAddress: wallet }
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
      if (!previousAuthorizationUserOpHash || existingHash.toLowerCase() !== String(previousAuthorizationUserOpHash).toLowerCase() || previousOutcome !== 'failed') {
        throw new Error('A different authorization UserOperation is already recorded')
      }
    }
    entry.authorizationUserOpHashes = { ...(entry.authorizationUserOpHashes || {}), [chainKey]: authorizationUserOpHash }
    // The legacy field is reserved for the original Arc authorization only.
    // Destination-chain proofs must remain in the per-chain map and must never
    // become eligible through the legacy lookup path.
    if (chainKey === 'arc-testnet') entry.authorizationUserOpHash = authorizationUserOpHash
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
    if (!receipt) return 'unknown'
    const status = receipt.receipt?.status
    if (receipt.success === true && ['success', '0x1', 1, true].includes(status)) return 'success'
    if (receipt.success === false && ['reverted', 'failed', '0x0', 0, false].includes(status)) return 'failed'
    return 'unknown'
  } catch (error) {
    if (classifyCircleModularError(error)) throw circleModularConfigurationError(error)
    return 'unknown'
  }
}

export async function verifySessionAuthorization(userId, { walletAddress, delegateAddress, authorizationUserOpHash, chainKey = 'arc-testnet' } = {}) {
  const wallet = getAddress(walletAddress)
  const delegate = getAddress(delegateAddress)
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
  const store = loadStore()
  const entry = store.users[wallet.toLowerCase()]
  if (!entry || (!entry.pendingAuthorization && !entry.active && !entry.authorizationUserOpHash)) throw new Error('No active automation signer reservation')
  if (entry.revokedAt && entry.revokeReason !== 'inactivity_24h') throw new Error('Session key was manually revoked; create a new Agent Wallet or explicitly authorize a new delegate.')
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
      throw new Error('MSCA authorization UserOperation reverted')
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
  if (entry.revokedAt && entry.revokeReason !== 'inactivity_24h') return { active: false, reason: 'revoked' }

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
  if (!receipt) return { active: false, reason: 'authorization_pending', userOpHash: hash }
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
    if (current.revokedAt && current.revokeReason !== 'inactivity_24h') return { active: false, reason: 'revoked' }
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
  if (entry.revokedAt && entry.revokeReason !== 'inactivity_24h') throw new Error('Session key was manually revoked; create a new Agent Wallet or explicitly authorize a new delegate.')
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
  // Forward and reverse alias links (EOA <-> MSCA)
  const aliasWallet = store.aliases?.[key]
  if (aliasWallet) set.add(aliasWallet.toLowerCase())
  // Single-pass transitive closure over owner <-> walletAddress and alias links.
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
  }
  return [...set]
}

/**
 * Mark an explicitly resolved session key as used now (updates lastUsedAt).
 * There is deliberately no global "latest active wallet" fallback: an OAuth
 * identity must have an explicit alias to an MSCA before it can execute.
 */
export function touchSessionKey(userId) {
  sweepInactiveSessions()
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = store.users[key]?.active === true ? store.users[key] : null
  // Resolve through the same explicit alias rules as getSessionKey. An
  // inactive/stale exact OAuth record must not be touched when its alias points
  // to the active MSCA entry.
  if (!entry) {
    const walletAddr = store.aliases?.[key]
    if (walletAddr && store.users[String(walletAddr).toLowerCase()]?.active === true) {
      entry = store.users[String(walletAddr).toLowerCase()]
    }
  }
  if (!entry) return null
  entry.lastUsedAt = Date.now()
  saveStore(store)
  return entry
}

/**
 * Store session key for a user (called after frontend passkey setup + mapping).
 * delegatePrivateKey is encrypted at rest using SESSION_KEY_ENCRYPTION_KEY.
 * @param options.chain — chain key (e.g., 'arc-testnet', 'ethereum-sepolia')
 */
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
      if (old && old.active !== false) { old.active = false; old.revokedAt = Date.now(); old.replacedBy = getAddress(walletAddress) }
    }
    // Also revoke old EOA entry if it exists with a different delegate
    const oldEoa = store.users[ownerKey]
    if (oldEoa && oldEoa.active !== false && oldEoa.delegateAddress !== delegateAddress) {
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

// Sweep expired pending txs and inactive sessions. The persistent check in
// getSessionKey/touchSessionKey is authoritative if this timer is delayed.
const _pendingSweep = setInterval(() => {
  const now = Date.now()
  for (const [txId, tx] of pendingTxs) if (now - tx.createdAt > PENDING_TX_TTL) pendingTxs.delete(txId)
  try { sweepInactiveSessions(now) } catch { /* retry on the next interval */ }
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
export function canExecuteViaSession(userId, amount, chainKey) {
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
export function buildUserOperationParams({ account, calls } = {}) {
  // Circle's bundler and Gas Station own fee estimation. Do not replace the
  // official envelope with an application-defined fee floor.
  return { account, calls }
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

  // Circle Gas Station owns sponsorship and fee selection when requested.
  if (options.paymaster === true) userOpParams.paymaster = true

  let userOpHash
  try {
    userOpHash = await sendUserOperation(modularClient, userOpParams)
  } catch (error) {
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
    if (/timed out|timeout|timed-out/i.test(message)) {
      return {
        status: 'pending_confirmation',
        reason: 'user_operation_pending',
        userOpHash,
        explorerUrl: `${explorerBase}${userOpHash}`,
        error: message,
      }
    }
    throw error
  }

  const receiptTxHash = receipt?.receipt?.transactionHash || null
  const transactionStatus = receipt?.receipt?.status
  const transactionSucceeded = transactionStatus === 'success' || transactionStatus === '0x1' || transactionStatus === 1 || transactionStatus === true
  const success = receipt?.success === true && (options.requireSuccessfulTransactionReceipt !== true || transactionSucceeded)
  if (receipt?.success === true && options.requireSuccessfulTransactionReceipt === true && !transactionSucceeded) {
    return { status: 'pending_confirmation', reason: 'transaction_receipt_status_unavailable_or_failed', userOpHash, receipt }
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
  const gate = canExecuteViaSession(userId, amount, requestedChain)
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

  return executeViaSession(userId, [{
    to: tokenAddress,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(to), amountBigInt],
  }], { paymaster: true, chainKey })
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
export async function swapViaSession(userId, { tokenIn, tokenOut, amountIn, preparedCalldata, preparedCalls, chainKey }) {
  const gate = canExecuteViaSession(userId, amountIn)
  if (!gate.ok) return { status: 'denied', reason: gate.reason }

  const chain = chainKey || gate.entry?.chain || 'arc-testnet'

  const calls = Array.isArray(preparedCalls)
    ? preparedCalls
    : preparedCalldata?.to && preparedCalldata?.data
      ? [{ to: preparedCalldata.to, data: preparedCalldata.data, value: preparedCalldata.value || 0n }]
      : []
  if (calls.length > 0 && calls.every(call => call?.to && call?.data)) {
    return executeViaSession(userId, calls.map(call => ({
      to: getAddress(call.to),
      data: call.data,
      value: call.value || 0n,
    })), { paymaster: true, chainKey: chain })
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
