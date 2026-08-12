// test-session-activation-e2e.mjs — REAL end-to-end session activation test.
//
// Simulates the browser passkey owner headlessly (P-256 WebAuthn credential
// registered with Circle's rp_* endpoints) and drives the real flow:
//
//   1. rp_getRegistrationOptions/Verification  → register passkey owner
//   2. toCircleSmartAccount                    → derive the deterministic MSCA
//   3. POST /api/session/generate-key          → reserve server-side delegate EOA
//   4. submit addOwners([delegate],[1],[],[],0) UserOperation signed by passkey
//   5. POST /api/session/authorization-attempt → record the submitted hash
//   6. POST /api/session/setup                 → backend verifies finality + calldata
//   7. GET  /api/session/status                → session must be active
//
// State persists to /tmp/arcox-e2e-state.json so re-runs resume (e.g. when
// setup timed out but the UserOperation later finalized on-chain).
//
// Usage: node --env-file=.env scripts/test-session-activation-e2e.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createPublicClient, custom, defineChain, encodeFunctionData, getAddress } from 'viem'
import { PublicKey } from 'ox'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { toWebAuthnAccount, sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { base64UrlToBytes, bytesToBase64Url } from 'webauthn-p256'
import { circleModularProxyHeaders } from '../src/services/circleModularProxy.mjs'
import { mintOwnerToken } from '../src/services/authToken.mjs'
import { CHAINS } from '../src/services/chains.mjs'
import { createPasskey, makePasskeyGetFn } from './e2e-webauthn.mjs'

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3002'
const STATE_PATH = '/tmp/arcox-e2e-state.json'
const chainKey = 'arc-testnet'
const chain = CHAINS[chainKey]
const CLIENT_URL = process.env.CIRCLE_CLIENT_URL
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY
const PASSKEY_BASE = String(CLIENT_URL).replace(/\/+$/, '')

if (!CLIENT_URL || !CLIENT_KEY) throw new Error('CIRCLE_CLIENT_URL / CIRCLE_CLIENT_KEY required')

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

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
const persist = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

const post = async (path, body, token) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const get = async (path, token) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const rpCall = async (method, params, cookie = '') => {
  const res = await fetch(PASSKEY_BASE, {
    method: 'POST',
    headers: { ...circleModularProxyHeaders(CLIENT_KEY), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json().catch(() => ({}))
  const setCookie = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie().map(v => v.split(';', 1)[0]).filter(Boolean).join('; ')
    : ''
  if (body?.error) throw new Error(`${method} failed: ${JSON.stringify(body.error)}`)
  return { result: body.result, setCookie }
}

async function loadKeyPair() {
  if (!state.pkcs8 || !state.pubX || !state.pubY) return null
  const privateKey = await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(state.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  return { privateKey }
}

// ── 1. Register the passkey owner (once; state persists the key) ──
let keyPair = await loadKeyPair()
if (!keyPair) {
  console.log('① registering passkey with Circle…')
  const options = await rpCall('rp_getRegistrationOptions', [`e2e-passkey-${Date.now()}`])
  const challenge = options.result?.challenge
  const rpId = options.result?.rp?.id || options.result?.rpId
  const userHandle = options.result?.user?.id || ''
  if (!challenge || !rpId) throw new Error(`registration options missing challenge/rp: ${JSON.stringify(options.result)}`)
  if (!userHandle) throw new Error(`registration options missing user.id (required for login userHandle): ${JSON.stringify(options.result)}`)
  console.log('   rpId:', rpId, '| challenge:', String(challenge).slice(0, 16) + '…')
  const passkey = await createPasskey({ rpId, challenge, userHandle })
  const jwk = await webcrypto.subtle.exportKey('jwk', passkey.privateKey)
  state.pkcs8 = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', passkey.privateKey)))
  state.pubX = jwk.x
  state.pubY = jwk.y
  state.credentialId = passkey.credential.id
  state.rpId = rpId
  state.userHandle = userHandle
  persist()

  const verification = await rpCall('rp_getRegistrationVerification', [passkey.credential], options.setCookie)
  if (verification.result !== true) throw new Error(`registration verification failed: ${JSON.stringify(verification.result)}`)
  // rp_getRegistrationVerification returns `true`; the key is registered with
  // Circle. The local ox publicKey matches the registered keypair, so we can
  // build viem's credential object from it directly.
  state.credential = {
    id: passkey.credential.id,
    publicKey: PublicKey.toHex(passkey.publicKey, { compressed: true }),
  }
  persist()
  keyPair = { privateKey: passkey.privateKey }
  console.log('   passkey registered ✓')
} else {
  console.log('① passkey (reused from persisted state) ✓')
}

const credential = state.credential
const rpId = state.rpId
const getFn = makePasskeyGetFn({
  privateKey: keyPair.privateKey,
  credentialId: new Uint8Array(base64UrlToBytes(state.credentialId)),
  rpId,
})

// ── 2. Derive the deterministic MSCA ──
// A plain viem http() transport makes toCircleSmartAccount fall back to a
// local CREATE2 computation with a random salt, which never matches Circle's
// server-side record. The SDK only resolves the canonical wallet address via
// circle_getAddress when transport.key === MODULAR_WALLETS_TRANSPORT_KEY
// ("Modular wallets transport"), so we provide a custom transport that keeps
// that key while still sending the X-AppInfo header Circle requires.
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
const baseClient = createPublicClient({
  chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
  transport,
})
const modularClient = toCircleModularWalletClient({ client: baseClient })
const owner = toWebAuthnAccount({ credential, getFn, rpId })
const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })
const msca = getAddress(smartAccount.address)
state.msca = msca
persist()
console.log('② MSCA            :', msca)

// ── 3. Reserve the server-side delegate ──
const token = mintOwnerToken(msca)
if (!token) throw new Error('Failed to mint owner token (AUTH_SECRET missing?)')
if (!state.delegateAddress) {
  const reserve = await post('/api/session/generate-key', { walletAddress: msca }, token)
  if (reserve.status !== 200 || !reserve.delegateAddress) {
    throw new Error(`generate-key failed: ${reserve.status} ${JSON.stringify(reserve)}`)
  }
  state.delegateAddress = reserve.delegateAddress
  persist()
}
console.log('③ delegate (server):', state.delegateAddress)
const delegate = getAddress(state.delegateAddress)

// ── 4. Submit the addOwners authorization UserOperation ──
if (!state.userOpHash) {
  const callData = encodeFunctionData({
    abi: ADD_OWNERS_ABI,
    functionName: 'addOwners',
    args: [[delegate], [1n], [], [], 0n],
  })
  console.log('④ submitting addOwners UserOperation (paymaster sponsored)…')
  try {
    const userOpHash = await sendUserOperation(modularClient, {
      account: smartAccount,
      callData,
      paymaster: true,
    })
    state.userOpHash = userOpHash
    persist()
    console.log('   userOpHash     :', userOpHash)
    console.log('   awaiting finality on Arc testnet…')
    const receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash, timeout: 120_000 })
    console.log('   receipt        : success =', receipt?.success, '| tx =', receipt?.receipt?.transactionHash)
  } catch (error) {
    console.error('   submit/await failed:', error?.details || error?.shortMessage || error?.message || error)
    console.error('   (hash was not persisted; retry will re-submit)')
    process.exit(1)
  }
}
console.log('⑤ userOpHash      :', state.userOpHash)

// ── 5. Record the submitted hash ──
if (!state.recorded) {
  const attempt = await post('/api/session/authorization-attempt', {
    walletAddress: msca,
    delegateAddress: delegate,
    authorizationUserOpHash: state.userOpHash,
    chainKey,
  }, token)
  console.log('⑥ authorization-attempt:', attempt.status === 200 ? 'recorded' : `FAILED ${JSON.stringify(attempt)}`)
  if (attempt.status !== 200) process.exit(1)
  state.recorded = true
  persist()
}

// ── 6. Activate via setup (backend verifies receipt + indexed operation) ──
console.log('⑦ /api/session/setup (backend polls Circle finality + calldata)…')
const setup = await post('/api/session/setup', {
  walletAddress: msca,
  delegateAddress: delegate,
  authorizationUserOpHash: state.userOpHash,
}, token)
console.log('   setup response:', setup.status, JSON.stringify(setup))

// ── 7. Confirm active ──
const status = await get('/api/session/status', token)
console.log('⑧ /api/session/status:', status.status, JSON.stringify(status.session || status))

if (setup.status === 200 && setup.active === true && status.session?.active === true) {
  console.log('\n✅ SESSION ACTIVE — E2E PASSED')
  console.log('   walletAddress :', msca)
  console.log('   delegateAddress:', delegate)
  console.log('   userOpHash    :', state.userOpHash)
  console.log('   explorer      :', `https://testnet.arcscan.app/userOperation/${state.userOpHash}`)
  process.exit(0)
} else {
  console.log('\n❌ SESSION NOT ACTIVE — E2E FAILED')
  process.exit(1)
}
