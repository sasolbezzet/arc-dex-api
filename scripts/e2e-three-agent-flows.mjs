// e2e-three-agent-flows.mjs — REAL end-to-end test for the three Plugin flows
// that are easy to confuse, using a virtual EOA wallet and a virtual WebAuthn
// passkey (P-256 credential registered with Circle's rp_* endpoints).
//
//   FLOW 1 — Create New Wallet (register)
//     owner SIWE proof is mandatory for a brand-new wallet, the Arc addOwners
//     UserOperation activates the session, and activate-binding CREATES the
//     durable agent row only because the owner proof is present.
//
//   FLOW 2 — Relogin after Revoke
//     revoke keeps the durable binding, so the passkey-only recovery must work
//     WITHOUT any SIWE: generate-key succeeds with no owner proof.
//
//   FLOW 3 — Relogin after Clear
//     clear deletes the binding, so generate-key MUST refuse without owner
//     proof and the owner-proof path must recreate exactly one binding for the
//     same wallet.
//
// Assertions mirror the frontend guards in src/services/agentSession.ts. The
// harness only ever touches its own virtual wallet (isolated namespace), and
// the only on-chain writes are the addOwners UserOperations required to make
// that wallet's session genuinely active.
//
// Usage:
//   node --env-file=.env scripts/e2e-three-agent-flows.mjs
//   E2E_BASE_URL=http://127.0.0.1:3001 node --env-file=.env scripts/e2e-three-agent-flows.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createPublicClient, custom, defineChain, encodeFunctionData, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { PublicKey } from 'ox'
import { toCircleModularWalletClient, toCircleSmartAccount } from '@circle-fin/modular-wallets-core'
import { sendUserOperation, toWebAuthnAccount, waitForUserOperationReceipt } from 'viem/account-abstraction'
import { base64UrlToBytes, bytesToBase64Url } from 'webauthn-p256'
import { circleModularProxyHeaders } from '../src/services/circleModularProxy.mjs'
import { mintOwnerToken } from '../src/services/authToken.mjs'
import { CHAINS } from '../src/services/chains.mjs'
import { createPasskey, makePasskeyGetFn } from './e2e-webauthn.mjs'

const BASE = String(process.env.E2E_BASE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '')
const STATE_PATH = process.env.E2E_STATE_PATH || '/tmp/arcox-e2e-three-flows.json'
const AGENT_KEY = process.env.E2E_AGENT_KEY || 'oauth:grok'
const chainKey = 'arc-testnet'
const chain = CHAINS[chainKey]
const CLIENT_URL = process.env.CIRCLE_CLIENT_URL
const CLIENT_KEY = process.env.CIRCLE_CLIENT_KEY
const PASSKEY_BASE = String(CLIENT_URL || '').replace(/\/+$/, '')

if (!CLIENT_URL || !CLIENT_KEY) throw new Error('CIRCLE_CLIENT_URL / CIRCLE_CLIENT_KEY required (run with --env-file=.env)')

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

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const step = (n, msg) => console.log(`\n${n} ${msg}`)
const short = a => `${String(a).slice(0, 10)}…${String(a).slice(-6)}`

const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
const persist = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

const request = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ...data }
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

// ── ⓪ virtual wallet: fresh EOA + owner (SIWE) proof token ──
const eoaKey = state.eoaKey || process.env.TEST_EOA_KEY || `0x${Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex')}`
state.eoaKey = eoaKey
const eoa = getAddress(privateKeyToAccount(eoaKey).address)
const eoaOwnerToken = mintOwnerToken(eoa)
if (!eoaOwnerToken) throw new Error('mintOwnerToken failed — AUTH_SECRET missing from backend env')
persist()
console.log('⓪ virtual wallet   :', eoa, state.eoaKey === process.env.TEST_EOA_KEY ? '(from TEST_EOA_KEY)' : '(generated)')

// ── ① virtual passkey (registered with Circle; reused from state) ──
async function loadKeyPair() {
  if (!state.pkcs8) return null
  return { privateKey: await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(state.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) }
}

let keyPair = await loadKeyPair()
if (!keyPair) {
  console.log('① registering virtual passkey with Circle…')
  const options = await rpCall('rp_getRegistrationOptions', [`e2e-flows-${Date.now()}`])
  const challenge = options.result?.challenge
  const rpId = options.result?.rp?.id || options.result?.rpId
  const userHandle = options.result?.user?.id || ''
  if (!challenge || !rpId || !userHandle) throw new Error(`registration options incomplete: ${JSON.stringify(options.result)}`)
  const passkey = await createPasskey({ rpId, challenge, userHandle })
  const jwk = await webcrypto.subtle.exportKey('jwk', passkey.privateKey)
  state.pkcs8 = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', passkey.privateKey)))
  state.pubX = jwk.x
  state.pubY = jwk.y
  state.credentialId = passkey.credential.id
  state.rpId = rpId
  state.userHandle = userHandle
  state.credential = { id: passkey.credential.id, publicKey: PublicKey.toHex(passkey.publicKey, { compressed: true }) }
  persist()
  const verification = await rpCall('rp_getRegistrationVerification', [passkey.credential], options.setCookie)
  if (verification.result !== true) throw new Error(`registration verification failed: ${JSON.stringify(verification.result)}`)
  keyPair = { privateKey: passkey.privateKey }
  console.log('   passkey registered ✓')
} else {
  if (!state.userHandle) throw new Error('persisted state is missing userHandle; delete the state file to re-register')
  console.log('① virtual passkey  : reused from persisted state')
}

// ── ② derive the deterministic MSCA ──
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
const owner = toWebAuthnAccount({
  credential: state.credential,
  getFn: makePasskeyGetFn({
    privateKey: keyPair.privateKey,
    credentialId: new Uint8Array(base64UrlToBytes(state.credentialId)),
    rpId: state.rpId,
  }),
  rpId: state.rpId,
})
const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })
const msca = getAddress(smartAccount.address)
const vaultToken = mintOwnerToken(msca)
if (!vaultToken) throw new Error('failed to mint MSCA vault token')
state.msca = msca
persist()
console.log('② virtual MSCA     :', msca)

const sessionStatus = () => request('GET', `/api/session/status?agentKey=${encodeURIComponent(AGENT_KEY)}`, { token: vaultToken })

/** Submit one addOwners UserOperation and record it, then activate the session. */
async function authorizeDelegate(delegateAddress) {
  const delegate = getAddress(delegateAddress)
  const callData = encodeFunctionData({ abi: ADD_OWNERS_ABI, functionName: 'addOwners', args: [[delegate], [1n], [], [], 0n] })
  console.log(`   submitting addOwners(${short(delegate)}) on ${chainKey}…`)
  const userOpHash = await sendUserOperation(modularClient, { account: smartAccount, callData, paymaster: true })
  console.log('   userOpHash:', userOpHash)
  const receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash, timeout: 180_000 })
  if (!receipt?.success) throw new Error(`addOwners UserOperation failed: ${userOpHash}`)
  const attempt = await request('POST', '/api/session/authorization-attempt', {
    body: { walletAddress: msca, delegateAddress: delegate, authorizationUserOpHash: userOpHash, chainKey },
    token: vaultToken,
  })
  if (attempt.status !== 200) throw new Error(`authorization-attempt failed: ${attempt.status} ${JSON.stringify(attempt)}`)
  const setup = await request('POST', '/api/session/setup', {
    body: { walletAddress: msca, delegateAddress: delegate, authorizationUserOpHash: userOpHash },
    token: vaultToken,
  })
  if (setup.status !== 200 || setup.active !== true) throw new Error(`session setup failed: ${setup.status} ${JSON.stringify(setup)}`)
  return userOpHash
}

/** Mirrors setupSessionKey(): reuse an active session, reconcile, else authorize. */
async function ensureSessionActive(delegateAddress) {
  const before = await sessionStatus()
  if (before.session?.active === true && getAddress(before.session.delegateAddress || delegateAddress) === getAddress(delegateAddress)) {
    console.log('   session already active — reusing')
    return before.session.delegateAddress
  }
  const reconcile = await request('POST', '/api/session/reconcile', { token: vaultToken })
  if (reconcile.session?.active === true) {
    console.log('   session reactivated by reconcile')
    return reconcile.session.delegateAddress || delegateAddress
  }
  // No usable proof: a fresh passkey authorization is required (this is the
  // real addOwners UserOperation that a relogin performs in the browser).
  await authorizeDelegate(delegateAddress)
  const after = await sessionStatus()
  if (after.session?.active !== true) throw new Error(`session still inactive after setup: ${JSON.stringify(after.session)}`)
  return after.session.delegateAddress
}

// ── FLOW 1 — Create New Wallet ──
step('③', 'FLOW 1 — Create New Wallet (register)')
const noProof = await request('POST', '/api/session/generate-key', {
  body: { walletAddress: msca, agentKey: AGENT_KEY },
  token: vaultToken,
})
check(
  'create without owner proof is refused (owner_session_required)',
  noProof.status === 403 && noProof.code === 'owner_session_required',
  `${noProof.status} ${noProof.code || noProof.error || ''}`,
)

const reserved = await request('POST', '/api/session/generate-key', {
  body: { walletAddress: msca, ownerAddress: eoa, ownerSessionToken: eoaOwnerToken, agentKey: AGENT_KEY },
  token: vaultToken,
})
check('create with verified owner proof reserves a delegate', reserved.status === 200 && Boolean(reserved.delegateAddress), `${reserved.status} delegate=${short(reserved.delegateAddress || '')}`)
if (!reserved.delegateAddress) throw new Error(`cannot continue without a delegate: ${JSON.stringify(reserved)}`)
state.flow1Delegate = reserved.delegateAddress
persist()

await ensureSessionActive(reserved.delegateAddress)

const bind1 = await request('POST', '/api/session/activate-binding', {
  body: {
    walletAddress: msca,
    agentKey: AGENT_KEY,
    ownerAddress: eoa,
    ownerSessionToken: eoaOwnerToken,
    credentialId: state.credentialId,
  },
  token: vaultToken,
})
check('activate-binding creates the agent row WITH owner proof', bind1.status === 200 && bind1.success === true, `${bind1.status} ${bind1.code || bind1.error || 'ok'}`)

const status1 = await sessionStatus()
check('status: binding found and active', status1.session?.agentBindingFound === true && status1.session?.agentBindingActive === true, `found=${status1.session?.agentBindingFound} active=${status1.session?.agentBindingActive}`)

// ── FLOW 2 — Relogin after Revoke (passkey only, no SIWE) ──
step('④', 'FLOW 2 — Relogin after Revoke (passkey only)')
const revoked = await request('DELETE', `/api/vault/agents/${encodeURIComponent(AGENT_KEY)}`, { body: { action: 'revoke' }, token: vaultToken })
check('revoke succeeds', revoked.status === 200 && revoked.ok === true, `${revoked.status} revoked=${revoked.revoked}`)

const statusRevoked = await sessionStatus()
check(
  'revoke keeps the durable binding (found, inactive)',
  statusRevoked.session?.agentBindingFound === true && statusRevoked.session?.agentBindingActive === false,
  `found=${statusRevoked.session?.agentBindingFound} active=${statusRevoked.session?.agentBindingActive}`,
)

const passkeyOnly = await request('POST', '/api/session/generate-key', {
  body: { walletAddress: msca, agentKey: AGENT_KEY },
  token: vaultToken,
})
check('relogin recovery needs no SIWE (generate-key succeeds without owner proof)', passkeyOnly.status === 200 && Boolean(passkeyOnly.delegateAddress), `${passkeyOnly.status} delegate=${short(passkeyOnly.delegateAddress || '')} rotated=${passkeyOnly.rotatedAfterManualRevoke === true}`)
if (!passkeyOnly.delegateAddress) throw new Error(`relogin after revoke cannot proceed: ${JSON.stringify(passkeyOnly)}`)

await ensureSessionActive(passkeyOnly.delegateAddress)

const bind2 = await request('POST', '/api/session/activate-binding', {
  body: { walletAddress: msca, agentKey: AGENT_KEY, credentialId: state.credentialId },
  token: vaultToken,
})
check('activate-binding reactivates the retained row without owner proof', bind2.status === 200 && bind2.success === true, `${bind2.status} ${bind2.code || bind2.error || 'ok'}`)

const status2 = await sessionStatus()
check('status: binding active again', status2.session?.agentBindingActive === true, `active=${status2.session?.agentBindingActive}`)

// ── FLOW 3 — Relogin after Clear (owner proof required) ──
step('⑤', 'FLOW 3 — Relogin after Clear (owner proof required)')
const cleared = await request('DELETE', `/api/vault/agents/${encodeURIComponent(AGENT_KEY)}`, { body: { action: 'delete' }, token: vaultToken })
check('clear succeeds', cleared.status === 200 && cleared.ok === true, `${cleared.status} removed=${cleared.removed}`)

const statusCleared = await sessionStatus()
check('clear removes the binding', statusCleared.session?.agentBindingFound === false, `found=${statusCleared.session?.agentBindingFound} reason=${statusCleared.session?.agentBindingReason}`)

const clearedNoProof = await request('POST', '/api/session/generate-key', {
  body: { walletAddress: msca, agentKey: AGENT_KEY },
  token: vaultToken,
})
check(
  'cleared wallet refuses passkey-only re-binding (owner_session_required)',
  clearedNoProof.status === 403 && clearedNoProof.code === 'owner_session_required',
  `${clearedNoProof.status} ${clearedNoProof.code || clearedNoProof.error || ''}`,
)

const clearedWithProof = await request('POST', '/api/session/generate-key', {
  body: { walletAddress: msca, ownerAddress: eoa, ownerSessionToken: eoaOwnerToken, agentKey: AGENT_KEY },
  token: vaultToken,
})
check('cleared wallet accepts the verified owner proof', clearedWithProof.status === 200 && Boolean(clearedWithProof.delegateAddress), `${clearedWithProof.status} delegate=${short(clearedWithProof.delegateAddress || '')}`)
if (!clearedWithProof.delegateAddress) throw new Error(`relogin after clear cannot proceed: ${JSON.stringify(clearedWithProof)}`)

await ensureSessionActive(clearedWithProof.delegateAddress)

const bind3 = await request('POST', '/api/session/activate-binding', {
  body: {
    walletAddress: msca,
    agentKey: AGENT_KEY,
    ownerAddress: eoa,
    ownerSessionToken: eoaOwnerToken,
    credentialId: state.credentialId,
  },
  token: vaultToken,
})
check('activate-binding recreates the row WITH owner proof', bind3.status === 200 && bind3.success === true, `${bind3.status} ${bind3.code || bind3.error || 'ok'}`)

const status3 = await sessionStatus()
check('status: binding recreated and active', status3.session?.agentBindingFound === true && status3.session?.agentBindingActive === true, `found=${status3.session?.agentBindingFound} active=${status3.session?.agentBindingActive}`)

// ── summary ──
const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failed.length}/${results.length} CHECKS FAILED`}`)
console.log('   wallet       :', msca)
console.log('   owner (EOA)  :', eoa)
console.log('   agent key    :', AGENT_KEY)
console.log('   state file   :', STATE_PATH)
if (failed.length > 0) {
  for (const f of failed) console.log('   ✗', f.name) 
  process.exit(1)
}
process.exit(0)
