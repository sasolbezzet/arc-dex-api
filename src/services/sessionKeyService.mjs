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
import { sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { encrypt, decrypt } from './crypto.mjs'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { getLimits } from './vaultStore.mjs'
import { CHAINS } from './chains.mjs'

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
  // Keep an in-flight reservation stable. If the browser completed the
  // on-chain UserOperation but the activation request was interrupted, rotating
  // the key here would orphan the authorized delegate and make recovery opaque.
  if (existing?.pendingAuthorization && existing.delegateAddress) {
    return { address: existing.delegateAddress, walletAddress: wallet, pending: true }
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
    args: [[delegate], [1n], [], [], 0n],
  }).toLowerCase()
  // The SDK's recovery action submits the plugin addOwners calldata directly.
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

// Sweep expired pending txs
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
  saveStore(store)
  return entry
}

/**
 * Check if user has an active session key and is within spending limits.
 */
export function canExecuteViaSession(userId, amount, chainKey) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) return { ok: false, reason: 'no_session' }
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

  return { smartAccount, modularClient }
}

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
  if (!CHAINS[chainKey]) throw new Error(`Session not available: unknown_chain (${chainKey})`)
  if (!isSessionAuthorizedForChain(userId, chainKey)) {
    throw new Error(`Session not authorized for chain: ${chainKey}`)
  }
  const { smartAccount, modularClient } = await buildSmartAccountClient(entry.walletAddress, entry.delegatePrivateKey, chainKey)

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
  const userOpParams = {
    account: smartAccount,
    calls: normalizedCalls,
  }

  // ponytail: paymaster support — pass paymaster data when Gas Station is
  // configured. For now, user pays gas in USDC (Arc native token).
  // Upgrade: add paymaster: true when Circle Gas Station policy is set up.
  if (options.paymaster) {
    userOpParams.paymaster = true
  }

  const userOpHash = await sendUserOperation(modularClient, userOpParams)

  // Wait for receipt — Arc has sub-second finality so this is fast
  const receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash })

  const receiptTxHash = receipt?.receipt?.transactionHash || null
  const success = receipt?.success === true
  if (success && options.requireTransactionHash === true && !receiptTxHash) {
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
  const explorerUrl = `https://testnet.arcscan.app/tx/${txHash}`

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
export async function getUserOpStatus(userId, userOpHash) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) return { status: 'error', reason: 'no_session' }

  const chainKey = entry.chain || 'arc-testnet'
  const chain = CHAINS[chainKey]
  if (!chain) return { status: 'error', reason: 'unknown_chain' }
  const transport = toModularTransport(`${CLIENT_URL}/${chain.transportSlug}`, CLIENT_KEY)
  const baseClient = createPublicClient({ chain: buildViemChain(chainKey), transport })
  const modularClient = toCircleModularWalletClient({ client: baseClient })

  try {
    const receipt = await modularClient.getUserOperationReceipt({ hash: userOpHash })
    if (!receipt) return { status: 'pending_confirmation' }
    const txHash = receipt?.receipt?.transactionHash || userOpHash
    return {
      status: receipt.success ? 'success' : 'error',
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      receipt,
    }
  } catch {
    return { status: 'pending_confirmation' }
  }
}
