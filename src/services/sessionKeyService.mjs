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
import { createPublicClient, createWalletClient, http, encodeFunctionData, getAddress, defineChain, parseUnits } from 'viem'
import { toModularTransport, toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { getPaymasterData, getPaymasterStubData, sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
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
const ARBITRUM_BUNDLER_MIN_PRIORITY_FEE_WEI = 1_000_000_000n
function configuredArbitrumPriorityFloor() {
  try {
    const configured = BigInt(process.env.ARBITRUM_MIN_PRIORITY_FEE_WEI || '0')
    // Arbitrum Sepolia bundlers currently reject tips below 1 gwei. Treat a
    // lower env override as invalid rather than allowing a paymaster/RPC
    // suggestion such as 400m wei to reach eth_sendUserOperation.
    return configured >= ARBITRUM_BUNDLER_MIN_PRIORITY_FEE_WEI
      ? configured
      : ARBITRUM_BUNDLER_MIN_PRIORITY_FEE_WEI
  } catch {
    return ARBITRUM_BUNDLER_MIN_PRIORITY_FEE_WEI
  }
}
// Arc's bundler also rejects sub-1-gwei priority fees (observed as
// maxPriorityFeePerGas=400000000 during the active-session bridge E2E).
// Keep one conservative floor for both Circle-supported rollup transports.
const ARBITRUM_MIN_PRIORITY_FEE_WEI = configuredArbitrumPriorityFloor()
const ARC_MIN_PRIORITY_FEE_WEI = 1_000_000_000n

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

/** Normalize fee suggestions before they enter an MSCA UserOperation. */
function parseFeeQuantity(value) {
  try {
    if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())) return BigInt(value)
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value)
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  } catch { /* invalid fee is handled by the caller */ }
  return null
}

/**
 * Validate a browser-signed Arbitrum UserOperation without mutating it.
 * Fee changes after signing invalidate the account signature, so the relay
 * must reject an invalid envelope and require the browser to sign again.
 */
export function validateSignedUserOperationFees({ chainKey, signedUserOp } = {}) {
  if (chainKey !== 'arbitrum-sepolia') return { ok: true }
  const maxFeePerGas = parseFeeQuantity(signedUserOp?.maxFeePerGas)
  const maxPriorityFeePerGas = parseFeeQuantity(signedUserOp?.maxPriorityFeePerGas)
  if (maxPriorityFeePerGas === null || maxPriorityFeePerGas < ARBITRUM_MIN_PRIORITY_FEE_WEI) {
    return { ok: false, reason: 'user_operation_priority_fee_too_low', requiredMinPriorityFeePerGas: ARBITRUM_MIN_PRIORITY_FEE_WEI.toString() }
  }
  if (maxFeePerGas === null || maxFeePerGas < maxPriorityFeePerGas) {
    return { ok: false, reason: 'user_operation_max_fee_invalid', requiredMinMaxFeePerGas: maxPriorityFeePerGas.toString() }
  }
  return { ok: true, maxFeePerGas, maxPriorityFeePerGas }
}

export function shouldUseSessionPaymaster({ chainKey, feeProfile, paymaster } = {}) {
  // Circle Gas Station sponsors all supported testnets, including Arc,
  // Base Sepolia, and Arbitrum Sepolia. A zero MSCA native balance is
  // therefore valid when the UserOperation includes paymaster sponsorship.
  // Keep the arguments explicit for callers/tests and future policy routing.
  return paymaster === true
}

export function classifyUserOperationPrecheckError(error) {
  const message = String(error?.message || error || '')
  if (/max operations .*reached for account|account.*unstaked/i.test(message)) return 'bundler_account_reputation_limit'
  if (/paymaster.*stake|signature aggregator.*stake|unstaked/i.test(message)) return 'bundler_stake_requirement'
  if (/precheck failed|maxPriorityFeePerGas|missing or invalid parameters/i.test(message)) return 'user_operation_precheck_failed'
  return null
}

export function isKnownPreSubmissionError(error) {
  return classifyUserOperationPrecheckError(error) !== null
}

export function normalizeArbitrumUserOperationFees({ maxFeePerGas = 0n, maxPriorityFeePerGas = 0n, minPriorityFeePerGas = ARBITRUM_MIN_PRIORITY_FEE_WEI } = {}) {
  let observedMaxFee
  let observedPriority
  try {
    observedMaxFee = BigInt(maxFeePerGas || 0)
    observedPriority = BigInt(maxPriorityFeePerGas || 0)
  } catch {
    observedMaxFee = 0n
    observedPriority = 0n
  }
  if (observedMaxFee < 0n) observedMaxFee = 0n
  if (observedPriority < 0n) observedPriority = 0n
  const minimumPriority = BigInt(minPriorityFeePerGas || ARBITRUM_MIN_PRIORITY_FEE_WEI)
  const priority = observedPriority >= minimumPriority
    ? observedPriority
    : minimumPriority
  // `eth_gasPrice` is the current base-fee-inclusive suggestion on Arbitrum;
  // add the priority floor rather than merely doubling the floor. This keeps
  // maxFeePerGas above the current network price when the RPC is healthy, while
  // still producing a valid non-zero pair when the RPC reports zero.
  const max = observedMaxFee > 0n
    ? observedMaxFee + priority
    : priority * 2n
  return { maxFeePerGas: max, maxPriorityFeePerGas: priority }
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

export function getSessionKey(userId) {
  // Enforce inactivity expiry on every authorization/read path, not only on
  // the background timer. This remains fail-closed after a process restart.
  sweepInactiveSessions()
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
  // A signer is executable only after the new setup flow records an
  // authorization UserOperation hash. Legacy entries remain visible but are
  // denied until re-authorized through the passkey flow.
  if (entry.active === true && !/^0x[0-9a-fA-F]{64}$/.test(String(entry.authorizationUserOpHash || ''))) {
    return { ...entry, active: false, staleAuthorization: true }
  }
  return entry
}

/** Return whether the active delegate was explicitly authorized on a chain. */
export function isSessionAuthorizedForChain(userId, chainKey = 'arc-testnet') {
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(String(chainKey))) return false
  const entry = getSessionKey(userId)
  if (!entry?.active) return false
  const key = String(chainKey)
  if (key === 'arc-testnet') return /^0x[0-9a-fA-F]{64}$/.test(String(entry.authorizationUserOpHashes?.[key] || entry.authorizationUserOpHash || ''))
  return /^0x[0-9a-fA-F]{64}$/.test(String(entry.authorizationUserOpHashes?.[key] || ''))
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
export function reserveSessionKey(userId, { walletAddress, chain = 'arc-testnet', ownerAddress } = {}) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const key = wallet.toLowerCase()
  const existing = store.users[key]
  if (existing?.active && /^0x[0-9a-fA-F]{64}$/.test(String(existing.authorizationUserOpHash || ''))) {
    return { address: existing.delegateAddress, walletAddress: wallet, pending: false }
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
  store.aliases[String(userId || '').toLowerCase()] = wallet
  if (ownerAddress) store.aliases[String(ownerAddress).toLowerCase()] = wallet
  saveStore(store)
  return { address: getAddress(generated.address), walletAddress: wallet, pending: true }
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
    args: [[delegate], [1n], [], [], 1n],
  }).toLowerCase()
  // The SDK's recovery action submits the plugin addOwners calldata directly.
  // Keep this exact payload binding, including threshold weight 1; threshold 0
  // is invalid for the weighted owner plugin and reverts during simulation.
  // Fail closed for wrappers or concatenated payloads: without a known wrapper
  // ABI, substring matching could authorize an unrelated operation.
  if (!callData || callData !== expectedAddOwners) return { ok: false, reason: 'delegate authorization calldata mismatch' }
  return { ok: true, walletAddress: wallet, delegateAddress: delegate, userOpHash: authorizationUserOpHash }
}

export async function verifySessionAuthorization(userId, { walletAddress, delegateAddress, authorizationUserOpHash, chainKey = 'arc-testnet' } = {}) {
  const wallet = getAddress(walletAddress)
  const delegate = getAddress(delegateAddress)
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
  const store = loadStore()
  const entry = store.users[wallet.toLowerCase()]
  if (!entry || (!entry.pendingAuthorization && !entry.active)) throw new Error('No active automation signer reservation')
  if (getAddress(entry.delegateAddress) !== delegate) throw new Error('Automation signer mismatch')
  const chain = CHAINS[chainKey]
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`)
  if (!MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) throw new Error(`MSCA unsupported on ${chain.name}; use a supported Circle wallet product instead`)
  if (!CLIENT_URL || !CLIENT_KEY) throw new Error('Circle bundler verification is not configured')

  // Do not trust a client-supplied hash merely because it has the right shape.
  // Query Circle's bundler and fail closed unless the operation is finalized,
  // successful, and was submitted by this exact MSCA.
  const transport = toModularTransport(`${CLIENT_URL}/${chain.transportSlug}`, CLIENT_KEY)
  const client = createPublicClient({ chain: buildViemChain(chainKey), transport })
  let receipt = null
  // Circle may expose the UserOperation hash before the receipt is indexed.
  // Poll briefly rather than activating a signer on a transient null response.
  for (let attempt = 0; attempt < 20; attempt++) {
    receipt = await client.request({ method: 'eth_getUserOperationReceipt', params: [authorizationUserOpHash] }).catch(() => null)
    if (receipt) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!receipt || receipt.success !== true || receipt.receipt?.status === 'reverted' || receipt.receipt?.status === '0x0') {
    throw new Error('MSCA authorization UserOperation is not finalized successfully')
  }
  // The bundler's indexed UserOperation is required as a second binding check.
  // The addOwners selector and reserved delegate must both occur in callData;
  // a successful unrelated MSCA operation cannot activate this reservation.
  const operation = await client.request({ method: 'eth_getUserOperationByHash', params: [authorizationUserOpHash] }).catch(() => null)
  const validation = validateAuthorizationUserOperation({ walletAddress: wallet, delegateAddress: delegate, authorizationUserOpHash, receipt, operation })
  if (!validation.ok) throw new Error(validation.reason)
  return { ...validation, receipt }
}

export function activateReservedSessionKey(userId, { walletAddress, delegateAddress, authorizationUserOpHash } = {}) {
  const store = loadStore()
  const wallet = getAddress(walletAddress)
  const entry = store.users[wallet.toLowerCase()]
  if (!entry || !entry.pendingAuthorization) throw new Error('No pending automation signer reservation')
  if (getAddress(entry.delegateAddress) !== getAddress(delegateAddress)) throw new Error('Automation signer mismatch')
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(authorizationUserOpHash || ''))) throw new Error('authorizationUserOpHash required')
  entry.active = true
  entry.pendingAuthorization = false
  entry.authorizationUserOpHash = authorizationUserOpHash
  entry.authorizationUserOpHashes = { ...(entry.authorizationUserOpHashes || {}), [entry.chain || 'arc-testnet']: authorizationUserOpHash }
  entry.activatedAt = Date.now()
  entry.lastUsedAt = entry.activatedAt
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

  const transport = toModularTransport(`${CLIENT_URL}/${chain.transportSlug}`, CLIENT_KEY)
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
export async function buildUserOperationParams({ account, calls, chainKey, baseClient, feeProfile } = {}) {
  const params = { account, calls }
  // Circle's Arc and Arbitrum bundlers require a non-trivial priority fee.
  // Normalize only those chains when they are used by bridge settlement;
  // ordinary Arc send/swap/x402 operations retain their established path.
  const bridgeRollupProfile = ['arc-bridge', 'arbitrum-destination'].includes(String(feeProfile || ''))
  if (chainKey === 'arbitrum-sepolia' || (chainKey === 'arc-testnet' && bridgeRollupProfile)) {
    const gasPrice = await baseClient.getGasPrice().catch(() => 0n)
    const suggestedPriority = await baseClient.request({ method: 'eth_maxPriorityFeePerGas' }).catch(() => 0n)
    const normalizedFees = normalizeArbitrumUserOperationFees({
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: suggestedPriority,
      minPriorityFeePerGas: chainKey === 'arc-testnet' ? ARC_MIN_PRIORITY_FEE_WEI : ARBITRUM_MIN_PRIORITY_FEE_WEI,
    })
    params.maxFeePerGas = normalizedFees.maxFeePerGas
    params.maxPriorityFeePerGas = normalizedFees.maxPriorityFeePerGas
  }
  return params
}

/**
 * Keep the fee envelope authoritative when a paymaster response is merged into
 * the UserOperation. Some Circle/Arbitrum paymaster responses echo a zero tip;
 * returning those fields would overwrite the validated request immediately
 * before signing/submission. Fee fields are intentionally omitted from the
 * paymaster response because prepareUserOperation retains the request values.
 */
export function stripPaymasterFeeOverrides(response = {}) {
  const { maxFeePerGas: _maxFeePerGas, maxPriorityFeePerGas: _maxPriorityFeePerGas, ...paymasterFields } = response || {}
  return paymasterFields
}

/**
 * Re-attach the validated fee envelope after a paymaster response. This is
 * deliberately explicit: viem merges paymaster fields into the prepared
 * request, so a Circle response containing zero fee fields must never win.
 */
export function preserveArbitrumFeeEnvelope(response = {}, fees = {}) {
  const paymasterFields = stripPaymasterFeeOverrides(response)
  const maxFeePerGas = BigInt(fees?.maxFeePerGas || 0)
  const maxPriorityFeePerGas = BigInt(fees?.maxPriorityFeePerGas || 0)
  if (maxPriorityFeePerGas <= 0n || maxFeePerGas < maxPriorityFeePerGas) {
    throw new Error('Complete non-zero Arbitrum UserOperation fee envelope required')
  }
  return { ...paymasterFields, maxFeePerGas, maxPriorityFeePerGas }
}

/** Build a paymaster adapter that cannot reintroduce a lower fee envelope. */
export function paymasterWithFeeOverrides(client, fees) {
  const maxFeePerGas = BigInt(fees?.maxFeePerGas || 0)
  const maxPriorityFeePerGas = BigInt(fees?.maxPriorityFeePerGas || 0)
  if (maxPriorityFeePerGas <= 0n || maxFeePerGas < maxPriorityFeePerGas) {
    throw new Error('Complete non-zero UserOperation fee envelope required')
  }
  const requestWithFees = request => ({ ...request, maxFeePerGas, maxPriorityFeePerGas })
  return {
    getPaymasterStubData: async request => preserveArbitrumFeeEnvelope(await getPaymasterStubData(client, requestWithFees(request)), fees),
    getPaymasterData: async request => preserveArbitrumFeeEnvelope(await getPaymasterData(client, requestWithFees(request)), fees),
  }
}

// Backward-compatible export for callers/tests that use the old name.
export const arbitrumPaymasterWithFeeOverrides = paymasterWithFeeOverrides

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

  // Circle Gas Station sponsorship is enabled for every supported MSCA
  // operation when requested. Bridge profiles keep the explicit fee envelope
  // because Arc and Arbitrum bundlers reject sub-1-gwei tips, and a paymaster
  // response must not overwrite those validated fees.
  const rollupFeeProfile = chainKey === 'arbitrum-sepolia' || (chainKey === 'arc-testnet' && ['arc-bridge', 'arbitrum-destination'].includes(String(options.feeProfile || '')))
  if (shouldUseSessionPaymaster({ chainKey, feeProfile: options.feeProfile, paymaster: options.paymaster })) {
    userOpParams.paymaster = rollupFeeProfile
      ? paymasterWithFeeOverrides(modularClient, userOpParams)
      : true
  }

  let userOpHash
  try {
    userOpHash = await sendUserOperation(modularClient, userOpParams)
  } catch (error) {
    const message = String(error?.message || error)
    // These errors are emitted by paymaster/bundler prechecks before a
    // UserOperation hash exists. They are safe to retry with a fresh quote.
    // Unknown transport failures remain thrown so bridge callers stay
    // fail-closed and do not accidentally duplicate a potentially accepted op.
    const precheckReason = classifyUserOperationPrecheckError(error)
    if (precheckReason) {
      return {
        status: 'error',
        reason: precheckReason,
        // The bundler rejected this operation during validation, before it
        // returned a UserOperation hash. It is safe to create a fresh quote;
        // do not mislabel this as an unknown accepted operation, otherwise a
        // stale bridge approval can permanently block the route.
        safeToRetry: true,
        userOpAccepted: 'no',
        error: message,
      }
    }
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
  const transport = toModularTransport(`${CLIENT_URL}/${chain.transportSlug}`, CLIENT_KEY)
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
