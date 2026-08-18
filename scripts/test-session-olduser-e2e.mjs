// E2E: OLD user flow — MSCA already deployed, user logs in with passkey and
// the session must become active again (or re-authorize the delegate).
// Uses the persisted E2E credential (state file) for the existing MSCA so no
// new wallet is created — exactly like an existing user logging back in.
import { readFileSync, writeFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { custom, createPublicClient, defineChain, getAddress, encodeFunctionData, http } from 'viem'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { toWebAuthnAccount, sendUserOperation, waitForUserOperationReceipt, createBundlerClient } from 'viem/account-abstraction'
import { base64UrlToBytes } from 'webauthn-p256'
import { circleModularProxyHeaders } from '../src/services/circleModularProxy.mjs'
import { CHAINS } from '../src/services/chains.mjs'
import { makePasskeyGetFn } from './e2e-webauthn.mjs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001'
const chainKey = 'arc-testnet'
const chain = CHAINS[chainKey]
const CLIENT_URL = String(process.env.CIRCLE_CLIENT_URL || '').replace(/\/+$/, '')
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY || ''

const statePath = process.env.E2E_STATE_PATH || '/tmp/arcox-e2e-state.json'
const st = JSON.parse(readFileSync(statePath, 'utf8'))
const persistedMsca = st.msca || st.walletAddress
console.log('using persisted passkey credential for MSCA:', persistedMsca, '| delegate:', st.delegateAddress)
if (!st.pkcs8 || !st.rpId || !st.credentialId) throw new Error('state file missing credential fields')

const privateKey = await webcrypto.subtle.importKey(
  'pkcs8', Buffer.from(st.pkcs8, 'base64'),
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'],
)

function modularTransport(ck) {
  return http(`${CLIENT_URL}/${CHAINS[ck].transportSlug}`, {
    timeout: 12_000,
    retryCount: 1,
    fetchOptions: { headers: circleModularProxyHeaders(CLIENT_KEY) },
  })
}

// --- 1. Login passkey (same as browser navigator.credentials.get flow) ---
const optsRes = await fetch(`${BASE}/api/auth/passkey-options`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'Login' }) })
const optsJson = await optsRes.json()
const options = optsJson.options
const flowId = optsJson.flowId
const challenge = String(options.challenge || options.publicKey?.challenge || '')
console.log('① login options: rpId', options.rpId, '| challenge', challenge.slice(0, 16) + '…')
if (options.rpId && st.rpId !== options.rpId) console.log('   ⚠ rpId in options differs from credential rpId:', options.rpId, 'vs', st.rpId)

// Browser assertion: navigator.credentials.get returns { id, userHandle,
// response: { signature, clientDataJSON, authenticatorData } }. Circle's
// rp_getLoginVerification rejects a client-side discoverable assertion with a
// blank userHandle, so pass the registered user.id; it also expects the raw
// IEEE P1363 signature a real browser authenticator produces (not the DER
// form ox/viem use for UserOperation signing).
// Circle's rp_getLoginVerification expects the ASN.1 DER signature encoding
// (same format ox/viem produce for UserOperation signing), NOT the raw
// IEEE P1363 r||s bytes.
const getFn = makePasskeyGetFn({ privateKey, credentialId: st.credentialId, rpId: st.rpId, userHandle: st.userHandle || '' })
const assertion = await getFn({ publicKey: { challenge: base64UrlToBytes(challenge), rpId: options.rpId } })
const toB64 = (bytes) => Buffer.from(bytes).toString('base64url')
const rawCredential = {
  id: st.credentialId,
  rawId: st.credentialId,
  type: 'public-key',
  response: {
    // userHandle goes INSIDE response (PublicKeyCredential.toJSON() shape),
    // matching what the browser frontend sends to /api/auth/passkey-login.
    ...(st.userHandle ? { userHandle: st.userHandle } : {}),
    clientDataJSON: toB64(assertion.response.clientDataJSON),
    authenticatorData: toB64(assertion.response.authenticatorData),
    signature: toB64(assertion.response.signature),
  },
}
const verifyRes = await fetch(`${BASE}/api/auth/passkey-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: rawCredential, mode: 'Login', flowId }) })
const verifyJson = await verifyRes.json()
if (!verifyRes.ok || !verifyJson.token) throw new Error(`passkey login failed: ${verifyRes.status} ${JSON.stringify(verifyJson)}`)
const token = verifyJson.token
// Persist only the short-lived vault token for follow-up E2E calls; the
// credential/private key already belongs to this local test state file.
st.token = token
writeFileSync(statePath, JSON.stringify(st, null, 2))
const walletAddress = getAddress(verifyJson.address)
console.log('② passkey login OK → MSCA:', walletAddress, '| matches persisted:', walletAddress.toLowerCase() === persistedMsca.toLowerCase())

// --- 2. Reserve a NEW delegate (this is what a real login does) ---
const reserveRes = await fetch(`${BASE}/api/session/generate-key`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ walletAddress }) })
const reserveJson = await reserveRes.json()
if (!reserveRes.ok) throw new Error(`generate-key failed: ${reserveRes.status} ${JSON.stringify(reserveJson)}`)
const delegateAddress = reserveJson.delegateAddress
console.log('③ reserved delegate:', delegateAddress, '| pending:', reserveJson.pendingAuthorization, '| reactivation:', reserveJson.reactivation)

// --- 3. Ask the backend for its authoritative status BEFORE any owner
// mutation, exactly like the frontend setupSessionKey() does. An old user
// whose delegate is already authorized must not submit a second addOwners
// (it reverts on-chain with 'Execution reverted').
const statusBefore = await fetch(`${BASE}/api/session/status`, { headers: { Authorization: `Bearer ${token}` } })
const statusJson = await statusBefore.json()
console.log('④ backend status:', statusBefore.status, JSON.stringify({ active: statusJson.session?.active, statusReason: statusJson.session?.statusReason, delegate: statusJson.session?.delegateAddress }))
if (statusJson.session?.active === true) {
  console.log('✅ SESSION ALREADY ACTIVE — old user recovered without a new addOwners')
  console.log('   walletAddress :', walletAddress)
  console.log('   delegateAddress:', statusJson.session.delegateAddress)
  process.exit(0)
}

const transport = modularTransport(chainKey)
const baseClient = createPublicClient({ chain: defineChain({ id: chain.id, name: chain.name }), transport })
const modularClient = toCircleModularWalletClient({ client: baseClient })
const smartAccount = await toCircleSmartAccount({
  address: walletAddress,
  client: modularClient,
  owner: toWebAuthnAccount({ credential: { id: st.credentialId, publicKey: verifyJson.credential?.publicKey, raw: rawCredential } }),
})
const deployed = await smartAccount.isDeployed()
console.log('⑤ MSCA deployed on-chain:', deployed)

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
const callData = encodeFunctionData({ abi: ADD_OWNERS_ABI, functionName: 'addOwners', args: [[delegateAddress], [1n], [], [], 0n] })
const bundlerClient = createBundlerClient({ account: smartAccount, chain: defineChain({ id: chain.id, name: chain.name }), client: baseClient, transport: modularTransport(chainKey), paymaster: true })
console.log('⑤ submitting addOwners for new delegate on DEPLOYED MSCA…')
try {
  const userOpHash = await sendUserOperation(bundlerClient, { account: smartAccount, callData, paymaster: true })
  console.log('   userOpHash:', userOpHash)
  const receipt = await waitForUserOperationReceipt(bundlerClient, { hash: userOpHash })
  console.log('   receipt success:', receipt?.success, '| status:', receipt?.receipt?.status, '| tx:', receipt?.receipt?.transactionHash)
  console.log('✅ addOwners SUCCEEDED on deployed MSCA')
  const authRes = await fetch(`${BASE}/api/session/authorization-attempt`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ walletAddress, delegateAddress, authorizationUserOpHash: userOpHash, chainKey }) })
  console.log('⑥ authorization-attempt:', authRes.status, JSON.stringify(await authRes.json()))
  const setupRes = await fetch(`${BASE}/api/session/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ walletAddress, delegateAddress, authorizationUserOpHash: userOpHash }) })
  const setupJson = await setupRes.json()
  console.log('⑦ setup:', setupRes.status, JSON.stringify(setupJson))
  const statusRes = await fetch(`${BASE}/api/session/status`, { headers: { Authorization: `Bearer ${token}` } })
  console.log('⑧ status:', statusRes.status, JSON.stringify((await statusRes.json()).session))
} catch (error) {
  console.log('❌ addOwners FAILED:')
  console.log(String(error?.shortMessage || error?.message || error).slice(0, 900))
  process.exit(1)
}

// --- 4. Cleanup: revoke the extra delegate added in this test to keep store tidy ---
try {
  await fetch(`${BASE}/api/session/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  console.log('⑨ cleanup: session revoked (test-only delegate removed from store)')
} catch { /* non-fatal */ }
