#!/usr/bin/env node
// e2e-mainnet-session.mjs — aktivasi Agent Wallet (MSCA) + session key di Arc
// MAINNET lewat endpoint produksi, memakai passkey mainnet yang sudah terverifikasi.
//
// Alur (sama seperti browser di halaman Plugin):
//   ① POST /api/auth/passkey-options (Login)      → flowId + challenge
//   ② assertion WebAuthn dari passkey tersimpan   (origin produksi)
//   ③ POST /api/auth/passkey-login  (Login)       → vault token + walletAddress (MSCA)
//   ④ derivasi ulang MSCA dengan SDK Circle       → harus sama dengan ③
//   ⑤ POST /api/session/generate-key              → delegate EOA server
//   ⑥a POST circle_createAddressMapping           → daftarkan wallet di Circle
//   ⑥b deploy MSCA UserOperation #1 (paymaster)   → tunggu receipt, MSCA ber-kode
//   ⑦ addOwners UserOperation #2 (paymaster)      → izinkan delegate sebagai owner
//   ⑧ POST /api/session/authorization-attempt + /api/session/setup → session ACTIVE
//   ⑨ verifikasi: kode kontrak MSCA on-chain + /api/session/status
//
// Semua panggilan Circle Modular dirutekan lewat proxy produksi
// /api/circle-modular/arc (server memakai LIVE client key), jadi jalurnya identik
// dengan browser — bukan client key testnet.
//
// STATUS (28 Sep 2026) — dua temuan yang diverifikasi terhadap produksi mainnet:
//
// 1. URUTAN (diperbaiki di sini dan di frontend/modularWallet.ts). addOwners
//    tidak boleh menjadi UserOperation pertama di mainnet; deploy MSCA harus
//    UserOp #1 (⑥b, tunggu receipt + verifikasi bytecode) dan addOwners UserOp
//    #2 (⑦). Di testnet Circle menerima keduanya dalam satu UserOp, sehingga
//    asumsi lama (addOwners mengangkat factory initCode) tidak pernah gagal di
//    sana.
//
// 2. -32600 "Cannot find target wallet in the system" BUKAN soal urutan. Error
//    itu muncul untuk SEMUA UserOperation ke MSCA mainnet (Arc, Base, dan
//    Arbitrum) walaupun `circle_getAddress` sudah mengembalikan wallet yang
//    sama (state LIVE, blockchain ARC) dan `circle_getAddressMapping` mengenali
//    ownernya. Payload userOp yang sama persis diterima beberapa saat kemudian
//    (`eth_estimateUserOperationGas` → preVerificationGas/callGasLimit),
//    termasuk lewat endpoint Circle langsung dengan LIVE client key yang sama.
//    Jadi ini kondisi sisi Circle yang sementara, bukan bug payload kita;
//    mengulang langkah pada saat itu juga sudah cukup.
//
// 3. FEE. Setelah wallet resolvable, Arc mainnet menolak UserOperation dengan
//    `precheck failed: maxPriorityFeePerGas is 0 but must be at least 1000000000`.
//    Skrip (dan frontend) sekarang mengirim lantai 1 gwei dari
//    circle_getUserOperationGasPrice untuk deploy MAUPUN addOwners.
//
// Pemakaian:
//   node --env-file=.env scripts/e2e-mainnet-session.mjs [--register]
// State passkey dibaca dari /tmp/arcox-mainnet-e2e-state.json (hasil
// `e2e-mainnet-flows.mjs --full`); hasil sesi ditulis ke
// /tmp/arcox-mainnet-session-state.json untuk dipakai e2e MCP.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { createPublicClient, custom, defineChain, encodeFunctionData, getAddress, http } from 'viem'
import { sendUserOperation, waitForUserOperationReceipt, toWebAuthnAccount } from 'viem/account-abstraction'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { base64UrlToBytes, bytesToBase64Url, parsePublicKey } from 'webauthn-p256'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync as readEnvFile } from 'node:fs'
import { CHAINS, ARC_CHAIN_KEY } from '../src/services/chains.mjs'
import { createPasskey, makePasskeyGetFn } from './e2e-webauthn.mjs'

// Owner EOA: /api/session/generate-key menolak sesi MSCA tanpa bukti EOA pemilik.
function resolveOwnerKey() {
  if (process.env.SESSION_PRIVATE_KEY) return process.env.SESSION_PRIVATE_KEY
  if (process.env.EOA_PRIVATE_KEY) return process.env.EOA_PRIVATE_KEY
  if (process.env.TEST_EOA_KEY) return process.env.TEST_EOA_KEY
  const env = readEnvFile(`${process.env.HOME}/.arcox/agent.env`, 'utf8')
  const match = env.match(/^EOA_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)
  if (match) return match[1]
  throw new Error('Tidak ada private key EOA pemilik')
}

const BASE = String(process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app').replace(/\/+$/, '')
// --register: buat passkey BARU di mainnet (mode Register) alih-alih login. Ini
// perlu ketika wallet lama tidak dikenal sistem Circle ("Cannot find target
// wallet in the system"), karena wallet hanya terdaftar di aplikasi Circle yang
// client key-nya dipakai saat registrasi.
const REGISTER = process.argv.includes('--register')
const PASSKEY_STATE = process.env.MAINNET_PASSKEY_STATE || (REGISTER ? '/tmp/arcox-mainnet-e2e-state-fresh.json' : '/tmp/arcox-mainnet-e2e-state.json')
const SESSION_STATE = process.env.MAINNET_SESSION_STATE || '/tmp/arcox-mainnet-session-state.json'
const CHAIN_KEY = ARC_CHAIN_KEY
const chain = CHAINS[CHAIN_KEY]
// RPC mainnet eksplisit. `chain.rpcUrl` mengikuti ARC_MAINNET_RPC_URL → RPC →
// RPC publik, dan shell lokal bisa mengekspor `RPC` milik TESTNET (Canteen/dRPC),
// sehingga pembacaan kode/saldo akan menyasar jaringan yang salah dan melaporkan
// MSCA 0 byte walaupun UserOperation-nya sukses di mainnet.
const RPC = process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io'

if (!REGISTER && !existsSync(PASSKEY_STATE)) throw new Error(`state passkey tidak ada: ${PASSKEY_STATE} (jalankan scripts/e2e-mainnet-flows.mjs --full dulu, atau pakai --register)`)
let passkey = existsSync(PASSKEY_STATE) ? JSON.parse(readFileSync(PASSKEY_STATE, 'utf8')) : {}
const session = existsSync(SESSION_STATE) ? JSON.parse(readFileSync(SESSION_STATE, 'utf8')) : {}
const persist = () => writeFileSync(SESSION_STATE, JSON.stringify(session, null, 2))

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const api = async (path, body, token = '') => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const apiGet = async (path, token = '') => {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

// Transport lewat proxy produksi: server menyuntikkan LIVE client key mainnet.
const modularTransport = custom({
  async request({ method, params }) {
    const res = await fetch(`${BASE}/api/circle-modular/${chain.transportSlug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
    })
    const json = await res.json().catch(() => ({}))
    if (json.error) throw new Error(`${method} gagal: ${JSON.stringify(json.error).slice(0, 200)}`)
    return json.result
  },
}, { key: 'circle-modular-proxy', name: 'Circle Modular (proxy produksi)' })
const modularClient = toCircleModularWalletClient({
  client: createPublicClient({
    chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } }),
    transport: modularTransport,
  }),
})

// Arc mainnet menolak UserOperation dengan maxPriorityFeePerGas 0
// (`precheck failed: maxPriorityFeePerGas is 0 but must be at least 1000000000`).
// Tanyakan harga ke Circle lalu terapkan lantai 1 gwei — logika yang sama dengan
// circleGasFees() di frontend (arc-dex/src/services/modularWallet.ts).
const GAS_FEE_FLOOR = { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n }
async function circleGasFees() {
  try {
    const price = await modularClient.request({ method: 'circle_getUserOperationGasPrice', params: [] }).catch(() => null)
    for (const level of [price?.medium, price?.fast, price?.slow]) {
      if (!level) continue
      const suggestedMax = BigInt(level.maxFeePerGas || 0)
      const suggestedPriority = BigInt(level.maxPriorityFeePerGas || 0)
      if (suggestedMax <= 0n && suggestedPriority <= 0n) continue
      const priority = suggestedPriority > GAS_FEE_FLOOR.maxPriorityFeePerGas ? suggestedPriority : GAS_FEE_FLOOR.maxPriorityFeePerGas
      const max = suggestedMax >= priority ? suggestedMax : GAS_FEE_FLOOR.maxFeePerGas
      return { maxPriorityFeePerGas: priority, maxFeePerGas: max }
    }
  } catch { /* pakai lantai aman */ }
  return GAS_FEE_FLOOR
}

console.log('ARCOX — aktivasi Agent Wallet (MSCA) + session key Arc MAINNET')
console.log(`api      : ${BASE}`)
console.log(`chain    : ${CHAIN_KEY} (id ${chain.id})`)
console.log(`rpc      : ${RPC}`)
console.log(`passkey  : ${passkey.credentialId ? `${String(passkey.credentialId).slice(0, 14)}…` : '(kosong)'}`)

// ── ①-③ Login passkey (token di-scope ke MSCA) ───────────────────────────────
// Upstream Circle Modular sesekali membalas 401/HTML transien dan challenge
// passkey sekali pakai, jadi tiap percobaan minta challenge BARU.
async function loginPasskey(label, attempts = 3) {
  let lastError = ''
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await loginPasskeyOnce(attempt === 1 ? label : `${label} (percobaan ${attempt})`)
      return result
    } catch (error) {
      lastError = String(error?.message || error)
      console.log(`   • login gagal: ${lastError.slice(0, 140)}`)
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 8000))
    }
  }
  throw new Error(`login passkey gagal (${lastError.slice(0, 160)})`)
}

async function loginPasskeyOnce(label) {
  const optionsRes = await api('/api/auth/passkey-options', REGISTER ? { mode: 'Register', username: `mainnet-e2e-${Date.now()}` } : { mode: 'Login', username: '' })
  const options = optionsRes.options || {}
  const flowId = String(optionsRes.flowId || '')
  const challenge = options.challenge
  const rpId = options.rp?.id || options.rpId || passkey.rpId
  if (optionsRes.status !== 200 || !challenge) throw new Error(`passkey-options gagal: ${optionsRes.status} ${JSON.stringify(optionsRes).slice(0, 160)}`)
  let privateKey
  let getFn
  let created
  if (REGISTER) {
    // Passkey baru: MSCA-nya akan berbeda, jadi state sesi lama tidak dipakai.
    created = await createPasskey({ rpId, challenge, userHandle: options.user?.id || '' })
    privateKey = created.privateKey
    const pkcs8 = bytesToBase64Url(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', created.privateKey)))
    getFn = makePasskeyGetFn({ privateKey, credentialId: base64UrlToBytes(created.credential.id), rpId, userHandle: options.user?.id || '' })
    passkey = { credentialId: created.credential.id, pkcs8, rpId, userHandle: options.user?.id || '', publicKey: '' }
    writeFileSync(PASSKEY_STATE, JSON.stringify(passkey, null, 2))
  } else {
    privateKey = await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(passkey.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    getFn = makePasskeyGetFn({ privateKey, credentialId: base64UrlToBytes(passkey.credentialId), rpId, userHandle: passkey.userHandle })
  }
  // Mode Register memakai attestation pendaftaran (createPasskey), bukan
  // assertion login; Circle menolaknya sebagai "challenge expired" kalau tertukar.
  let credentialPayload
  if (REGISTER) {
    credentialPayload = created.credential
  } else {
    const assertion = await getFn({ publicKey: { challenge: base64UrlToBytes(challenge) } })
    credentialPayload = {
      id: assertion.id,
      rawId: assertion.id,
      type: 'public-key',
      response: {
        clientDataJSON: bytesToBase64Url(assertion.response.clientDataJSON),
        authenticatorData: bytesToBase64Url(assertion.response.authenticatorData),
        signature: bytesToBase64Url(assertion.response.signature),
        ...(assertion.response.userHandle ? { userHandle: assertion.response.userHandle } : {}),
      },
    }
  }
  const login = await api('/api/auth/passkey-login', {
    credential: credentialPayload,
    mode: REGISTER ? 'Register' : 'Login',
    flowId,
    // Mode Register wajib disertai bukti wallet utama (owner session).
    ...(REGISTER ? { ownerAddress: ownerAccount.address, ownerSessionToken: ownerSession.token } : {}),
  })
  if (login.status !== 200 || !login.token || !login.walletAddress) throw new Error(`passkey-login gagal: ${login.status} ${JSON.stringify(login).slice(0, 200)}`)
  if (REGISTER) {
    // Simpan public key dari backend supaya mapping/derivasi berikutnya akurat.
    passkey.publicKey = login.credential?.publicKey || passkey.publicKey
    passkey.walletAddress = getAddress(login.walletAddress)
    writeFileSync(PASSKEY_STATE, JSON.stringify(passkey, null, 2))
  }
  session.token = login.token
  session.walletAddress = getAddress(login.walletAddress)
  persist()
  record(true, `${label}: passkey-login → vault token + MSCA`, session.walletAddress)
  return { token: session.token, walletAddress: session.walletAddress }
}

// ── ⓪ owner EOA session (bukti wallet utama) ─────────────────────────────────
// Dipakai dua jalur: Register passkey (wajib) dan /api/session/generate-key.
console.log('\n⓪ owner EOA session (wallet utama)')
const ownerAccount = privateKeyToAccount(resolveOwnerKey())
const ownerIssuedAt = new Date().toISOString()
const ownerSession = await api('/api/auth/session', {
  address: ownerAccount.address,
  issuedAt: ownerIssuedAt,
  signature: await ownerAccount.signMessage({
    message: [
      'ARCOX DEX login',
      'Only sign this message on the official ARCOX DEX website.',
      `Address: ${getAddress(ownerAccount.address)}`,
      `Issued At: ${ownerIssuedAt}`,
      'Network: Arc Testnet',
    ].join('\n'),
  }),
})
record(ownerSession.status === 200 && Boolean(ownerSession.ownerSessionToken), 'owner EOA session (bukti pemilik)', `${ownerAccount.address} HTTP ${ownerSession.status}`)

console.log(`\n①-③ passkey ${REGISTER ? 'REGISTER (passkey baru)' : 'login'} di produksi`)
let { token, walletAddress } = REGISTER ? {} : session
if (token && walletAddress) {
  // Token dari state dipakai ulang, tapi diverifikasi dulu: kalau server menolak
  // (401 transien — sempat terjadi di produksi), login ulang alih-alih gagal.
  const check = await apiGet('/api/session/status', token)
  if (check.status === 200) {
    console.log('   • token sesi state masih valid (dipakai ulang)')
  } else {
    console.log(`   • token state ditolak (HTTP ${check.status}) → login ulang`)
    ;({ token, walletAddress } = await loginPasskey('login ulang'))
  }
} else {
  ;({ token, walletAddress } = await loginPasskey('login'))
}
record(Boolean(token && walletAddress), 'token + walletAddress siap', `${String(walletAddress).slice(0, 12)}…`)
if (passkey.walletAddress && String(passkey.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase()) {
  record(false, 'MSCA login = MSCA pada state passkey', `${walletAddress} vs ${passkey.walletAddress}`)
}

// ── ④ Derivasi MSCA dengan SDK Circle (harus sama dengan hasil login) ───────
console.log('\n④ derivasi MSCA dengan SDK Circle')
const owner = toWebAuthnAccount({
  credential: { id: passkey.credentialId, publicKey: passkey.publicKey },
  getFn: makePasskeyGetFn({
    privateKey: await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(passkey.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
    credentialId: base64UrlToBytes(passkey.credentialId),
    rpId: passkey.rpId,
    userHandle: passkey.userHandle,
  }),
  rpId: passkey.rpId,
})
const smartAccount = await toCircleSmartAccount({ client: modularClient, owner })
const derived = getAddress(smartAccount.address)
record(derived.toLowerCase() === String(walletAddress).toLowerCase(), 'alamat MSCA deterministik cocok dengan login', derived)

// ── ⑤ owner EOA session + delegate server ───────────────────────────────────
console.log('\n⑤ /api/session/generate-key (pakai owner session dari ⓪)')
let delegate = session.delegateAddress || ''
if (!delegate) {
  const reserveWith = ownerToken => api('/api/session/generate-key', { walletAddress, ownerAddress: ownerAccount.address, ownerSessionToken: ownerToken }, token)
  let reserve = await reserveWith(ownerSession.ownerSessionToken)
  if (reserve.status === 401) {
    // 401 transien pernah terjadi walau token valid; login MSCA ulang lalu coba lagi.
    console.log('   • generate-key 401 → login MSCA ulang dan coba lagi')
    ;({ token } = await loginPasskey('login ulang'))
    reserve = await reserveWith(ownerSession.ownerSessionToken)
  }
  record(reserve.status === 200 && Boolean(reserve.delegateAddress), 'delegate EOA direservasi', JSON.stringify(reserve).slice(0, 160))
  delegate = reserve.delegateAddress || ''
  session.delegateAddress = delegate
  persist()
} else {
  console.log('   • delegate dipakai ulang dari state:', delegate)
}
if (!delegate) process.exit(1)

// ── ⑥a mapping passkey↔wallet di sistem Circle ─────────────────────────────
// Tanpa langkah ini Circle membalas "Cannot find target wallet in the system"
// pada eth_estimateUserOperationGas: wallet hasil derivasi belum terdaftar di
// aplikasi Circle yang dipakai sekarang (client key mainnet LIVE).
console.log('\n⑥a circle_createAddressMapping (daftarkan wallet ke sistem Circle)')
{
  const { x, y } = parsePublicKey(passkey.publicKey)
  const res = await fetch(`${BASE}/api/circle-modular/w3s/buidl/${chain.transportSlug}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'circle_createAddressMapping',
      params: [{
        walletAddress: derived,
        owners: [{ type: 'WEBAUTHOWNER', identifier: { publicKeyX: x.toString(), publicKeyY: y.toString() } }],
      }],
    }),
  })
  const data = await res.json().catch(() => ({}))
  const message = String(data?.error?.message || '')
  const alreadyKnown = /already|exists|duplicate|known/i.test(message)
  record((res.ok && !data.error) || alreadyKnown, 'wallet terdaftar/dipetakan di Circle', data.error ? `${message.slice(0, 150)}` : 'ok')
}

// ── ⑥b deploy MSCA (UserOp #1) ──────────────────────────────────────────────
// MSCA hasil derivasi masih counterfactual (0 byte kode). Bundler Circle
// menolak UserOperation apa pun yang menyasar alamat tanpa kode dengan -32600
// "Cannot find target wallet in the system", jadi deploy harus menjadi UserOp
// pertama yang sukses sebelum addOwners boleh dikirim sebagai UserOp kedua.
console.log('\n⑥b deploy MSCA UserOperation #1 (paymaster sponsored)')
const mainnetRpc = createPublicClient({
  chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } }),
  transport: http(RPC, { timeout: 15000 }),
})
const gasFees = await circleGasFees()
console.log('   fee      :', `priority ${gasFees.maxPriorityFeePerGas} wei / max ${gasFees.maxFeePerGas} wei`)
if (!session.deployed) {
  try {
    const deployHash = await sendUserOperation(modularClient, {
      account: smartAccount,
      // UserOp ke diri sendiri tanpa data: cukup untuk mengangkat factory
      // initCode dan men-deploy MSCA deterministik.
      calls: [{ to: derived, value: 0n, data: '0x' }],
      paymaster: true,
      ...gasFees,
    })
    session.deployUserOpHash = deployHash
    persist()
    console.log('   deployUserOpHash:', deployHash)
    const receipt = await waitForUserOperationReceipt(modularClient, { hash: deployHash, timeout: 180_000 })
    session.deployTx = receipt?.receipt?.transactionHash || ''
    session.deployed = receipt?.success === true
    persist()
    record(receipt?.success === true, 'deploy MSCA sukses on-chain (UserOp #1)', `tx ${session.deployTx || '-'}`)
  } catch (error) {
    record(false, 'deploy MSCA gagal', String(error?.details || error?.shortMessage || error?.message || error).slice(0, 240))
  }
} else {
  console.log('   • MSCA ditandai sudah deployed di state (deployTx:', session.deployTx || '-', ')')
}
// addOwners hanya valid kalau kontraknya benar-benar ada — verifikasi lewat RPC,
// bukan lewat state lokal.
{
  const code = await mainnetRpc.getCode({ address: derived }).catch(() => '0x')
  const hasCode = Boolean(code && code !== '0x')
  session.deployed = hasCode
  persist()
  record(hasCode, 'MSCA punya bytecode sebelum addOwners', `${((code || '0x').length - 2) / 2} byte`)
}

// ── idempotensi: sesi yang sudah ACTIVE diadopsi, bukan diautorisasi ulang ──
// Sama seperti `setupSessionKey` di frontend: mengirim addOwners kedua ke
// delegate yang sudah menjadi owner hanya membuang kuota Gas Station, dan
// re-verifikasi hash lama tidak lagi mungkin begitu index UserOperation bundler
// Circle terbatas (itu yang membuat setup gagal pada run berulang).
const preStatus = await apiGet('/api/session/status', token)
const alreadyActive = preStatus.session?.active === true
  && String(preStatus.session.walletAddress || '').toLowerCase() === derived.toLowerCase()
if (alreadyActive) {
  session.sessionActive = true
  persist()
  record(true, 'sesi ini sudah ACTIVE di Arc mainnet (idempoten)', JSON.stringify({ delegate: preStatus.session.delegateAddress, reason: preStatus.session.statusReason }).slice(0, 160))
}

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
let userOpHash = session.userOpHash || ''
if (alreadyActive) {
  console.log('\n⑦⑧ dilewati — wallet ini sudah punya sesi ACTIVE di Arc mainnet')
} else {
  // ── ⑦ addOwners userop (authorize delegate — UserOp #2) ───────────────────
  console.log('\n⑦ addOwners UserOperation #2 (paymaster sponsored — biaya gas ditanggung paymaster)')
  if (!userOpHash) {
    const callData = encodeFunctionData({ abi: ADD_OWNERS_ABI, functionName: 'addOwners', args: [[delegate], [1n], [], [], 0n] })
    try {
      userOpHash = await sendUserOperation(modularClient, { account: smartAccount, callData, paymaster: true, ...gasFees })
      session.userOpHash = userOpHash
      persist()
      console.log('   userOpHash:', userOpHash)
      const receipt = await waitForUserOperationReceipt(modularClient, { hash: userOpHash, timeout: 180_000 })
      record(receipt?.success === true, 'addOwners sukses on-chain', `tx ${receipt?.receipt?.transactionHash || '-'}`)
      session.userOpTx = receipt?.receipt?.transactionHash || ''
      persist()
    } catch (error) {
      record(false, 'addOwners gagal', String(error?.details || error?.shortMessage || error?.message || error).slice(0, 240))
    }
  } else {
    console.log('   • userOpHash dipakai ulang dari state:', userOpHash)
  }

  // ── ⑧ authorization-attempt + setup (Arc ACTIVE) ──────────────────────────
  console.log('\n⑧ /api/session/authorization-attempt + /api/session/setup')
  if (userOpHash) {
    const attempt = await api('/api/session/authorization-attempt', { walletAddress, delegateAddress: delegate, authorizationUserOpHash: userOpHash, chainKey: CHAIN_KEY }, token)
    record(attempt.status === 200, 'authorization-attempt tercatat', `HTTP ${attempt.status}`)
    const setup = await api('/api/session/setup', { walletAddress, delegateAddress: delegate, authorizationUserOpHash: userOpHash, chainKey: CHAIN_KEY }, token)
    session.ownerAddress = ownerAccount.address
    record(setup.status === 200 && setup.active === true, 'session ACTIVE di Arc mainnet', JSON.stringify(setup).slice(0, 200))
    session.sessionActive = setup.status === 200 && setup.active === true
    persist()
  } else {
    record(false, 'tidak bisa setup tanpa userOpHash', 'addOwners belum selesai')
  }
}

// ── ⑨ verifikasi ────────────────────────────────────────────────────────────
console.log('\n⑨ verifikasi')
{
  const rpc = createPublicClient({ chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [RPC] } } }), transport: http(RPC, { timeout: 15000 }) })
  const code = await rpc.getCode({ address: derived }).catch(() => '0x')
  const deployed = Boolean(code && code !== '0x')
  const native = await rpc.getBalance({ address: derived }).catch(() => 0n)
  record(deployed, 'MSCA terdeploy on-chain', `${((code || '0x').length - 2) / 2} byte kode`)
  console.log(`   saldo native MSCA: ${Number(native) / 1e18} USDC (gas Agent Wallet dimintakan ke paymaster)`)

  const status = await apiGet('/api/session/status', token)
  record(status.session?.active === true, '/api/session/status → active', JSON.stringify({ active: status.session?.active, wallet: status.session?.walletAddress, reason: status.session?.statusReason }).slice(0, 200))
  session.sessionStatus = status.session?.active === true
  persist()
}

console.log('\nState sesi disimpan di', SESSION_STATE)
const failed = results.filter(item => !item.ok)
console.log('Ringkasan')
console.log(`  lulus : ${results.length - failed.length}/${results.length}`)
for (const item of failed) console.log(`    ❌ ${item.label} — ${item.detail}`)
console.log(`  MSCA  : ${derived}`)
console.log(`  delegate: ${delegate}`)
process.exit(failed.length ? 1 : 0)
