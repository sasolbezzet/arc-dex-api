#!/usr/bin/env node
// verify-swap-adapter-mainnet.mjs — bukti permanen root cause + fix "tx hanya
// berhasil di fase approve" pada swap EOA Arc mainnet.
//
// Ringkas: Circle Stablecoin Service menandatangani `ExecutionParams` di domain
// EIP-712 adapter MILIK CIRCLE (ADAPTER_CONTRACT_EVM_MAINNET =
// 0x7FB8c7260b63934d8da38aF902f87ae6e284a845). Kalau backend mengirim payload itu
// ke proxy self-deployed (0x8bc25dB1…E29C), `execute()` revert InvalidSignature
// (0x8baa579f) TEPAT setelah approve USDC berhasil — persis gejala yang dilaporkan.
//
// Skrip ini membuktikannya ulang dari on-chain:
//   ① state kedua adapter (owner/configurator/signer/threshold/domainSeparator)
//   ② recoverAddress signature Stablecoin Service di domain masing-masing
//      + isSigner() di adapter Circle
//   ③ simulasi `execute` dengan payload asli di kedua adapter
//
// Pemakaian:
//   node --env-file=.env scripts/verify-swap-adapter-mainnet.mjs
// Bagian ② dilewati otomatis bila CIRCLE_API_KEY_MAINNET tidak tersedia.
const CIRCLE_ADAPTER = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'
const ARCOX_SELF_DEPLOYED_ADAPTER = '0x8bc25dB1feda8Fc5eB20d0117Ff1f965F2F4E29C'
// Sengaja tidak memakai ARC_RPC_URL/RPC di .env (keduanya RPC testnet).
const RPC = process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io'
const BASE = process.env.STABLECOIN_SERVICE_BASE_URL || 'https://api.circle.com'
const KEY = process.env.CIRCLE_API_KEY_MAINNET
const USDC = '0x3600000000000000000000000000000000000000'
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'
const CHAIN_ID = 5042
const INVALID_SIGNATURE = '0x8baa579f'

const ADAPTER_VIEW_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'configurator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'signerCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'signerThreshold', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'domainSeparator', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'isSigner', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
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

const { concatHex, decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, recoverAddress, toHex } = await import('viem')
const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')

const results = []
const record = (ok, label, detail = '') => {
  results.push({ ok, label, detail })
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}

const rpc = async (method, params) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).catch(() => null)
    const body = await res?.json().catch(() => null)
    if (body && !body.error) return body.result
    if (body?.error?.message?.includes('execution reverted')) return body
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return null
}
const read = async (address, fn, args = []) => {
  const result = await rpc('eth_call', [{ to: address, data: encodeFunctionData({ abi: ADAPTER_VIEW_ABI, functionName: fn, args }) }, 'latest'])
  if (!result || typeof result !== 'string') throw new Error(`${fn}: tidak ada data`)
  const [decoded] = [result]
  return decoded
}

console.log('ARCOX — verifikasi adapter swap Arc mainnet')
console.log(`rpc : ${RPC}`)

console.log('\n① state adapter on-chain')
for (const [label, address] of [['adapter Circle (dipakai aplikasi)', CIRCLE_ADAPTER], ['proxy self-deployed (dipensiunkan)', ARCOX_SELF_DEPLOYED_ADAPTER]]) {
  const code = await rpc('eth_getCode', [address, 'latest'])
  const bytes = typeof code === 'string' ? (code.length - 2) / 2 : 0
  record(bytes > 2, `${label} ${address}`, `${bytes} byte kode`)
  if (bytes <= 2) continue
  try {
    const owner = `0x${(await read(address, 'owner')).slice(-40)}`
    const configurator = `0x${(await read(address, 'configurator')).slice(-40)}`
    const signerCount = BigInt(await read(address, 'signerCount'))
    const threshold = BigInt(await read(address, 'signerThreshold'))
    const domainSeparator = await read(address, 'domainSeparator')
    console.log(`      owner=${owner} configurator=${configurator} signerCount=${signerCount} threshold=${threshold}`)
    console.log(`      domainSeparator=${domainSeparator}`)
  } catch (error) {
    record(false, `${label}: baca state`, String(error.message).slice(0, 120))
  }
}

// Domain EIP-712 lokal harus sama persis dengan domain on-chain kedua adapter.
const domainSeparatorOf = address => keccak256(encodeAbiParameters(
  parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'),
  [keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(toHex('Adapter')), keccak256(toHex('1')), BigInt(CHAIN_ID), address],
))
const INSTRUCTION_TYPEHASH = keccak256(toHex('Instruction(address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)'))
const TOKEN_RECIPIENT_TYPEHASH = keccak256(toHex('TokenRecipient(address token,address beneficiary)'))
const EXECUTION_PARAMS_TYPEHASH = keccak256(toHex('ExecutionParams(Instruction[] instructions,TokenRecipient[] tokens,uint256 execId,uint256 deadline,bytes metadata)Instruction(address target,bytes data,uint256 value,address tokenIn,uint256 amountToApprove,address tokenOut,uint256 minTokenOut)TokenRecipient(address token,address beneficiary)'))
const structHashOf = params => {
  const instructionHashes = (params.instructions || []).map(instruction => keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, address, bytes32, uint256, address, uint256, address, uint256'),
    [INSTRUCTION_TYPEHASH, instruction.target, keccak256(instruction.data), BigInt(instruction.value), instruction.tokenIn, BigInt(instruction.amountToApprove), instruction.tokenOut, BigInt(instruction.minTokenOut)],
  )))
  const tokenHashes = (params.tokens || []).map(token => keccak256(encodeAbiParameters(parseAbiParameters('bytes32, address, address'), [TOKEN_RECIPIENT_TYPEHASH, token.token, token.beneficiary])))
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, bytes32, uint256, uint256, bytes32'),
    [EXECUTION_PARAMS_TYPEHASH, keccak256(concatHex(instructionHashes)), keccak256(concatHex(tokenHashes)), BigInt(params.execId), BigInt(params.deadline), keccak256(params.metadata || '0x')],
  ))
}

const encodeExecute = (params, owner, amount, signature) => encodeFunctionData({
  abi: ADAPTER_EXECUTE_ABI,
  functionName: 'execute',
  args: [
    {
      instructions: (params.instructions || []).map(instruction => ({
        target: instruction.target,
        data: instruction.data,
        value: BigInt(instruction.value || 0),
        tokenIn: instruction.tokenIn,
        amountToApprove: BigInt(instruction.amountToApprove || 0),
        tokenOut: instruction.tokenOut,
        minTokenOut: BigInt(instruction.minTokenOut || 0),
      })),
      tokens: (params.tokens || []).map(token => ({ token: token.token, beneficiary: token.beneficiary })),
      execId: BigInt(params.execId || 0),
      deadline: BigInt(params.deadline || 0),
      metadata: params.metadata || '0x',
    },
    [{ permitType: 0, token: USDC, amount: BigInt(amount), permitCalldata: '0x' }],
    signature,
  ],
})
const simulate = async (address, data, from) => {
  const body = await rpc('eth_call', [{ from, to: address, data }, 'latest'])
  if (typeof body === 'string') return { ok: true, reason: 'tidak revert' }
  const raw = String(body?.error?.data || '')
  let decoded = ''
  if (raw.startsWith('0x08c379a0')) {
    // Error(string) — revert beralasan dari ERC20/di dalam instruksi.
    try {
      const payload = raw.slice(10)
      const length = parseInt(payload.slice(64, 128), 16)
      decoded = Buffer.from(payload.slice(128, 128 + length * 2), 'hex').toString('utf8')
    } catch { decoded = 'Error(string)' }
  } else if (raw.startsWith('0x') && raw.length >= 10) {
    try { decoded = decodeErrorResult({ abi: ADAPTER_EXECUTE_ABI, data: raw }).errorName } catch { decoded = raw.slice(0, 10) }
  } else {
    decoded = String(body?.error?.message || 'revert').slice(0, 100)
  }
  const isInvalidSignature = raw.toLowerCase().startsWith(INVALID_SIGNATURE) || /InvalidSignature/i.test(decoded)
  return { ok: false, reason: `${decoded}${isInvalidSignature ? ` (${INVALID_SIGNATURE} InvalidSignature)` : ''}`, isInvalidSignature }
}

console.log('\n② signature Stablecoin Service → signer di tiap domain')
if (!KEY) {
  console.log('   ⚠️  CIRCLE_API_KEY_MAINNET tidak ada — bagian ini dilewati.')
} else {
  const sample = { tx: null, owner: '', amount: '' }
  const signers = new Map()
  for (let i = 0; i < 8; i++) {
    const owner = privateKeyToAccount(generatePrivateKey()).address
    const res = await fetch(`${BASE}/v1/stablecoinKits/swap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'arcox-api/1.0' },
      body: JSON.stringify({
        tokenInAddress: USDC, tokenInChain: 'Arc', tokenOutAddress: EURC, tokenOutChain: 'Arc',
        fromAddress: owner, toAddress: owner, amount: String(95000 + i * 500), slippageBps: 300,
        config: { customFee: { percentageBps: 0, recipientAddress: owner } },
      }),
    })
    const data = await res.json().catch(() => ({}))
    const tx = data?.transaction
    if (!tx?.signature) continue
    for (const [label, address] of [['circle', CIRCLE_ADAPTER], ['arcox', ARCOX_SELF_DEPLOYED_ADAPTER]]) {
      const digest = keccak256(concatHex(['0x1901', domainSeparatorOf(address), structHashOf(tx.executionParams)]))
      const recovered = await recoverAddress({ hash: digest, signature: tx.signature })
      if (label === 'circle') signers.set(recovered, (signers.get(recovered) || 0) + 1)
      if (i === 0) console.log(`      domain ${label.padEnd(6)} → signer ${recovered}`)
    }
    if (!sample.tx) Object.assign(sample, { tx, owner, amount: String(95000) })
  }
  record(signers.size > 0, 'signer pulih konsisten di domain adapter Circle', `${signers.size} alamat unik dari 8 sampel: ${[...signers.keys()].join(', ')}`)
  for (const address of signers.keys()) {
    const isSigner = await read(CIRCLE_ADAPTER, 'isSigner', [address])
    record(BigInt(isSigner) === 1n, `isSigner(${address}) di adapter Circle`, BigInt(isSigner) === 1n ? 'true' : 'false')
  }
  if (sample.tx) {
    console.log('\n③ simulasi execute dengan payload asli Stablecoin Service')
    const data = encodeExecute(sample.tx.executionParams, sample.owner, sample.amount, sample.tx.signature)
    const circle = await simulate(CIRCLE_ADAPTER, data, sample.owner)
    record(!/InvalidSignature/.test(circle.reason), 'adapter Circle: signature LOLOS verifikasi', circle.reason)
    const legacy = await simulate(ARCOX_SELF_DEPLOYED_ADAPTER, data, sample.owner)
    record(legacy.isInvalidSignature === true, 'proxy self-deployed: payload yang sama DITOLAK (InvalidSignature) — ini akar masalah lama', legacy.reason)
  }
}

const failed = results.filter(item => !item.ok)
console.log('\nRingkasan')
console.log(`  lulus : ${results.length - failed.length}/${results.length}`)
for (const item of failed) console.log(`    ❌ ${item.label} — ${item.detail}`)
console.log('  kesimpulan: swap EOA mainnet WAJIB memakai adapter Circle; proxy self-deployed bikin tx gagal setelah approve.')
process.exit(failed.length ? 1 : 0)
