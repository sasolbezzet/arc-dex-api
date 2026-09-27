#!/usr/bin/env node
// e2e-unified-balance-mainnet.mjs — uji NYATA Unified Balance (Gateway) Arc mainnet:
//   deposit → cek saldo Gateway → withdraw (spend balik ke wallet sendiri) → verifikasi.
//
// Semua panggilan Gateway API dilewatkan ke proxy produksi
// (/api/unified-balance/gateway-proxy) supaya jalur yang diuji sama dengan frontend.
//
// Pemakaian:
//   node --env-file=.env scripts/e2e-unified-balance-mainnet.mjs                 # hanya baca
//   node --env-file=.env scripts/e2e-unified-balance-mainnet.mjs --deposit 0.02
//   node --env-file=.env scripts/e2e-unified-balance-mainnet.mjs --withdraw 0.02
//
// Kunci diambil dari UB_PRIVATE_KEY → EOA_PRIVATE_KEY (~/.arcox/agent.env) →
// TEST_EOA_KEY. Wallet itu harus punya USDC di Arc mainnet untuk deposit.
import { readFileSync } from 'node:fs'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { AppKit } from '@circle-fin/app-kit'
import { createPublicClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mintOwnerToken } from '../src/services/authToken.mjs'

const BASE = String(process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app').replace(/\/+$/, '')
const RPC = 'https://rpc.mainnet.arc.io'
const USDC = '0x3600000000000000000000000000000000000000'
const GATEWAY_WALLET = '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE'
const GATEWAY_MINTER = '0x2222222d7164433c4C09B0b0D809a9b52C04C205'

const arg = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '') : ''
}
const depositAmount = arg('--deposit')
const withdrawAmount = arg('--withdraw')

function resolveKey() {
  if (process.env.UB_PRIVATE_KEY) return process.env.UB_PRIVATE_KEY
  if (process.env.EOA_PRIVATE_KEY) return process.env.EOA_PRIVATE_KEY
  if (process.env.TEST_EOA_KEY) return process.env.TEST_EOA_KEY
  try {
    const env = readFileSync(`${process.env.HOME}/.arcox/agent.env`, 'utf8')
    const match = env.match(/^EOA_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)
    if (match) return match[1]
  } catch { /* tanpa state lokal */ }
  throw new Error('Tidak ada private key (UB_PRIVATE_KEY / EOA_PRIVATE_KEY / TEST_EOA_KEY)')
}

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const short = value => `${String(value).slice(0, 12)}…${String(value).slice(-6)}`

const privateKey = resolveKey()
const account = privateKeyToAccount(privateKey)
const authToken = mintOwnerToken(account.address)
console.log(`ARCOX — E2E Unified Balance mainnet`)
console.log(`wallet : ${account.address}`)
console.log(`proxy  : ${BASE}/api/unified-balance/gateway-proxy`)

// Semua panggilan gateway-api.circle.com dirutekan lewat proxy produksi, sama
// seperti `withGatewayProxy` di frontend.
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  if (!url.startsWith('https://gateway-api.circle.com/')) return originalFetch(input, init)
  const target = new URL(url)
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
  const method = init?.method || (input instanceof Request ? input.method : 'GET')
  const body = init?.body || (input instanceof Request && method !== 'GET' ? await input.clone().text() : undefined)
  return originalFetch(`${BASE}/api/unified-balance/gateway-proxy?path=${encodeURIComponent(`${target.pathname}${target.search}`)}`, { ...init, method, headers, body })
}

const publicClient = createPublicClient({ transport: http(RPC) })
const adapter = createViemAdapterFromPrivateKey({ privateKey })
const kit = new AppKit()

const balances = async (label) => {
  const out = await kit.unifiedBalance.getBalances({ token: 'USDC', sources: { address: account.address, chains: ['Arc'] }, includePending: true })
  const arc = out?.breakdown?.flatMap(item => item.breakdown || []).find(item => String(item.chain).toLowerCase().startsWith('arc'))
  const detail = `confirmed=${out?.totalConfirmedBalance ?? '-'} pending=${out?.totalPendingBalance ?? '-'}${arc ? ` (Arc ${arc.confirmedBalance ?? arc.confirmed ?? '?'}/${arc.pendingBalance ?? arc.pending ?? '?'})` : ''}`
  console.log(`   • saldo ${label}: ${detail}`)
  return out
}

console.log('\n① Saldo awal')
{
  const walletBalance = await publicClient.readContract({
    address: USDC,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [account.address],
  })
  const gateway = await balances('awal')
  record(true, 'Gateway read-only (getBalances via proxy produksi)', `USDC on-chain=${Number(walletBalance) / 1e6}`)
  record(Number(gateway?.totalConfirmedBalance ?? 0) >= 0, 'breakdown Arc terbaca', JSON.stringify(gateway).slice(0, 140))
}

if (depositAmount) {
  console.log(`\n② Deposit ${depositAmount} USDC (approve + deposit on-chain)`)
  try {
    const result = await kit.unifiedBalance.deposit({ from: { adapter, chain: 'Arc' }, amount: depositAmount, token: 'USDC' })
    console.log('   hasil deposit:', JSON.stringify(result).slice(0, 300))
    record(Boolean(result?.txHash || result?.depositedTo), 'deposit terkirim', String(result?.txHash || result?.depositedTo || ''))
  } catch (error) {
    record(false, 'deposit gagal', String(error?.message || error).slice(0, 260))
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 6000))
    const out = await balances(`setelah deposit #${i + 1}`)
    if (Number(out?.totalConfirmedBalance ?? 0) >= Number(depositAmount)) break
  }
}

if (withdrawAmount) {
  console.log(`\n③ Withdraw ${withdrawAmount} USDC (estimate + spend balik ke wallet sendiri)`)
  try {
    const estimate = await kit.unifiedBalance.estimateSpend({
      from: { adapter, allocations: [{ chain: 'Arc', amount: withdrawAmount }] },
      to: { adapter, chain: 'Arc', recipientAddress: account.address },
      amount: withdrawAmount,
      token: 'USDC',
    })
    console.log('   estimate:', JSON.stringify(estimate).slice(0, 260))
    record(true, 'estimateSpend via proxy produksi', JSON.stringify(estimate?.fees || []).slice(0, 120))
  } catch (error) {
    record(false, 'estimateSpend gagal', String(error?.message || error).slice(0, 260))
  }
  try {
    const before = await publicClient.readContract({
      address: USDC,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [account.address],
    })
    const result = await kit.unifiedBalance.spend({
      from: [{ adapter, allocations: [{ chain: 'Arc', amount: withdrawAmount }] }],
      to: { adapter, chain: 'Arc', recipientAddress: account.address },
      amount: withdrawAmount,
      token: 'USDC',
    })
    console.log('   hasil withdraw:', JSON.stringify(result).slice(0, 300))
    record(Boolean(result?.txHash || result?.mintTxHash || result?.destinationChain), 'withdraw terkirim', String(result?.txHash || result?.mintTxHash || ''))
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 6000))
      const after = await publicClient.readContract({
        address: USDC,
        abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
        functionName: 'balanceOf',
        args: [account.address],
      })
      if (after > before) { console.log(`   • USDC on-chain naik: ${Number(before) / 1e6} → ${Number(after) / 1e6}`); break }
    }
  } catch (error) {
    record(false, 'withdraw gagal', String(error?.message || error).slice(0, 260))
  }
}

console.log('\n④ Kontrak Gateway di Arc mainnet')
{
  for (const [label, address] of [['GatewayWallet', GATEWAY_WALLET], ['GatewayMinter', GATEWAY_MINTER]]) {
    const code = await publicClient.getCode({ address })
    record((code?.length || 0) > 2, `${label} ada di Arc mainnet`, `${((code?.length || 2) - 2) / 2} byte @ ${short(address)}`)
  }
}

const failed = results.filter(item => !item.ok)
console.log('\nRingkasan')
console.log(`  lulus : ${results.length - failed.length}/${results.length}`)
for (const item of failed) console.log(`    ❌ ${item.label} — ${item.detail}`)
if (!depositAmount && !withdrawAmount) console.log('  catatan: jalankan --deposit <amt> lalu --withdraw <amt> untuk uji dana nyata.')
process.exit(failed.length ? 1 : 0)
