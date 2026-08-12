// Reproduce the user's 'Execution reverted for an unknown reason' error.
// Scenario: MSCA already deployed, delegate ALREADY an owner (first addOwners
// succeeded but its hash was lost -> record stayed pending/hashless). The
// frontend now submits a SECOND addOwners for the same delegate -> revert?
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { custom, createPublicClient, defineChain, getAddress, encodeFunctionData } from 'viem'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { toWebAuthnAccount, sendUserOperation, createBundlerClient } from 'viem/account-abstraction'
import { base64UrlToBytes, bytesToBase64Url } from 'webauthn-p256'
import { PublicKey } from 'ox'
import { circleModularProxyHeaders } from '../src/services/circleModularProxy.mjs'
import { CHAINS } from '../src/services/chains.mjs'
import { makePasskeyGetFn } from './e2e-webauthn.mjs'

const chainKey = 'arc-testnet'
const chain = CHAINS[chainKey]
const CLIENT_URL = String(process.env.CIRCLE_CLIENT_URL || '').replace(/\/+$/, '')
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY || ''
const PASSKEY_BASE = CLIENT_URL

const st = JSON.parse(readFileSync(process.env.E2E_STATE_PATH || '/tmp/arcox-e2e-state.json', 'utf8'))
console.log('persisted MSCA:', st.msca, '| delegate:', st.delegateAddress)
if (!st.pkcs8 || !st.rpId || !st.credentialId || !st.credential?.publicKey) throw new Error('state missing credential')

const privateKey = await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(st.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])

const transport = custom({
  async request({ method, params }) {
    const res = await fetch(`${PASSKEY_BASE}/${chain.transportSlug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...circleModularProxyHeaders(CLIENT_KEY) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    })
    const json = await res.json().catch(() => ({}))
    if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`)
    return json.result
  },
}, { key: 'Modular wallets transport', name: 'Modular wallets transport' })

const baseClient = createPublicClient({ chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }), transport })
const modularClient = toCircleModularWalletClient({ client: baseClient })

const getFn = makePasskeyGetFn({
  privateKey,
  credentialId: new Uint8Array(base64UrlToBytes(st.credentialId)),
  rpId: st.rpId,
})
const owner = toWebAuthnAccount({
  credential: { id: st.credentialId, publicKey: st.credential.publicKey },
  getFn,
  rpId: st.rpId,
})
const smartAccount = await toCircleSmartAccount({ address: st.msca, client: modularClient, owner })
const deployed = await smartAccount.isDeployed()
console.log('① MSCA deployed on-chain:', deployed)

// Submit addOwners for the SAME delegate that is already an owner — the exact
// situation of 0x41911554 (hash lost, frontend retries the identical userOp).
const delegate = getAddress(st.delegateAddress)
const ADD_OWNERS_ABI = [{
  type: 'function', name: 'addOwners', stateMutability: 'nonpayable',
  inputs: [
    { name: 'ownersToAdd', type: 'address[]' },
    { name: 'weightsToAdd', type: 'uint256[]' },
    { name: 'publicKeyOwnersToAdd', type: 'tuple[]', components: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] },
    { name: 'publicKeyWeightsToAdd', type: 'uint256[]' },
    { name: 'newThresholdWeight', type: 'uint256' },
  ],
  outputs: [],
}]
const callData = encodeFunctionData({ abi: ADD_OWNERS_ABI, functionName: 'addOwners', args: [[delegate], [1n], [], [], 0n] })
const bundlerClient = createBundlerClient({ account: smartAccount, chain: defineChain({ id: chain.id, name: chain.name }), client: baseClient, transport: custom({ async request({ method, params }) { const res = await fetch(`${PASSKEY_BASE}/${chain.transportSlug}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...circleModularProxyHeaders(CLIENT_KEY) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }) }); const json = await res.json().catch(() => ({})); if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`); return json.result } }, { key: 'Modular wallets transport' }), paymaster: true })

console.log('② submitting addOwners for ALREADY-OWNER delegate on DEPLOYED MSCA…')
try {
  const userOpHash = await sendUserOperation(bundlerClient, { account: smartAccount, callData, paymaster: true })
  console.log('   ✅ userOp accepted:', userOpHash)
  const receipt = await (await import('viem/account-abstraction')).waitForUserOperationReceipt(bundlerClient, { hash: userOpHash })
  console.log('   ✅ final:', JSON.stringify({ success: receipt?.success, status: receipt?.receipt?.status, tx: receipt?.receipt?.transactionHash }))
} catch (error) {
  console.log('   ❌ addOwners FAILED with:')
  console.log(String(error?.shortMessage || error?.message || error).slice(0, 1200))
}
