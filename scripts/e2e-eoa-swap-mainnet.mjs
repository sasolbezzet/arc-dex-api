#!/usr/bin/env node
// e2e-eoa-swap-mainnet.mjs — uji NYATA swap EOA (wallet MetaMask/EOA) di Arc mainnet
// lewat adapter Circle Stablecoin Service, persis jalur frontend `swapFromEoa`:
//
//   quote → prepare (executionParams + signature) → approve tokenIn →
//   simulasi execute → kirim execute on-chain → verifikasi saldo masuk.
//
// Ini uji regresi untuk root cause "tx hanya berhasil di fase approve":
// signature Stablecoin Service diverifikasi pada domain EIP-712 adapter MILIK
// CIRCLE, sehingga `adapterContract` dari /api/eoa-swap-prepare HARUS
// 0x7FB8c726…845 (ADAPTER_CONTRACT_EVM_MAINNET) dan simulasi `execute` tidak
// boleh revert InvalidSignature (0x8baa579f).
//
// Pemakaian:
//   node --env-file=.env scripts/e2e-eoa-swap-mainnet.mjs
//   node --env-file=.env scripts/e2e-eoa-swap-mainnet.mjs --amount 0.01
//   node --env-file=.env scripts/e2e-eoa-swap-mainnet.mjs --token-out EURC --back
//   node --env-file=.env scripts/e2e-eoa-swap-mainnet.mjs --dry       # quote + prepare + simulasi saja
//
// `--back` menukar balik hasil swap ke token asal supaya kedua arah rute teruji.
// `--dry` berhenti setelah simulasi execute: tetap membuktikan signature
// terverifikasi di adapter Circle, tapi tanpa approve/tx (tanpa biaya).
// Catatan Arc: gas dibayar dari saldo USDC yang sama, jadi verifikasi memakai
// event Transfer di receipt, bukan selisih saldo.
// Kunci diambil dari SWAP_PRIVATE_KEY → EOA_PRIVATE_KEY → TEST_EOA_KEY → ~/.arcox/agent.env.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, formatUnits, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mintOwnerToken } from '../src/services/authToken.mjs'

const BASE = String(process.env.E2E_BASE_URL || 'https://arcoxdex.vercel.app').replace(/\/+$/, '')
// Sengaja TIDAK memakai ARC_RPC_URL / RPC: di .env keduanya menunjuk RPC testnet
// (dRPC + Canteen), yang menjawab "0x" untuk kontrak EURC mainnet.
const RPC = process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io'
const CHAIN_ID = 5042
const TOKEN_ADDRESS = {
  USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
}
// ADAPTER_CONTRACT_EVM_MAINNET dari @circle-fin/provider-stablecoin-service-swap.
const CIRCLE_ADAPTER = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'
const ARCOX_SELF_DEPLOYED_ADAPTER = '0x8bc25dB1feda8Fc5eB20d0117Ff1f965F2F4E29C'
const INVALID_SIGNATURE = '0x8baa579f'

const arg = name => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '') : ''
}
const amountIn = arg('--amount') || '0.02'
const tokenIn = (arg('--token-in') || 'USDC').toUpperCase()
const tokenOut = (arg('--token-out') || 'EURC').toUpperCase()
const swapBack = process.argv.includes('--back')
const dryRun = process.argv.includes('--dry')

function resolveKey() {
  if (process.env.SWAP_PRIVATE_KEY) return process.env.SWAP_PRIVATE_KEY
  if (process.env.EOA_PRIVATE_KEY) return process.env.EOA_PRIVATE_KEY
  if (process.env.TEST_EOA_KEY) return process.env.TEST_EOA_KEY
  try {
    const env = readFileSync(`${process.env.HOME}/.arcox/agent.env`, 'utf8')
    const match = env.match(/^EOA_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/m)
    if (match) return match[1]
  } catch { /* tanpa state lokal */ }
  throw new Error('Tidak ada private key (SWAP_PRIVATE_KEY / EOA_PRIVATE_KEY / TEST_EOA_KEY)')
}

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
]
const ADAPTER_EXECUTE_ABI = [{
  type: 'function',
  name: 'execute',
  stateMutability: 'payable',
  inputs: [
    {
      name: 'params',
      type: 'tuple',
      components: [
        {
          name: 'instructions',
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'data', type: 'bytes' },
            { name: 'value', type: 'uint256' },
            { name: 'tokenIn', type: 'address' },
            { name: 'amountToApprove', type: 'uint256' },
            { name: 'tokenOut', type: 'address' },
            { name: 'minTokenOut', type: 'uint256' },
          ],
        },
        {
          name: 'tokens',
          type: 'tuple[]',
          components: [
            { name: 'token', type: 'address' },
            { name: 'beneficiary', type: 'address' },
          ],
        },
        { name: 'execId', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'metadata', type: 'bytes' },
      ],
    },
    {
      name: 'tokenInputs',
      type: 'tuple[]',
      components: [
        { name: 'permitType', type: 'uint8' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'permitCalldata', type: 'bytes' },
      ],
    },
    { name: 'signature', type: 'bytes' },
  ],
  outputs: [],
}]

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const short = value => `${String(value).slice(0, 12)}…${String(value).slice(-6)}`

const privateKey = resolveKey()
const account = privateKeyToAccount(privateKey)
const authToken = mintOwnerToken(account.address)
const chain = defineChain({
  id: CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const publicClient = createPublicClient({ chain, transport: http(RPC, { timeout: 20000 }) })
const walletClient = createWalletClient({ account, chain, transport: http(RPC, { timeout: 20000 }) })

console.log('ARCOX — E2E swap EOA mainnet lewat adapter Circle')
console.log(`wallet : ${account.address}`)
console.log(`api    : ${BASE}`)
console.log(`route  : ${amountIn} ${tokenIn} → ${tokenOut}${swapBack ? ' → balik' : ''}${dryRun ? ' (dry run: tanpa tx)' : ''}`)

// RPC publik Arc sesekali menjawab "0x" sesaat; baca ulang sampai dapat data.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readUint = async (to, data, attempts = 4) => {
  for (let i = 0; i < attempts; i++) {
    const result = await publicClient.request({ method: 'eth_call', params: [{ to, data }, 'latest'] }).catch(() => null)
    if (result && result !== '0x') return BigInt(result)
    if (i < attempts - 1) await sleep(1500)
  }
  throw new Error(`eth_call ${to} tidak mengembalikan data setelah ${attempts} percobaan`)
}
const balanceOf = (symbol, owner = account.address) => readUint(TOKEN_ADDRESS[symbol], encodeFunctionData({
  abi: ERC20_ABI, functionName: 'balanceOf', args: [owner],
}))
const allowanceOf = (symbol, spender) => readUint(TOKEN_ADDRESS[symbol], encodeFunctionData({
  abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender],
}))
const decimalsOf = symbol => (symbol === 'cirBTC' ? 8 : 6)
const pretty = (value, symbol) => `${formatUnits(value, decimalsOf(symbol))} ${symbol}`

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

// Ambil payload execute dari backend, normalisasi angka jadi bigint (seperti
// normalizeExecutionParams di frontend), lalu encode calldata-nya.
const encodeExecute = leg => encodeFunctionData({
  abi: ADAPTER_EXECUTE_ABI,
  functionName: 'execute',
  args: [
    {
      instructions: (leg.executionParams.instructions || []).map(instruction => ({
        target: instruction.target,
        data: instruction.data,
        value: BigInt(instruction.value || 0),
        tokenIn: instruction.tokenIn,
        amountToApprove: BigInt(instruction.amountToApprove || 0),
        tokenOut: instruction.tokenOut,
        minTokenOut: BigInt(instruction.minTokenOut || 0),
      })),
      tokens: (leg.executionParams.tokens || []).map(token => ({ token: token.token, beneficiary: token.beneficiary })),
      execId: BigInt(leg.executionParams.execId || 0),
      deadline: BigInt(leg.executionParams.deadline || 0),
      metadata: leg.executionParams.metadata || '0x',
    },
    [{
      permitType: 0,
      token: leg.tokenInAddress,
      amount: BigInt(leg.amountBaseUnits),
      permitCalldata: '0x',
    }],
    leg.signature,
  ],
})

// Transfer(address,address,uint256) — jumlah yang benar-benar berpindah di receipt.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const transferTotals = (receipt, token) => {
  let fromWallet = 0n
  let toWallet = 0n
  const wallet = account.address.toLowerCase()
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(token).toLowerCase()) continue
    if (String(log.topics?.[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue
    if (!log.topics?.[1] || !log.topics?.[2]) continue
    const fromAddress = `0x${String(log.topics[1]).slice(26)}`.toLowerCase()
    const toAddress = `0x${String(log.topics[2]).slice(26)}`.toLowerCase()
    const value = BigInt(log.data)
    if (fromAddress === wallet) fromWallet += value
    if (toAddress === wallet) toWallet += value
  }
  return { fromWallet, toWallet }
}

const simulate = async (data, label) => {
  try {
    await publicClient.call({ account: account.address, to: CIRCLE_ADAPTER, data })
    return { ok: true, reason: `${label} → tidak revert (signature lolos)` }
  } catch (error) {
    const raw = String(error?.raw || error?.cause?.raw || error?.data || '')
    const message = String(error?.shortMessage || error?.message || error)
    const invalid = raw.toLowerCase().startsWith(INVALID_SIGNATURE) || /InvalidSignature/i.test(message)
    return { ok: false, reason: `${label} → ${invalid ? 'InvalidSignature (0x8baa579f)!' : message.slice(0, 120)}` }
  }
}

const runSwap = async (from, to, amount) => {
  console.log(`\n── swap ${amount} ${from} → ${to}`)
  const beforeIn = await balanceOf(from)
  const beforeOut = await balanceOf(to)

  console.log(`① quote`)
  const quote = await post('/api/eoa-swap-quote', { metamaskAddress: account.address, tokenIn: from, tokenOut: to, amountIn: amount })
  console.log(`   HTTP ${quote.status} → ${JSON.stringify(quote.data).slice(0, 300)}`)
  record(quote.status === 200 && quote.data?.available !== false, `quote ${from} → ${to}`, quote.data?.available === false ? String(quote.data?.error || '') : `amountOut≈${quote.data?.amountOut ?? '?'} min=${quote.data?.minAmountOut ?? '?'} fee=${quote.data?.platformFee?.amount ?? '0'}/${quote.data?.platformFee?.bps ?? 0}bps`)

  console.log(`② prepare (payload + signature Stablecoin Service)`)
  const prepare = await post('/api/eoa-swap-prepare', { metamaskAddress: account.address, tokenIn: from, tokenOut: to, amountIn: amount })
  const prepared = prepare.data || {}
  if (prepare.status !== 200 || prepared.success === false || !prepared.legs?.length) {
    record(false, `prepare ${from} → ${to}`, `HTTP ${prepare.status} ${JSON.stringify(prepared).slice(0, 200)}`)
    return null
  }
  const adapter = String(prepared.adapterContract || '').toLowerCase()
  record(adapter === CIRCLE_ADAPTER.toLowerCase(), `adapterContract = adapter milik Circle (${short(CIRCLE_ADAPTER)})`, `${prepared.adapterContract}${adapter === ARCOX_SELF_DEPLOYED_ADAPTER.toLowerCase() ? ' (proxy self-deployed lama — akan revert InvalidSignature)' : ''}`)
  const leg = prepared.legs[0]
  record(Boolean(leg.executionParams && leg.signature), 'leg punya executionParams + signature', `amountIn=${leg.amountIn} amountOut=${leg.amountOut} min=${leg.stopLimit} gasLimit=${leg.gasLimit || '-'}`)

  const needed = BigInt(leg.amountBaseUnits)
  const data = encodeExecute(leg)
  console.log(`③ simulasi execute SEBELUM approve (bukti signature diverifikasi di domain adapter Circle)`)
  const preSimulation = await simulate(data, 'execute')
  // Tanpa allowance, revert yang benar adalah ERC20 allowance/transfer — bukan
  // InvalidSignature. Itu bukti signature sudah cocok dengan adapter Circle.
  const signatureOk = preSimulation.ok || /allowance|exceeds|insufficient|transfer/i.test(preSimulation.reason)
  record(signatureOk, 'signature lolos verifikasi adapter (bukan InvalidSignature)', preSimulation.reason)

  let allowance = await allowanceOf(from, prepared.adapterContract)
  if (dryRun) {
    console.log('   --dry: berhenti di sini (tanpa approve, tanpa tx, tanpa biaya gas/fee)')
    return { ok: signatureOk, dry: true }
  }

  console.log(`④ approval ${from} → adapter (jalur fallback UI setelah permit USDC tidak tersedia)`)
  if (allowance >= needed) {
    record(true, `allowance ${from} sudah cukup`, `${allowance.toString()} base units`)
  } else {
    const approveTx = await walletClient.writeContract({
      address: TOKEN_ADDRESS[from],
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [prepared.adapterContract, needed],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: approveTx })
    allowance = await allowanceOf(from, prepared.adapterContract)
    record(receipt.status === 'success' && allowance >= needed, `approve ${from} terkirim + allowance terbaca`, `tx ${short(approveTx)} allowance=${allowance.toString()} base units`)
  }

  console.log(`⑤ simulasi ulang setelah approve (harus lolos tanpa revert)`)
  const simulated = await simulate(data, 'execute')
  record(simulated.ok, 'simulasi execute lolos', simulated.reason)

  console.log(`⑥ kirim execute on-chain`)
  const gas = await publicClient.estimateGas({ account: account.address, to: CIRCLE_ADAPTER, data, value: 0n }).catch(() => 400000n)
  const txHash = await walletClient.sendTransaction({ to: CIRCLE_ADAPTER, data, value: 0n, gas: (gas * 13n) / 10n + 10000n })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120000 })
  const rawRevert = receipt.status === 'success' ? '' : await publicClient.call({ account: account.address, to: CIRCLE_ADAPTER, data, blockNumber: receipt.blockNumber }).then(() => '').catch(error => String(error?.raw || error?.shortMessage || error).slice(0, 140))
  record(receipt.status === 'success', `execute terkirim`, `tx ${txHash} blok ${receipt.blockNumber} gas ${receipt.gasUsed}${receipt.status === 'success' ? '' : ` — revert ${rawRevert}`}`)
  if (receipt.status !== 'success') return { txHash, ok: false }

  console.log(`⑦ verifikasi dari log Transfer receipt`)
  // Arc memakai USDC sebagai gas token, jadi saldo ERC-20 USDC ikut terpotong
  // biaya gas. Angka yang mengikat adalah event Transfer di receipt.
  const afterIn = await balanceOf(from)
  const afterOut = await balanceOf(to)
  const minOut = BigInt(leg.stopLimit || 0)
  const movedIn = transferTotals(receipt, TOKEN_ADDRESS[from])
  const movedOut = transferTotals(receipt, TOKEN_ADDRESS[to])
  record(movedIn.fromWallet >= needed, `${from} ditarik adapter (event Transfer)`, `keluar dari wallet ${pretty(movedIn.fromWallet, from)} (swap ${pretty(needed, from)} + fee platform)`)
  record(movedOut.toWallet > 0n && (minOut === 0n || movedOut.toWallet >= minOut), `${to} diterima wallet (≥ minTokenOut)`, `masuk ${pretty(movedOut.toWallet, to)}, min ${pretty(minOut, to)}`)
  console.log(`   saldo (termasuk gas USDC-native): ${pretty(beforeIn, from)} → ${pretty(afterIn, from)} | ${pretty(beforeOut, to)} → ${pretty(afterOut, to)}`)
  console.log(`   tx: https://explorer.arc.io/tx/${txHash}`)
  return { txHash, ok: true, received: afterOut, deltaOut: movedOut.toWallet }
}

const first = await runSwap(tokenIn, tokenOut, amountIn)
if (first?.ok && swapBack && !dryRun) {
  const amountBack = formatUnits(first.deltaOut, decimalsOf(tokenOut))
  await runSwap(tokenOut, tokenIn, amountBack)
}

console.log('\n⑧ kontrak adapter Arc mainnet')
{
  for (const [label, address] of [['adapter Circle (dipakai)', CIRCLE_ADAPTER], ['proxy self-deployed (dipensiunkan)', ARCOX_SELF_DEPLOYED_ADAPTER]]) {
    const code = await publicClient.getCode({ address })
    record((code?.length || 0) > 2, `${label} ${short(address)}`, `${((code?.length || 2) - 2) / 2} byte`)
  }
}

const failed = results.filter(item => !item.ok)
console.log('\nRingkasan')
console.log(`  lulus : ${results.length - failed.length}/${results.length}`)
for (const item of failed) console.log(`    ❌ ${item.label} — ${item.detail}`)
if (dryRun) console.log('  catatan: --dry — tidak ada tx on-chain; jalankan tanpa --dry untuk eksekusi nyata.')
process.exit(failed.length ? 1 : 0)
