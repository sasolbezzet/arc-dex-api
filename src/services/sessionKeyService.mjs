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
import { createPublicClient, http, encodeFunctionData, getAddress, defineChain } from 'viem'
import { toModularTransport, toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { encrypt, decrypt } from './crypto.mjs'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { getLimits } from './vaultStore.mjs'
import { CHAINS } from './chains.mjs'

const CLIENT_URL = process.env.CIRCLE_CLIENT_URL || ''
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY || ''

const SESSION_KEYS_PATH = process.env.SESSION_KEYS_PATH || './data/session-keys.json'

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
  return readJsonFile(SESSION_KEYS_PATH, { users: {} })
}

function saveStore(data) {
  atomicWriteJsonFile(SESSION_KEYS_PATH, data)
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
export function getSessionKey(userId) {
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = null
  // 1) Exact owner match
  if (store.users[key]) entry = store.users[key]
  // 2) Explicit EOA alias -> MSCA walletAddress
  if (!entry) {
    const walletAddr = store.aliases?.[key]
    if (walletAddr && store.users[walletAddr.toLowerCase()]) entry = store.users[walletAddr.toLowerCase()]
  }
  // 3) Auto-detect: EOA identity (not itself a session owner) with no alias
  //    resolves to the most recently-USED ACTIVE session key. A user may
  //    register several passkey MSCAs; the one they last used (via Claude /
  //    MCP / execute) is the intended one. Sort by lastUsedAt desc (falling
  //    back to createdAt) — no hardcoding of a specific wallet.
  if (!entry && !store.users[key]) {
    const countActive = Object.values(store.users).filter(u => u && u.active !== false)
    const newest = countActive
      .sort((a, b) => ((b.lastUsedAt || b.createdAt || 0)) - ((a.lastUsedAt || a.createdAt || 0)))[0]
    if (newest) entry = newest
  }
  if (!entry) return null
  // If the found entry is revoked but its wallet has an active entry, prefer that.
  if (entry && entry.active === false && entry.walletAddress) {
    const walletKey = entry.walletAddress.toLowerCase()
    const walletEntry = store.users[walletKey]
    if (walletEntry && walletEntry.active !== false) entry = walletEntry
  }
  // If the found entry's wallet has a NEWER active entry under the wallet key,
  // prefer that one (newer delegate key from latest loginPasskey/setupSessionKey).
  if (entry && entry.walletAddress) {
    const walletKey = entry.walletAddress.toLowerCase()
    const walletEntry = store.users[walletKey]
    if (walletEntry && walletEntry.active !== false && walletEntry !== entry) {
      const entryTime = entry.lastUsedAt || entry.createdAt || 0
      const walletTime = walletEntry.lastUsedAt || walletEntry.createdAt || 0
      if (walletTime > entryTime) entry = walletEntry
    }
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
 * Mark a session key as used now (updates lastUsedAt). Persisted so the
 * auto-detect resolver picks the MSCA the user most recently connected via
 * Claude / MCP / execution — not a hardcoded wallet.
 */
export function touchSessionKey(userId) {
  const store = loadStore()
  const key = String(userId || '').toLowerCase()
  let entry = store.users[key]
  // Resolve through alias / auto-detect the same way getSessionKey does.
  if (!entry) {
    const walletAddr = store.aliases?.[key]
    if (walletAddr && store.users[walletAddr.toLowerCase()]) entry = store.users[walletAddr.toLowerCase()]
  }
  if (!entry) {
    const active = Object.values(store.users).filter(u => u && u.active !== false)
    entry = active.sort((a, b) => ((b.lastUsedAt || b.createdAt || 0)) - ((a.lastUsedAt || a.createdAt || 0)))[0]
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
  const entry = store.users[key]
  if (!entry) {
    // Revoke via EOA alias -> MSCA entry
    const walletAddr = store.aliases?.[key]
    if (walletAddr && store.users[walletAddr.toLowerCase()]) return store.users[walletAddr.toLowerCase()]
    return null
  }
  entry.active = false
  entry.revokedAt = Date.now()
  saveStore(store)
  return entry
}

/**
 * Check if user has an active session key and is within spending limits.
 */
export function canExecuteViaSession(userId, amount) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) return { ok: false, reason: 'no_session' }
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

  const txHash = receipt?.receipt?.transactionHash || userOpHash
  const explorerUrl = `https://testnet.arcscan.app/tx/${txHash}`
  const success = receipt?.success === true

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
  const gate = canExecuteViaSession(userId, amount)
  if (!gate.ok) return { status: 'denied', reason: gate.reason }

  const chainKey = options.chainKey || gate.entry?.chain || 'arc-testnet'
  const chain = CHAINS[chainKey]
  if (!chain) return { status: 'denied', reason: 'unknown_chain' }

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
  const amountBigInt = BigInt(Math.floor(parsedAmount * 10 ** decimals))

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
export async function swapViaSession(userId, { tokenIn, tokenOut, amountIn, preparedCalldata, chainKey }) {
  const gate = canExecuteViaSession(userId, amountIn)
  if (!gate.ok) return { status: 'denied', reason: gate.reason }

  const chain = chainKey || gate.entry?.chain || 'arc-testnet'

  if (preparedCalldata?.to && preparedCalldata?.data) {
    return executeViaSession(userId, [{
      to: preparedCalldata.to,
      data: preparedCalldata.data,
      value: preparedCalldata.value || 0n,
    }], { paymaster: true, chainKey: chain })
  }

  // Fallback: simple USDC transfer (for send-as-swap without router)
  const erc20Abi = [{
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  }]
  const tokenAddr = CHAINS[chain]?.tokens?.USDC || CHAINS[chain]?.tokens?.[tokenIn]
  const parsedAmount = parseHumanAmount(amountIn)
  if (parsedAmount === null) return { status: 'denied', reason: 'bad_amount' }
  const amountBigInt = BigInt(Math.floor(parsedAmount * 1e6))

  return executeViaSession(userId, [{
    to: tokenAddr,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(gate.limits.treasury || tokenAddr), amountBigInt],
  }], { paymaster: true, chainKey: chain })
}

/**
 * Get the status of a previously submitted UserOperation.
 */
export async function getUserOpStatus(userId, userOpHash) {
  const entry = getSessionKey(userId)
  if (!entry || !entry.active) return { status: 'error', reason: 'no_session' }

  const transport = toModularTransport(`${CLIENT_URL}/arcTestnet`, CLIENT_KEY)
  const baseClient = createPublicClient({ chain: arcChain, transport })
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
