#!/usr/bin/env node
// e2e-mainnet-flows.mjs — E2E jalur Arc MAINNET (bukan testnet).
//
// Menguji tepat jalur yang dipakai Plugin & UI di produksi, tanpa browser:
//   • transport Modular Circle lewat proxy produksi (chain/entrypoint mainnet)
//   • passkey options/verification LIVE + derivasi alamat MSCA Arc mainnet
//   • swap EOA (Stablecoin Service mainnet) dan swap Circle Wallet (wallet SCA ARC)
//   • bridge via Circle Wallet + attestation CCTP (Iris produksi)
//
// Pemakaian:
//   node --env-file=.env scripts/e2e-mainnet-flows.mjs          # hanya baca (aman, tanpa state baru)
//   node --env-file=.env scripts/e2e-mainnet-flows.mjs --full    # + pembuatan wallet/passkey produksi
//
// E2E_BASE_URL bisa dioverride (default https://arcoxdex.vercel.app).
// Exit code 0 = semua lulus, 1 = ada yang gagal.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { createPublicClient, custom, defineChain, encodeFunctionData, getAddress } from 'viem'
import { toWebAuthnAccount } from 'viem/account-abstraction'
import { toCircleSmartAccount, toCircleModularWalletClient } from '@circle-fin/modular-wallets-core'
import { createPasskey, makePasskeyGetFn } from './e2e-webauthn.mjs'
import { circleModularProxyHeaders } from '../src/services/circleModularProxy.mjs'
import { mintOwnerToken } from '../src/services/authToken.mjs'

const BASE = String(process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app').replace(/\/+$/, '')
const STATE_PATH = process.env.E2E_STATE_PATH || '/tmp/arcox-mainnet-e2e-state.json'
const FULL = process.argv.includes('--full')
const ARC_MAINNET_CHAIN_ID = 5042
const ENTRY_POINT_V07 = '0x0000000071727de22e5e9d8baf0edac6f37da032'
const MODULAR_BASE = `${BASE}/api/circle-modular/w3s/buidl`

const owner = privateKeyToAccount(process.env.TEST_EOA_KEY || generatePrivateKey())
const ownerAddress = owner.address
const ownerToken = mintOwnerToken(ownerAddress)
if (!ownerToken) throw new Error('AUTH_SECRET tidak tersedia — jalankan dengan --env-file=.env')

const results = []
function record(ok, label, detail = '') {
  results.push({ ok, label, detail })
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const short = value => `${String(value).slice(0, 10)}…${String(value).slice(-6)}`
// A browser posts PublicKeyCredential.toJSON(): every assertion buffer becomes
// a base64url string. Raw Uint8Array fields would reach Circle as {"0":...} and
// fail verification with "Missing or invalid parameters".
const base64Url = value => Buffer.from(value).toString('base64url')
function assertionPayload(assertion) {
  return {
    id: assertion.id,
    rawId: assertion.id,
    type: 'public-key',
    response: {
      clientDataJSON: base64Url(assertion.response.clientDataJSON),
      authenticatorData: base64Url(assertion.response.authenticatorData),
      signature: base64Url(assertion.response.signature),
      ...(assertion.response.userHandle ? { userHandle: assertion.response.userHandle } : {}),
    },
  }
}

async function post(path, body, { token = '', timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await res.json().catch(() => ({}))
  return { status: res.status, payload }
}

async function jsonRpc(slug, method, params = []) {
  const res = await fetch(`${MODULAR_BASE}${slug ? `/${slug}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

console.log(`ARCOX — E2E Arc MAINNET (${FULL ? 'full' : 'read-only'})`)
console.log(`base : ${BASE}`)
console.log(`owner: ${ownerAddress} (sesi HMAC, tanpa dana)`)

// ── ⓪ Situs produksi hidup ──
console.log('\n⓪ Situs produksi')
{
  const res = await fetch(BASE).catch(error => { throw new Error(`Tidak bisa menghubungi ${BASE}: ${error?.message || error}`) })
  const html = await res.text()
  record(res.status === 200 && /\/assets\/.+\.js/.test(html), 'GET / memuat bundel frontend', `HTTP ${res.status}, ${html.length} byte`)
}

// ── ① Transport Modular Circle (proxy produksi) ──
console.log('\n① Transport Modular Circle (dipakai plugin Agent Wallet)')
{
  const chainId = await jsonRpc('arc', 'eth_chainId')
  record(chainId.body?.result === '0x13b2', 'Arc mainnet eth_chainId = 0x13b2', JSON.stringify(chainId.body?.result ?? chainId.body?.error ?? chainId.status))
  const entryPoints = await jsonRpc('arc', 'eth_supportedEntryPoints')
  const list = entryPoints.body?.result || []
  record(list.includes(ENTRY_POINT_V07), 'EntryPoint v0.7 tersedia', list.join(', ') || 'kosong')
}

// ── ② Registry chain mainnet ──
console.log('\n② Registry chain aktif')
{
  const res = await fetch(`${BASE}/api/chains`)
  const payload = await res.json().catch(() => ({}))
  const keys = (payload.chains || []).map(chain => chain.key)
  record(keys.includes('arc-mainnet') && keys.includes('base-mainnet') && keys.includes('arbitrum-mainnet'), 'chain mainnet terdaftar', keys.join(', '))
  record(!keys.some(key => /sepolia|devnet|testnet/.test(key)), 'tidak ada chain testnet yang diiklankan')
}

// ── ③ Passkey options LIVE (rp.id produksi) ──
console.log('\n③ Passkey environment LIVE')
let options = null
let flowId = ''
{
  const res = await post('/api/auth/passkey-options', { mode: 'Register', username: `e2e-mainnet-${Date.now()}` })
  options = res.payload?.options || null
  flowId = String(res.payload?.flowId || '')
  const rpId = options?.rp?.id || ''
  record(res.status === 200 && Boolean(options?.challenge), 'rp_getRegistrationOptions LIVE', res.status === 200 ? `flowId ${short(flowId)}` : JSON.stringify(res.payload).slice(0, 160))
  record(rpId === 'arcoxdex.vercel.app', 'domain passkey = produksi', rpId || 'kosong')
}

// ── ④ Swap EOA (Stablecoin Service mainnet) ──
console.log('\n④ Swap Personal Wallet (EOA)')
{
  const res = await post('/api/eoa-swap-quote', { metamaskAddress: ownerAddress, tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.1' }, { token: ownerToken })
  const amountOut = res.payload?.amountOut
  record(res.status === 200 && res.payload?.available === true && Boolean(amountOut), 'quote USDC → EURC tersedia', res.status === 200 ? `${amountOut} EURC via ${res.payload?.provider || res.payload?.source}` : JSON.stringify(res.payload).slice(0, 200))
  record(Number(res.payload?.platformFee?.bps) > 0, 'platform fee terbaca dari router mainnet', `${res.payload?.platformFee?.bps ?? '-'} bps → ${res.payload?.platformFee?.treasury ?? '-'}`)
}

// ── ④b Adapter swap mainnet: payload NYATA dari Stablecoin Service ──
// Circle menandatangani ExecutionParams di domain EIP-712 adapter miliknya
// (ADAPTER_CONTRACT_EVM_MAINNET di @circle-fin/provider-stablecoin-service-swap).
// Kalau env diarahkan ke proxy self-deployed, setiap execute() revert
// InvalidSignature (0x8baa579f) TEPAT setelah approve USDC sukses — inilah
// gejala "transaksi hanya berhasil di fase approve".
const CIRCLE_SWAP_ADAPTER_MAINNET = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'
console.log('\n④b Adapter swap mainnet (verifikasi payload nyata)')
{
  const res = await post('/api/eoa-swap-prepare', { metamaskAddress: ownerAddress, tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.1' }, { token: ownerToken })
  const adapter = String(res.payload?.adapterContract || '')
  record(adapter.toLowerCase() === CIRCLE_SWAP_ADAPTER_MAINNET.toLowerCase(), 'adapterContract = adapter mainnet Circle', adapter || '(kosong)')

  const leg = res.payload?.legs?.[0]
  if (adapter && leg?.executionParams && leg?.signature) {
    const ep = leg.executionParams
    const data = encodeFunctionData({
      abi: [{
        type: 'function', name: 'execute', stateMutability: 'payable',
        inputs: [
          { name: 'params', type: 'tuple', components: [
            { name: 'instructions', type: 'tuple[]', components: [
              { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'value', type: 'uint256' },
              { name: 'tokenIn', type: 'address' }, { name: 'amountToApprove', type: 'uint256' },
              { name: 'tokenOut', type: 'address' }, { name: 'minTokenOut', type: 'uint256' },
            ] },
            { name: 'tokens', type: 'tuple[]', components: [{ name: 'token', type: 'address' }, { name: 'beneficiary', type: 'address' }] },
            { name: 'execId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'metadata', type: 'bytes' },
          ] },
          { name: 'tokenInputs', type: 'tuple[]', components: [
            { name: 'permitType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'permitCalldata', type: 'bytes' },
          ] },
          { name: 'signature', type: 'bytes' },
        ],
      }],
      functionName: 'execute',
      args: [{
        instructions: ep.instructions.map(i => ({
          target: i.target, data: i.data, value: BigInt(i.value), tokenIn: i.tokenIn,
          amountToApprove: BigInt(i.amountToApprove), tokenOut: i.tokenOut, minTokenOut: BigInt(i.minTokenOut),
        })),
        tokens: ep.tokens,
        execId: BigInt(ep.execId),
        deadline: BigInt(ep.deadline),
        metadata: ep.metadata || '0x',
      }, [{ permitType: 0, token: leg.tokenInAddress, amount: BigInt(leg.amountBaseUnits), permitCalldata: '0x' }], leg.signature],
    })
    // Tanpa approve/dana, revert yang BENAR adalah soal allowance/saldo ERC-20.
    // Revert InvalidSignature berarti domain adapter masih salah.
    const sim = await jsonRpc('arc', 'eth_call', [{ from: ownerAddress, to: adapter, data }, 'latest'])
    const error = sim.body?.error || {}
    const invalidSignature = String(error.data || '').toLowerCase().startsWith('0x8baa579f')
    const allowanceOrBalance = /allowance|balance/i.test(String(error.message || ''))
    record(!invalidSignature, 'execute() menerima signature Circle (bukan InvalidSignature)', invalidSignature
      ? `InvalidSignature 0x8baa579f — domain adapter salah (${adapter})`
      : error.message ? String(error.message).slice(0, 110) : 'signature lolos verifikasi')
    record(!invalidSignature && (allowanceOrBalance || !error.data || Boolean(sim.body?.result)), 'revert yang tersisa hanya soal allowance/saldo (tanpa dana uji)', String(error.message || 'success').slice(0, 110))
  } else {
    record(false, 'payload swap EOA lengkap (executionParams + signature)', JSON.stringify(res.payload).slice(0, 140))
  }
}

// ── ⑤ Attestation CCTP (Iris produksi) ──
console.log('\n⑤ Attestation CCTP mainnet')
{
  const res = await post('/api/get-attestation', { txHash: `0x${'11'.repeat(32)}`, fromChain: 'Arc', toChain: 'Base', once: true })
  const rejectedTestnet = /Unknown chain/i.test(String(res.payload?.error || ''))
  record(res.status === 200 && !rejectedTestnet, 'Iris produksi menjawab (domain Arc → Base)', JSON.stringify(res.payload).slice(0, 140))
}

// ── ⑥ Passkey register + verifikasi + derivasi MSCA Arc mainnet ──
console.log('\n⑥ Agent Wallet MSCA (passkey) di Arc mainnet')
if (!FULL) {
  console.log('   • dilewati (jalankan dengan --full untuk membuat passkey + wallet produksi)')
} else {
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}
  let credential = null
  if (state.credentialId && state.pkcs8 && state.rpId) {
    // Reuse the stored passkey to exercise the LOGIN path as well.
    const { webcrypto } = await import('node:crypto')
    const fromB64 = value => Uint8Array.from(Buffer.from(String(value), 'base64url'))
    const privateKey = await webcrypto.subtle.importKey('pkcs8', fromB64(state.pkcs8), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    credential = {
      id: state.credentialId,
      publicKey: state.publicKey,
      getFn: makePasskeyGetFn({ privateKey, credentialId: fromB64(state.credentialId), rpId: state.rpId, userHandle: state.userHandle }),
    }
    const loginOptions = await post('/api/auth/passkey-options', { mode: 'Login', username: '' })
    const loginFlowId = String(loginOptions.payload?.flowId || '')
    const challenge = loginOptions.payload?.options?.challenge
    // getFn menandatangani assertion di atas challenge sebagai BYTES (browser
    // memberi ArrayBuffer); mengirim string base64url membuat challenge kosong
    // dan Circle menolaknya sebagai signature tidak valid.
    const assertion = challenge ? await credential.getFn({ publicKey: { challenge: fromB64(challenge) } }) : null
    const loginCredential = assertion ? assertionPayload(assertion) : null
    const login = loginCredential
      ? await post('/api/auth/passkey-login', { credential: loginCredential, mode: 'Login', flowId: loginFlowId })
      : { status: 0, payload: {} }
    record(login.status === 200 && Boolean(login.payload?.walletAddress), 'login passkey tersimpan berhasil', login.status === 200 ? String(login.payload.walletAddress) : JSON.stringify(login.payload).slice(0, 160))
  } else {
    const passkey = await createPasskey({ rpId: options?.rp?.id, challenge: options?.challenge, userHandle: options?.user?.id || '' })
    const verify = await post('/api/auth/passkey-login', {
      credential: passkey.credential,
      mode: 'Register',
      flowId,
      agentKey: 'e2e-mainnet:probe',
      ownerAddress,
      ownerSessionToken: ownerToken,
    })
    record(verify.status === 200 && Boolean(verify.payload?.walletAddress), 'registrasi + verifikasi passkey produksi', verify.status === 200 ? String(verify.payload.walletAddress) : JSON.stringify(verify.payload).slice(0, 200))
    if (verify.status === 200) {
      const { webcrypto } = await import('node:crypto')
      const jwk = await webcrypto.subtle.exportKey('jwk', passkey.privateKey)
      const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', passkey.privateKey)).toString('base64url')
      credential = { id: passkey.credential.id, publicKey: verify.payload.credential?.publicKey, getFn: makePasskeyGetFn({ privateKey: passkey.privateKey, credentialId: passkey.credentialId, rpId: options?.rp?.id, userHandle: options?.user?.id || '' }) }
      writeFileSync(STATE_PATH, JSON.stringify({
        credentialId: passkey.credential.id,
        publicKey: verify.payload.credential?.publicKey || '',
        pkcs8,
        rpId: options?.rp?.id || 'arcoxdex.vercel.app',
        userHandle: options?.user?.id || '',
        walletAddress: verify.payload.walletAddress,
        jwkCreatedAt: new Date().toISOString(),
      }, null, 2))
      console.log(`   • state e2e disimpan: ${STATE_PATH}`)
    }
  }

  if (credential?.publicKey) {
    // Derivasi ulang alamat MSCA dengan SDK yang sama seperti browser; alamat
    // inilah yang dipakai plugin untuk per-agent wallet di Arc mainnet.
    const chain = defineChain({
      id: ARC_MAINNET_CHAIN_ID,
      name: 'Arc Mainnet',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
    })
    const transport = custom({
      async request({ method, params }) {
        const res = await jsonRpc('arc', method, params ?? [])
        if (res.body?.error) throw new Error(`${method}: ${JSON.stringify(res.body.error)}`)
        return res.body.result
      },
    }, { key: 'modular-proxy' })
    const modularClient = toCircleModularWalletClient({ client: createPublicClient({ chain, transport }) })
    const smartAccount = await toCircleSmartAccount({
      client: modularClient,
      owner: toWebAuthnAccount({ credential: { id: credential.id, publicKey: credential.publicKey }, getFn: credential.getFn, rpId: options?.rp?.id || 'arcoxdex.vercel.app' }),
    })
    const derived = getAddress(smartAccount.address)
    const expected = String(state.walletAddress || '')
    record(!expected || derived.toLowerCase() === expected.toLowerCase(), 'alamat MSCA Arc mainnet deterministik', derived)
  }

  // ── ⑦ Swap Circle Wallet (membuat wallet SCA ARC bila belum ada) ──
  console.log('\n⑦ Swap Circle Wallet (wallet SCA ARC)')
  {
    const res = await post('/api/quote', { metamaskAddress: ownerAddress, tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '0.1' }, { token: ownerToken })
    record(res.status === 200 && res.payload?.available === true && Boolean(res.payload?.amountOut), 'quote swap via Circle Wallet', res.status === 200 ? `${res.payload.amountOut} EURC` : JSON.stringify(res.payload).slice(0, 200))
  }

  // ── ⑧ Bridge via Circle Wallet (wallet baru kosong = berhenti di saldo) ──
  console.log('\n⑧ Bridge via Circle Wallet')
  {
    const res = await post('/api/prepare-bridge', { metamaskAddress: ownerAddress, amount: '0.1', token: 'USDC' }, { token: ownerToken })
    const message = String(res.payload?.error || '')
    const configurationFailure = /entity secret|not configured|belum dikonfigurasi|SDK Circle|Arc mainnet/i.test(message)
    record(!configurationFailure, 'jalur bridge berjalan sampai pemeriksaan saldo', message || `HTTP ${res.status}`)
  }
}

const failed = results.filter(item => !item.ok)
console.log('\nRingkasan')
console.log(`  lulus : ${results.length - failed.length}/${results.length}${FULL ? '' : ' (read-only)'}`)
for (const item of failed) console.log(`    ❌ ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
if (!FULL) console.log('  catatan: jalankan dengan --full untuk menguji pembuatan MSCA/passkey dan wallet Circle di produksi.')
process.exit(failed.length ? 1 : 0)
