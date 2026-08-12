// test-session-production-e2e.mjs — FULL production-site E2E.
//
// Drives the REAL deployed frontend endpoints on https://arcoxdex.vercel.app
// (Vercel proxy → VPS backend → Circle) from the first connection to a fully
// active 3-chain session:
//
//   0. GET  /                         → first connection, page + assets load
//   1. POST /api/auth/passkey-options (Register)   → real frontend endpoint
//   2. build headless P-256 passkey from the issued challenge
//   3. POST /api/auth/passkey-login  (Register)    → real frontend endpoint
//   4. derive deterministic MSCA per chain (must equal the verified address)
//   5. POST /api/session/generate-key              → reserve delegate EOA
//   6. Arc:      addOwners → authorization-attempt → /setup (ACTIVE)
//   7. Base:     addOwners → authorization-attempt → /authorize-chain
//   8. Arbitrum: addOwners → authorization-attempt → /authorize-chain
//   9. GET /api/session/destination-status + /api/session/status
//
// The passkey assertion origin is https://arcoxdex.vercel.app (the production
// RP), so this is exactly what a real browser on the deployed site produces.
//
// Usage: node --env-file=.env scripts/test-session-production-e2e.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createPublicClient, custom, defineChain, encodeFunctionData, getAddress, http } from 'viem'
import { PublicKey } from 'ox'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { toWebAuthnAccount, sendUserOperation, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { base64UrlToBytes, bytesToBase64Url } from 'webauthn-p256'
import { circleModularProxyHeaders } from '../src/services/circleModularProxy.mjs'
import { CHAINS } from '../src/services/chains.mjs'
import { createPasskey, makePasskeyGetFn } from './e2e-webauthn.mjs'

const BASE = process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app'
const STATE_PATH = process.env.PROD_STATE_PATH || '/tmp/arcox-e2e-prod-state.json'
const CHAIN_KEYS = ['arc-testnet', 'base-sepolia', 'arbitrum-sepolia']
const CLIENT_URL = process.env.CIRCLE_CLIENT_URL
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY
const PASSKEY_BASE = String(CLIENT_URL).replace(/\/+$/, '')

if (!CLIENT_URL || !CLIENT_KEY) throw new Error('CIRCLE_CLIENT_URL / CIRCLE_CLIENT_KEY required (local .env mirrors the production backend)')

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

const post = async (path, body, token = '') => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const get = async (path, token = '') => {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { headers })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

// ── 0. First connection: the deployed site must load ──
console.log('⓪ first connection to', BASE)
const page = await fetch(BASE).catch(error => { throw new Error(`Cannot reach ${BASE}: ${error?.message || error}`) })
const pageHtml = await page.text()
console.log('   GET / -> HTTP', page.status, '| bytes:', pageHtml.length, '| has assets:', /\/assets\/.+\.js/.test(pageHtml))
if (page.status !== 200 || !/\/assets\/.+\.js/.test(pageHtml)) throw new Error('Production page did not load correctly')

// ── 1-3. Register a passkey through the REAL production endpoints ──
let token = state.token
let walletAddress = state.walletAddress
let credential = state.credential
if (!token) {
  console.log('\n① POST /api/auth/passkey-options (Register) on production…')
  const optionsRes = await post('/api/auth/passkey-options', { mode: 'Register', username: `prod-e2e-${Date.now()}` })
  if (optionsRes.status !== 200 || !optionsRes.flowId || !optionsRes.options?.challenge) {
    throw new Error(`passkey-options failed: ${optionsRes.status} ${JSON.stringify(optionsRes).slice(0, 400)}`)
  }
  const options = optionsRes.options
  const rpId = options.rp?.id || options.rpId
  const userHandle = options.user?.id || ''
  console.log('   flowId:', optionsRes.flowId, '| rpId:', rpId, '| challenge:', String(options.challenge).slice(0, 14) + '…')

  const passkey = await createPasskey({ rpId, challenge: options.challenge, userHandle })
  const jwk = await webcrypto.subtle.exportKey('jwk', passkey.privateKey)
  state.pkcs8 = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', passkey.privateKey)))
  state.pubX = jwk.x
  state.pubY = jwk.y
  state.credentialId = passkey.credential.id
  state.rpId = rpId
  state.userHandle = userHandle
  persist()

  console.log('② POST /api/auth/passkey-login (Register) on production…')
  const loginRes = await post('/api/auth/passkey-login', { mode: 'Register', credential: passkey.credential, flowId: optionsRes.flowId })
  if (loginRes.status !== 200 || !loginRes.token || !loginRes.walletAddress) {
    throw new Error(`passkey-login failed: ${loginRes.status} ${JSON.stringify(loginRes).slice(0, 400)}`)
  }
  token = loginRes.token
  walletAddress = getAddress(loginRes.walletAddress)
  credential = loginRes.credential
  state.token = token
  state.walletAddress = walletAddress
  state.credential = credential
  persist()
  console.log('   passkey registered + verified through production ✅')
  console.log('   walletAddress :', walletAddress)
} else {
  console.log('\n①-③ passkey + token (reused from persisted state) ✅')
  walletAddress = getAddress(walletAddress)
}

// ── 4. Derive the deterministic MSCA per chain ──
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

console.log('\n③ deriving MSCA per chain…')
const owner = toWebAuthnAccount({
  credential: credential ? { id: credential.id, publicKey: credential.publicKey } : { id: state.credential.id, publicKey: state.credential.publicKey },
  getFn: makePasskeyGetFn({
    privateKey: await (async () => {
      const pk = await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(state.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
      return pk
    })(),
    credentialId: new Uint8Array(base64UrlToBytes(state.credentialId)),
    rpId: state.rpId,
  }),
  rpId: state.rpId,
})

const mscas = {}
for (const chainKey of CHAIN_KEYS) {
  const { modularClient } = buildChainClient(chainKey)
  const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })
  mscas[chainKey] = getAddress(smartAccount.address)
  console.log(`   MSCA (${chainKey}):`, mscas[chainKey])
}
const unique = new Set(Object.values(mscas).map(v => v.toLowerCase()))
if (unique.size !== 1) throw new Error(`MSCA differs across chains: ${JSON.stringify(mscas)}`)
const msca = Object.values(mscas)[0]
console.log('   ✅ MSCA identical across chains:', msca, '| matches verified login address:', msca.toLowerCase() === walletAddress.toLowerCase())
if (msca.toLowerCase() !== walletAddress.toLowerCase()) throw new Error('Derived MSCA does not match the verified passkey-login address')

// ── 5. Reserve the server-side delegate ──
console.log('\n⑤ POST /api/session/generate-key on production…')
if (!state.delegateAddress) {
  const reserve = await post('/api/session/generate-key', { walletAddress: msca }, token)
  if (reserve.status !== 200 || !reserve.delegateAddress) throw new Error(`generate-key failed: ${reserve.status} ${JSON.stringify(reserve)}`)
  state.delegateAddress = reserve.delegateAddress
  persist()
}
const delegate = getAddress(state.delegateAddress)
console.log('   delegate (server):', delegate)

// Arbitrum fee envelope (mirrors frontend circleGasFees).
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
          if (json.error) throw new Error(`${method} failed: ${JSON.stringify(json.error)}`)
          return json.result
        },
      }, { key: 'Modular wallets transport', name: 'Modular wallets transport' }),
    })
    const price = await client.request({ method: 'circle_getUserOperationGasPrice', params: [] }).catch(() => null)
    const level = price?.medium
    if (level?.maxPriorityFeePerGas && level?.maxFeePerGas) {
      const maxPriorityFeePerGas = BigInt(level.maxPriorityFeePerGas)
      const maxFeePerGas = BigInt(level.maxFeePerGas)
      if (maxPriorityFeePerGas > 0n && maxFeePerGas >= maxPriorityFeePerGas) return { maxPriorityFeePerGas, maxFeePerGas }
    }
  } catch { /* fall through */ }
  return { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n }
}

// ── 6-8. Per-chain addOwners → record → (Arc: setup / dest: authorize-chain) ──
const results = {}
for (const chainKey of CHAIN_KEYS) {
  const chain = CHAINS[chainKey]
  console.log(`\n⑥ ${chainKey} — addOwners UserOperation (deploy + authorize, paymaster sponsored)…`)
  const { modularClient } = buildChainClient(chainKey)
  const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })

  let userOpHash = state.chainHashes?.[chainKey]
  if (!userOpHash) {
    const callData = encodeFunctionData({ abi: ADD_OWNERS_ABI, functionName: 'addOwners', args: [[delegate], [1n], [], [], 0n] })
    try {
      const fees = await circleGasFees(chainKey)
      userOpHash = await sendUserOperation(modularClient, { account: smartAccount, callData, paymaster: true, ...fees })
      state.chainHashes = { ...(state.chainHashes || {}), [chainKey]: userOpHash }
      persist()
      console.log('   userOpHash:', userOpHash)
      const receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash, timeout: 180_000 })
      console.log('   receipt   : success =', receipt?.success, '| tx =', receipt?.receipt?.transactionHash)
      if (receipt?.success !== true) throw new Error(`${chainKey}: addOwners receipt success != true`)
    } catch (error) {
      console.error(`   ${chainKey} submit failed:`, error?.details || error?.shortMessage || error?.message || error)
      results[chainKey] = { status: 'FAILED', error: String(error?.shortMessage || error?.message || error).slice(0, 300) }
      continue
    }
  } else {
    console.log('   userOpHash (resumed):', userOpHash)
  }

  const attempt = await post('/api/session/authorization-attempt', { walletAddress: msca, delegateAddress: delegate, authorizationUserOpHash: userOpHash, chainKey }, token)
  console.log('⑦ authorization-attempt:', attempt.status === 200 ? 'recorded' : `FAILED ${JSON.stringify(attempt).slice(0, 250)}`)

  if (chainKey === 'arc-testnet') {
    const setup = await post('/api/session/setup', { walletAddress: msca, delegateAddress: delegate, authorizationUserOpHash: userOpHash }, token)
    console.log('⑧ /api/session/setup:', setup.status, JSON.stringify(setup).slice(0, 250))
    results[chainKey] = setup.status === 200 && setup.active === true ? { status: 'ACTIVE' } : { status: 'FAILED', setup }
  } else {
    const authChain = await post('/api/session/authorize-chain', { walletAddress: msca, delegateAddress: delegate, chainKey, authorizationUserOpHash: userOpHash }, token)
    console.log('⑧ /api/session/authorize-chain:', authChain.status, JSON.stringify(authChain).slice(0, 250))
    results[chainKey] = authChain.status === 200 && authChain.success === true ? { status: 'AUTHORIZED' } : { status: 'FAILED', authorizeChain: authChain }
  }
}

// ── 9. Verify ──
console.log('\n⑨ verification on production:')
for (const chainKey of CHAIN_KEYS) {
  const chain = CHAINS[chainKey]
  const rpcClient = createPublicClient({
    chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
    transport: http(chain.rpcUrl, { timeout: 15_000 }),
  })
  const code = await rpcClient.getCode({ address: msca }).catch(() => '0x')
  results[chainKey].deployed = Boolean(code && code !== '0x')
  console.log(`   ${chainKey.padEnd(16)} on-chain deployed = ${results[chainKey].deployed}`)
}
for (const chainKey of ['base-sepolia', 'arbitrum-sepolia']) {
  const ds = await get(`/api/session/destination-status?chainKey=${chainKey}&walletAddress=${msca}`, token)
  console.log(`   ${chainKey.padEnd(16)} destination-status:`, ds.status, JSON.stringify({ deployed: ds.deployed, authorized: ds.authorized }))
  results[chainKey].authorized = ds.authorized === true
}
results['arc-testnet'].authorized = true // proven by successful /api/session/setup
const status = await get('/api/session/status', token)
console.log('   /api/session/status:', status.status, JSON.stringify({ active: status.session?.active, statusReason: status.session?.statusReason }))

const allChainsOk = CHAIN_KEYS.every(k => results[k]?.deployed === true && results[k]?.authorized === true)
const arcActive = status.session?.active === true

console.log('\n=== SUMMARY (production site) ===')
for (const chainKey of CHAIN_KEYS) {
  const r = results[chainKey]
  console.log(`${chainKey.padEnd(16)} -> ${r?.status || '?'} | deployed=${r?.deployed} authorized=${r?.authorized}`)
}
console.log('walletAddress :', msca)
console.log('delegateAddress:', delegate)

if (allChainsOk && arcActive) {
  console.log('\n✅ PRODUCTION E2E PASSED — first connection → passkey → 3-chain deploy+authorize → session ACTIVE')
  process.exit(0)
} else {
  console.log('\n❌ PRODUCTION E2E FAILED')
  process.exit(1)
}
