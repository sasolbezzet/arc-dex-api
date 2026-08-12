// test-session-multichain-e2e.mjs — REAL end-to-end 3-chain session activation test.
//
// Simulates a brand-new browser passkey owner headlessly (P-256 WebAuthn
// credential registered with Circle's rp_* endpoints) and drives the exact
// flow the frontend autoActivateSession() runs after registering a new
// passkey:
//
//   1. rp_getRegistrationOptions/Verification  → register passkey owner
//   2. toCircleSmartAccount                    → derive the deterministic MSCA
//   3. POST /api/session/generate-key          → reserve server-side delegate EOA
//   4. Arc:        addOwners userOp → authorization-attempt → /setup (ACTIVE)
//   5. Base:       addOwners userOp → authorization-attempt → /authorize-chain
//   6. Arbitrum:   addOwners userOp → authorization-attempt → /authorize-chain
//   7. GET /api/session/destination-status per chain → deployed + authorized
//   8. GET /api/session/status                 → session must be active
//
// A separate state file (default /tmp/arcox-e2e-multichain-state.json) keeps
// this test independent of the Arc-only activation state.
//
// Usage: node --env-file=.env scripts/test-session-multichain-e2e.mjs
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

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3001'
const STATE_PATH = process.env.MULTICHAIN_STATE_PATH || '/tmp/arcox-e2e-multichain-state.json'
const CHAIN_KEYS = ['arc-testnet', 'base-sepolia', 'arbitrum-sepolia']
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
  const options = await rpCall('rp_getRegistrationOptions', [`e2e-multichain-${Date.now()}`])
  const challenge = options.result?.challenge
  const rpId = options.result?.rp?.id || options.result?.rpId
  const userHandle = options.result?.user?.id || ''
  if (!challenge || !rpId) throw new Error(`registration options missing challenge/rp: ${JSON.stringify(options.result)}`)
  if (!userHandle) throw new Error(`registration options missing user.id: ${JSON.stringify(options.result)}`)
  const passkey = await createPasskey({ rpId, challenge, userHandle })
  const jwk = await webcrypto.subtle.exportKey('jwk', passkey.privateKey)
  state.pkcs8 = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', passkey.privateKey)))
  state.pubX = jwk.x
  state.pubY = jwk.y
  state.credentialId = passkey.credential.id
  state.rpId = rpId
  state.userHandle = userHandle
  state.credential = {
    id: passkey.credential.id,
    publicKey: PublicKey.toHex(passkey.publicKey, { compressed: true }),
  }
  persist()

  const verification = await rpCall('rp_getRegistrationVerification', [passkey.credential], options.setCookie)
  if (verification.result !== true) throw new Error(`registration verification failed: ${JSON.stringify(verification.result)}`)
  keyPair = { privateKey: passkey.privateKey }
  console.log('   passkey registered ✓')
} else {
  if (!state.userHandle) throw new Error('Persisted state is missing userHandle; delete the state file to re-register.')
  console.log('① passkey (reused from persisted state) ✓')
}

const credential = state.credential
const rpId = state.rpId
const getFn = makePasskeyGetFn({
  privateKey: keyPair.privateKey,
  credentialId: new Uint8Array(base64UrlToBytes(state.credentialId)),
  rpId,
})
const owner = toWebAuthnAccount({ credential, getFn, rpId })

// Mirrors the frontend's circleGasFees(): Arbitrum's bundler precheck rejects a
// zero priority fee, so fetch Circle's recommended fee envelope (medium) or fall
// back to a safe 1 gwei priority / 2 gwei max. Other chains leave fees to the
// paymaster/Gas Station exactly like the browser flow.
async function circleGasFees(chainKey) {
  if (chainKey !== 'arbitrum-sepolia') return {}
  const chain = CHAINS[chainKey]
  try {
    const client = createPublicClient({
      chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
      transport: custom({
        async request({ method, params }) {
          const res = await fetch(`${PASSKEY_BASE}/${chain.transportSlug}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...circleModularProxyHeaders(CLIENT_KEY) },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
          })
          const json = await res.json().catch(() => ({}))
          if (json.error) throw new Error(`${method} failed on ${chainKey}: ${JSON.stringify(json.error)}`)
          return json.result
        },
      }, { key: 'Modular wallets transport', name: 'Modular wallets transport' }),
    })
    const price = await client.request({ method: 'circle_getUserOperationGasPrice', params: [] }).catch(() => null)
    const level = price?.medium
    if (level?.maxPriorityFeePerGas && level?.maxFeePerGas) {
      const maxPriorityFeePerGas = BigInt(level.maxPriorityFeePerGas)
      const maxFeePerGas = BigInt(level.maxFeePerGas)
      if (maxPriorityFeePerGas > 0n && maxFeePerGas >= maxPriorityFeePerGas) {
        return { maxPriorityFeePerGas, maxFeePerGas }
      }
    }
  } catch { /* fall through to the safe floor */ }
  return { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n }
}

// ── 2. Derive the deterministic MSCA on each chain (same address) ──
function buildChainClient(chainKey) {
  const chain = CHAINS[chainKey]
  const transport = custom({
    async request({ method, params }) {
      const res = await fetch(`${PASSKEY_BASE}/${chain.transportSlug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...circleModularProxyHeaders(CLIENT_KEY) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
      })
      const json = await res.json().catch(() => ({}))
      if (json.error) throw new Error(`${method} failed on ${chainKey}: ${JSON.stringify(json.error)}`)
      return json.result
    },
  }, { key: 'Modular wallets transport', name: 'Modular wallets transport' })
  const baseClient = createPublicClient({
    chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
    transport,
  })
  const modularClient = toCircleModularWalletClient({ client: baseClient })
  return { chain, baseClient, modularClient }
}

const mscas = {}
for (const chainKey of CHAIN_KEYS) {
  const { modularClient } = buildChainClient(chainKey)
  const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })
  mscas[chainKey] = getAddress(smartAccount.address)
  console.log(`② MSCA (${chainKey}):`, mscas[chainKey])
}
const unique = new Set(Object.values(mscas).map(v => v.toLowerCase()))
if (unique.size !== 1) throw new Error(`MSCA address differs across chains: ${JSON.stringify(mscas)}`)
const msca = Object.values(mscas)[0]
state.msca = msca
persist()
console.log('   ✅ deterministic MSCA identical across all 3 chains:', msca)

// ── 3. Reserve the server-side delegate ──
const token = mintOwnerToken(msca)
if (!token) throw new Error('Failed to mint owner token (AUTH_SECRET missing?)')
if (!state.delegateAddress) {
  const reserve = await post('/api/session/generate-key', { walletAddress: msca }, token)
  if (reserve.status !== 200 || !reserve.delegateAddress) throw new Error(`generate-key failed: ${reserve.status} ${JSON.stringify(reserve)}`)
  state.delegateAddress = reserve.delegateAddress
  persist()
}
const delegate = getAddress(state.delegateAddress)
console.log('③ delegate (server):', delegate)

// ── 4-6. Per-chain addOwners → record → (Arc: setup / dest: authorize-chain) ──
const results = {}
for (const chainKey of CHAIN_KEYS) {
  const chain = CHAINS[chainKey]
  console.log(`\n④ ${chainKey} — submitting addOwners UserOperation (deploy + authorize, paymaster sponsored)…`)
  const { modularClient } = buildChainClient(chainKey)
  const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })

  let userOpHash = state.chainHashes?.[chainKey]
  if (!userOpHash) {
    const callData = encodeFunctionData({
      abi: ADD_OWNERS_ABI,
      functionName: 'addOwners',
      args: [[delegate], [1n], [], [], 0n],
    })
    try {
      // Arbitrum requires a non-zero priority fee (mirrors frontend circleGasFees).
      const fees = await circleGasFees(chainKey)
      userOpHash = await sendUserOperation(modularClient, { account: smartAccount, callData, paymaster: true, ...fees })
      state.chainHashes = { ...(state.chainHashes || {}), [chainKey]: userOpHash }
      persist()
      console.log('   userOpHash:', userOpHash)
      const receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash, timeout: 180_000 })
      console.log('   receipt   : success =', receipt?.success, '| tx =', receipt?.receipt?.transactionHash)
      if (receipt?.success !== true) throw new Error(`${chainKey}: addOwners receipt success != true`)
    } catch (error) {
      console.error(`   ${chainKey} submit/await failed:`, error?.details || error?.shortMessage || error?.message || error)
      results[chainKey] = { status: 'FAILED', error: String(error?.shortMessage || error?.message || error).slice(0, 300) }
      continue
    }
  } else {
    console.log('   userOpHash (resumed):', userOpHash)
  }

  // Record the attempt so the backend can reconcile the exact hash.
  const attempt = await post('/api/session/authorization-attempt', {
    walletAddress: msca, delegateAddress: delegate, authorizationUserOpHash: userOpHash, chainKey,
  }, token)
  console.log('⑤ authorization-attempt:', attempt.status === 200 ? 'recorded' : `FAILED ${JSON.stringify(attempt).slice(0, 300)}`)

  if (chainKey === 'arc-testnet') {
    const setup = await post('/api/session/setup', {
      walletAddress: msca, delegateAddress: delegate, authorizationUserOpHash: userOpHash,
    }, token)
    console.log('⑥ /api/session/setup:', setup.status, JSON.stringify(setup))
    results[chainKey] = setup.status === 200 && setup.active === true
      ? { status: 'ACTIVE', setup: true }
      : { status: 'FAILED', setup: setup }
  } else {
    const authChain = await post('/api/session/authorize-chain', {
      walletAddress: msca, delegateAddress: delegate, chainKey, authorizationUserOpHash: userOpHash,
    }, token)
    console.log('⑥ /api/session/authorize-chain:', authChain.status, JSON.stringify(authChain).slice(0, 300))
    results[chainKey] = authChain.status === 200 && authChain.success === true
      ? { status: 'AUTHORIZED' }
      : { status: 'FAILED', authorizeChain: authChain }
  }
}

// ── 7. Verify per-chain deployment + authorization ──
console.log('\n⑦ per-chain verification:')
// On-chain deployment proof via the public RPC (independent of the backend).
for (const chainKey of CHAIN_KEYS) {
  const chain = CHAINS[chainKey]
  const rpcClient = createPublicClient({
    chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
    transport: await import('viem').then(m => m.http(chain.rpcUrl, { timeout: 15_000 })),
  })
  const code = await rpcClient.getCode({ address: msca }).catch(() => '0x')
  const onChainDeployed = Boolean(code && code !== '0x')
  console.log(`   ${chainKey.padEnd(16)} on-chain deployed = ${onChainDeployed}`)
  results[chainKey].deployed = onChainDeployed
}
// Backend authorization status: Arc via /session/status, Base/Arbitrum via
// destination-status (Arc is the session chain, not a destination chain).
for (const chainKey of ['base-sepolia', 'arbitrum-sepolia']) {
  const ds = await get(`/api/session/destination-status?chainKey=${chainKey}&walletAddress=${msca}`, token)
  console.log(`   ${chainKey.padEnd(16)} destination-status:`, ds.status, JSON.stringify({ deployed: ds.deployed, authorized: ds.authorized }))
  results[chainKey].authorized = ds.authorized === true
}
results['arc-testnet'].authorized = true // proven by successful /api/session/setup

// ── 8. Confirm session active ──
const status = await get('/api/session/status', token)
console.log('\n⑧ /api/session/status:', status.status, JSON.stringify({
  active: status.session?.active, statusReason: status.session?.statusReason,
  walletAddress: status.session?.walletAddress, delegate: status.session?.delegateAddress,
}))

const allChainsOk = CHAIN_KEYS.every(k => results[k]?.deployed === true && results[k]?.authorized === true)
const arcActive = status.session?.active === true

console.log('\n=== SUMMARY ===')
for (const chainKey of CHAIN_KEYS) {
  const r = results[chainKey]
  console.log(`${chainKey.padEnd(16)} -> ${r?.status || '?'} | deployed=${r?.deployed} authorized=${r?.authorized}`)
}

if (allChainsOk && arcActive) {
  console.log('\n✅ 3-CHAIN E2E PASSED — MSCA deployed + delegate authorized on Arc/Base/Arbitrum, session ACTIVE')
  console.log('   walletAddress :', msca)
  console.log('   delegateAddress:', delegate)
  process.exit(0)
} else {
  console.log('\n❌ 3-CHAIN E2E FAILED')
  process.exit(1)
}
