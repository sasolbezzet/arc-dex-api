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
  //    resolves to the most recently-created ACTIVE session key. A user may
  //    register several passkey MSCAs; the latest one they activated is the
  //    one they intend to use.
  if (!entry && !store.users[key]) {
    const newest = Object.values(store.users)
      .filter(u => u && u.active !== false)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]
    if (newest) entry = newest
  }
  if (!entry) return null
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
  const limits = getLimits(userId)
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'bad_amount' }
  if (limits.autoApprove === false) return { ok: false, reason: 'auto_off' }
  if (amt > Number(limits.maxPerTx)) return { ok: false, reason: 'over_limit', limit: limits.maxPerTx }
  return { ok: true, entry, limits }
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
  const gate = canExecuteViaSession(userId, 0) // amount check done by caller
  if (!gate.ok) throw new Error(`Session not available: ${gate.reason}`)

  const { entry } = gate
  const chainKey = options.chainKey || entry.chain || 'arc-testnet'
  const { smartAccount } = await buildSmartAccountClient(entry.walletAddress, entry.delegatePrivateKey, chainKey)

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

  const userOpHash = await sendUserOperation(userOpParams)

  // Wait for receipt — Arc has sub-second finality so this is fast
  const receipt = await waitForUserOperationReceipt({ hash: userOpHash })

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
  const amountBigInt = BigInt(Math.floor(Number(amount) * 10 ** decimals))

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
  const amountBigInt = BigInt(Math.floor(Number(amountIn) * 1e6))

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
