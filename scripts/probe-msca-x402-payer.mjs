// Read-only feasibility probe (moves no funds): can an ARCOX MSCA be the x402 payer?
//
// x402 settlement is signature-based: the payer signs an EIP-712
// TransferWithAuthorization and a facilitator submits it on-chain. An MSCA is a
// contract account, so the settlement only clears when the verifier accepts an
// ERC-1271 contract signature. This probe answers that without moving money:
//   1. sign a GatewayWalletBatched authorization as an active arc-mainnet MSCA
//      (plain ECDSA vs the SDK's account-encoded signature),
//   2. eth_call the MSCA's isValidSignature for both signatures,
//   3. POST the payload to Circle Gateway's public /v1/x402/verify endpoint for
//      a real Arc marketplace accept and print the facilitator verdict.
//
// Usage: node --env-file=.env scripts/probe-msca-x402-payer.mjs
import { readFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { createPublicClient, getAddress, hashTypedData, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getSessionKey, signTypedDataWithSession } from '../src/services/sessionKeyService.mjs'
import { resolveArcRpc } from '../src/config/arcRpc.mjs'
import { ARC_CHAIN_ID } from '../src/config/arcNetwork.mjs'

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}
const IS_VALID_SIGNATURE_ABI = [{
  type: 'function', name: 'isValidSignature', stateMutability: 'view',
  inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }],
  outputs: [{ name: 'magicValue', type: 'bytes4' }],
}]
const ERC1271_MAGIC = '0x1626ba7e'

function pickArcGatewayAccept() {
  const file = process.env.X402_MARKETPLACE_DB || './x402-marketplace-db.json'
  const db = JSON.parse(readFileSync(file, 'utf8'))
  for (const item of db.items || []) {
    for (const accept of item.accepts || []) {
      const extra = accept.extra || {}
      if (accept.network !== `eip155:${ARC_CHAIN_ID}`) continue
      if (extra.name !== 'GatewayWalletBatched' || !extra.verifyingContract) continue
      return { item, accept }
    }
  }
  return null
}

function pickArcVanillaAccept() {
  const file = process.env.X402_MARKETPLACE_DB || './x402-marketplace-db.json'
  const db = JSON.parse(readFileSync(file, 'utf8'))
  let best = null
  for (const item of db.items || []) {
    for (const accept of item.accepts || []) {
      const extra = accept.extra || {}
      if (accept.network !== `eip155:${ARC_CHAIN_ID}`) continue
      if (extra.name === 'GatewayWalletBatched' || extra.assetTransferMethod === 'permit2') continue
      if (!extra.name || !extra.version) continue
      if (!best || Number(accept.amount) < Number(best.accept.amount)) best = { item, accept }
    }
  }
  return best
}

function pickMainnetSession() {
  const file = process.env.SESSION_KEYS_PATH || './data/session-keys.json'
  const store = JSON.parse(readFileSync(file, 'utf8'))
  for (const raw of Object.values(store.users || {})) {
    if (!raw?.active || raw.chain !== 'arc-mainnet') continue
    const entry = getSessionKey(raw.walletAddress)
    if (entry?.active && entry.delegatePrivateKey) return entry
  }
  return null
}

const session = pickMainnetSession()
if (!session) {
  console.log(JSON.stringify({ ok: false, reason: 'no_active_arc_mainnet_session' }))
  process.exit(0)
}
const target = pickArcGatewayAccept()
if (!target) {
  console.log(JSON.stringify({ ok: false, reason: 'no_arc_gateway_accept_in_mirror' }))
  process.exit(0)
}

const { item, accept } = target
const now = Math.floor(Date.now() / 1000)
const authorization = {
  from: getAddress(session.walletAddress),
  to: getAddress(accept.payTo),
  value: String(BigInt(String(accept.amountBaseUnits))),
  validAfter: String(now - 600),
  // Circle Gateway batches later than a single request: the SDK requires a
  // seven-day window (plus buffer), clamped up from the seller's timeout.
  validBefore: String(now + Math.max(Number(accept.maxTimeoutSeconds || 0), 7 * 24 * 60 * 60 + 100)),
  nonce: `0x${randomBytes(32).toString('hex')}`,
}
const domain = {
  name: String(accept.extra.name),
  version: String(accept.extra.version),
  chainId: ARC_CHAIN_ID,
  verifyingContract: getAddress(accept.extra.verifyingContract),
}
const types = TRANSFER_TYPES
const primaryType = 'TransferWithAuthorization'
const message = {
  from: authorization.from,
  to: authorization.to,
  value: BigInt(authorization.value),
  validAfter: BigInt(authorization.validAfter),
  validBefore: BigInt(authorization.validBefore),
  nonce: authorization.nonce,
}
const digest = hashTypedData({ domain, types, primaryType, message })

// Signature candidates: plain ECDSA (what a naïve implementation produces) and
// the SDK's account-encoded signature (what the module actually validates).
const signer = privateKeyToAccount(session.delegatePrivateKey)
const signatures = {
  plainEcdsa: await signer.signTypedData({ domain, types, primaryType, message }),
}
try {
  signatures.sdkEncoded = await signTypedDataWithSession(session.walletAddress, { domain, types, primaryType, message }, { chainKey: 'arc-mainnet' })
} catch (error) {
  signatures.sdkEncodedError = String(error?.message || error).slice(0, 240)
}

const rpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
const client = createPublicClient({ transport: http(rpc) })
const erc1271 = {}
for (const [name, signature] of Object.entries(signatures)) {
  if (name.endsWith('Error') || !signature) continue
  try {
    const magic = await client.readContract({
      address: authorization.from, abi: IS_VALID_SIGNATURE_ABI, functionName: 'isValidSignature', args: [digest, signature],
    })
    erc1271[name] = { magic, supported: String(magic).toLowerCase() === ERC1271_MAGIC }
  } catch (error) {
    erc1271[name] = { error: String(error?.shortMessage || error?.message || error).slice(0, 240) }
  }
}

// Circle Gateway facilitator verdict for a real Arc accept, using whichever
// signature the account itself validated.
const paymentRequirements = {
  scheme: accept.scheme || 'exact',
  network: accept.network,
  asset: accept.asset,
  amount: String(accept.amountBaseUnits),
  payTo: accept.payTo,
  maxTimeoutSeconds: Number(accept.maxTimeoutSeconds || 3600),
  extra: { name: accept.extra.name, version: accept.extra.version, verifyingContract: accept.extra.verifyingContract },
}
const resource = { url: item.resource, description: String(item.description || item.resource).slice(0, 200), mimeType: 'application/json' }
const facilitator = {}
for (const [name, signature] of Object.entries(signatures)) {
  if (name.endsWith('Error') || !signature) continue
  try {
    const response = await fetch('https://gateway-api.circle.com/v1/x402/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentPayload: { x402Version: 2, resource, accepted: paymentRequirements, payload: { signature, authorization } },
        paymentRequirements,
      }),
    })
    facilitator[name] = { status: response.status, body: await response.json().catch(() => null) }
  } catch (error) {
    facilitator[name] = { error: String(error?.message || error).slice(0, 240) }
  }
}

// 3) Vanilla EIP-3009 on Arc USDC: does the token accept a contract (1271)
// signature through the `bytes signature` overload the official x402
// facilitator settles with? Simulate 1 base unit so the verdict depends on the
// signature, not on the MSCA's balance.
const vanilla = pickArcVanillaAccept()
let vanillaSim = { skipped: true }
if (vanilla) {
  const vAccept = vanilla.accept
  const vAuth = {
    from: authorization.from,
    to: getAddress(vAccept.payTo),
    value: '1',
    validAfter: String(now - 600),
    validBefore: String(now + 3600),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const vDomain = {
    name: String(vAccept.extra.name), version: String(vAccept.extra.version),
    chainId: ARC_CHAIN_ID, verifyingContract: getAddress(vAccept.asset),
  }
  const vMessage = {
    from: vAuth.from, to: vAuth.to, value: 1n,
    validAfter: BigInt(vAuth.validAfter), validBefore: BigInt(vAuth.validBefore), nonce: vAuth.nonce,
  }
  const vDigest = hashTypedData({ domain: vDomain, types, primaryType, message: vMessage })
  let vSignature = ''
  try {
    vSignature = await signTypedDataWithSession(session.walletAddress, { domain: vDomain, types, primaryType, message: vMessage }, { chainKey: 'arc-mainnet' })
  } catch (error) {
    vanillaSim = { error: String(error?.message || error).slice(0, 240) }
  }
  if (vSignature) {
    let account1271 = null
    try {
      account1271 = await client.readContract({ address: vAuth.from, abi: IS_VALID_SIGNATURE_ABI, functionName: 'isValidSignature', args: [vDigest, vSignature] })
    } catch { account1271 = 'call_failed' }
    let balance = null
    try {
      balance = await client.readContract({
        address: getAddress(vAccept.asset),
        abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
        functionName: 'balanceOf', args: [vAuth.from],
      })
    } catch { balance = 'call_failed' }
    let simulation
    try {
      await client.readContract({
        address: getAddress(vAccept.asset),
        abi: [{
          type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable',
          inputs: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' }, { name: 'signature', type: 'bytes' },
          ], outputs: [],
        }],
        functionName: 'transferWithAuthorization',
        args: [vAuth.from, vAuth.to, 1n, BigInt(vAuth.validAfter), BigInt(vAuth.validBefore), vAuth.nonce, vSignature],
      })
      simulation = { accepted: true }
    } catch (error) {
      simulation = { accepted: false, revert: String(error?.shortMessage || error?.message || error).slice(0, 300) }
    }
    vanillaSim = {
      provider: vanilla.item.provider, url: vanilla.item.resource, domain: vDomain,
      payer: vAuth.from, payerUsdcBalance: balance === null ? null : String(balance),
      mscaIsValidSignature: account1271, simulation,
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  session: { walletAddress: authorization.from, delegateAddress: signer.address, chain: session.chain },
  resource: { provider: item.provider, url: item.resource, amountUsdc: accept.amountUsdc },
  erc1271,
  facilitator,
  vanillaSim,
}, null, 2))
