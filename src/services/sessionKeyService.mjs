// sessionKeyService.mjs — Circle Modular Wallet session key management.
// Pattern: user creates MSCA via passkey (frontend), then maps a delegate EOA
// as an additional owner via createAddressMapping. The delegate EOA's private
// key is stored server-side and used to sign UserOperations on behalf of the
// agent — no passkey touch needed per tx, within policy limits.
//
// Lifecycle:
//   1. generateSessionKey() → new EOA keypair (stored encrypted in vault)
//   2. installSessionKey(walletAddress, delegateAddress) → createAddressMapping
//   3. executeViaSession(walletAddress, calls, paymaster) → sendUserOperation
//   4. revokeSessionKey(walletAddress, delegateAddress) → remove mapping
//
// ponytail: no on-chain spend limit enforcement yet — limits checked in
// backend (vaultStore). Upgrade to ERC-6900 session key module for on-chain
// enforcement when Circle ships the module SDK.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createPublicClient, http, encodeFunctionData, getAddress } from 'viem'
import { arcTestnet } from 'viem/chains'
import { toModularTransport, toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { encrypt, decrypt } from './crypto.mjs'
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'
import { getLimits } from './vaultStore.mjs'

const CLIENT_URL = process.env.CIRCLE_CLIENT_URL || ''
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY || ''

const SESSION_KEYS_PATH = process.env.SESSION_KEYS_PATH || './data/session-keys.json'
const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID || 5042002)
const ARC_RPC = process.env.ARC_RPC_URL || process.env.RPC || 'https://arc-testnet.drpc.org'

// USDC ERC-20 on Arc Testnet
const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'

// ── Arc chain definition ──
const arcChain = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
})

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
 */
export function getSessionKey(userId) {
  const store = loadStore()
  const entry = store.users[userId.toLowerCase()]
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
 */
export function storeSessionKey(userId, { walletAddress, delegateAddress, delegatePrivateKey }) {
  const store = loadStore()
  store.users[userId.toLowerCase()] = {
    walletAddress: getAddress(walletAddress),
    delegateAddress: getAddress(delegateAddress),
    delegatePrivateKey: encrypt(delegatePrivateKey),
    createdAt: Date.now(),
    active: true,
  }
  saveStore(store)
  return store.users[userId.toLowerCase()]
}

/**
 * Mark session key as revoked (does not delete — keep audit trail).
 */
export function revokeSessionKey(userId) {
  const store = loadStore()
  const entry = store.users[userId.toLowerCase()]
  if (!entry) return null
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
 * Create a viem wallet client for the delegate EOA.
 */
function delegateWalletClient(privateKey) {
  const account = privateKeyToAccount(privateKey)
  return createWalletClient({ account, chain: arcChain, transport: http(ARC_RPC) })
}

/**
 * Build a Circle Smart Account client using the delegate EOA as owner.
 * This lets the delegate sign UserOperations for the MSCA.
 */
async function buildSmartAccountClient(walletAddress, delegatePrivateKey) {
  if (!CLIENT_URL || !CLIENT_KEY) throw new Error('CIRCLE_CLIENT_URL and CIRCLE_CLIENT_KEY must be set')

  const transport = toModularTransport(`${CLIENT_URL}/arcTestnet`, CLIENT_KEY)
  const baseClient = createPublicClient({ chain: arcChain, transport })
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
 * @param options — { paymaster: true/false }
 */
export async function executeViaSession(userId, calls, options = {}) {
  const gate = canExecuteViaSession(userId, 0) // amount check done by caller
  if (!gate.ok) throw new Error(`Session not available: ${gate.reason}`)

  const { entry } = gate
  const { smartAccount } = await buildSmartAccountClient(entry.walletAddress, entry.delegatePrivateKey)

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
 */
export async function sendViaSession(userId, to, amount, token = 'USDC') {
  const gate = canExecuteViaSession(userId, amount)
  if (!gate.ok) return { status: 'denied', reason: gate.reason }

  // ERC-20 transfer calldata
  const erc20Abi = [{
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  }]

  // Arc USDC uses 6 decimals for ERC-20 interface
  const amountBigInt = BigInt(Math.floor(Number(amount) * 1e6))

  return executeViaSession(userId, [{
    to: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(to), amountBigInt],
  }], { paymaster: true })
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
export async function swapViaSession(userId, { tokenIn, tokenOut, amountIn, preparedCalldata }) {
  const gate = canExecuteViaSession(userId, amountIn)
  if (!gate.ok) return { status: 'denied', reason: gate.reason }

  if (preparedCalldata?.to && preparedCalldata?.data) {
    return executeViaSession(userId, [{
      to: preparedCalldata.to,
      data: preparedCalldata.data,
      value: preparedCalldata.value || 0n,
    }], { paymaster: true })
  }

  // Fallback: simple USDC transfer (for send-as-swap without router)
  const erc20Abi = [{
    type: 'function', name: 'transfer', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  }]
  const amountBigInt = BigInt(Math.floor(Number(amountIn) * 1e6))

  return executeViaSession(userId, [{
    to: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(gate.limits.treasury || USDC_ADDRESS), amountBigInt],
  }], { paymaster: true })
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
