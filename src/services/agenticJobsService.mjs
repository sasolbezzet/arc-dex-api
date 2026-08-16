// On-chain Agentic Jobs (ERC-8004 identity + ERC-8183 commerce) executed by the
// Agent Wallet MSCA through the session key, mirroring the frontend Agentic
// panel flow: register agent identity, create job, set budget, fund escrow,
// submit deliverable, complete. All mutations go through the ARC Memo contract
// exactly like the frontend (same memoId / memoData conventions).
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, getAddress, http, keccak256, toHex, formatUnits, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { IDENTITY_REGISTRY } from './agentIdentityService.mjs'
import { ARC_MEMO_CONTRACT } from './arcMemoService.mjs'
import { resolveArcRpc } from '../config/arcRpc.mjs'
import { getSessionKey, executeViaSession } from './sessionKeyService.mjs'

export const AGENTIC_COMMERCE = '0x0747EEf0706327138c69792bF28Cd525089e4583'
export const ARC_USDC = process.env.X402_USDC_ADDRESS || '0x3600000000000000000000000000000000000000'
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const agenticCommerceAbi = [
  { type: 'function', name: 'createJob', stateMutability: 'nonpayable', inputs: [
    { name: 'provider', type: 'address' },
    { name: 'evaluator', type: 'address' },
    { name: 'expiredAt', type: 'uint256' },
    { name: 'description', type: 'string' },
    { name: 'hook', type: 'address' },
  ], outputs: [{ name: 'jobId', type: 'uint256' }] },
  { type: 'function', name: 'setBudget', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'fund', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' },
    { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'submit', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' },
    { name: 'deliverable', type: 'bytes32' },
    { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'complete', stateMutability: 'nonpayable', inputs: [
    { name: 'jobId', type: 'uint256' },
    { name: 'reason', type: 'bytes32' },
    { name: 'optParams', type: 'bytes' },
  ], outputs: [] },
  { type: 'function', name: 'getJob', stateMutability: 'view', inputs: [{ name: 'jobId', type: 'uint256' }], outputs: [{
    type: 'tuple',
    components: [
      { name: 'id', type: 'uint256' },
      { name: 'client', type: 'address' },
      { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' },
      { name: 'description', type: 'string' },
      { name: 'budget', type: 'uint256' },
      { name: 'expiredAt', type: 'uint256' },
      { name: 'status', type: 'uint8' },
      { name: 'hook', type: 'address' },
    ],
  }] },
  { type: 'event', name: 'JobCreated', inputs: [
    { indexed: true, name: 'jobId', type: 'uint256' },
    { indexed: true, name: 'client', type: 'address' },
    { indexed: true, name: 'provider', type: 'address' },
    { indexed: false, name: 'evaluator', type: 'address' },
    { indexed: false, name: 'expiredAt', type: 'uint256' },
    { indexed: false, name: 'hook', type: 'address' },
  ], anonymous: false },
]

const identityAbi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'metadataURI', type: 'string' }], outputs: [] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }] },
  { type: 'event', name: 'Transfer', inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: true, name: 'tokenId', type: 'uint256' },
  ], anonymous: false },
]

const memoAbi = [{
  type: 'function', name: 'memo', stateMutability: 'nonpayable',
  inputs: [
    { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'memoId', type: 'bytes32' },
    { name: 'memoData', type: 'bytes' },
  ], outputs: [],
}]

const approveAbi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }]

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
]

export const JOB_STATUS = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired']

export function hashTextBytes32(text) {
  return keccak256(toHex(String(text || 'arcox-agentic-deliverable')))
}

/** Same memoId/memoData convention as the frontend Agentic panel. */
export function buildJobMemo({ agentId, referenceId, service = 'agent_job', amount = '' }) {
  if (!/^\d+$/.test(String(agentId || ''))) throw new Error('Agent Identity (agentId) required for Agent Jobs')
  const memoId = keccak256(toHex(`${agentId}::${referenceId}`))
  const memoData = toHex(JSON.stringify({
    agentId: String(agentId),
    requestIdHash: keccak256(toHex(String(referenceId))),
    service,
    ...(amount ? { amount: String(amount) } : {}),
  }))
  return { memoId, memoData }
}

/** Encode commerce calldata for delivery through the ARC Memo contract. */
function memoCall(target, functionName, args, memo) {
  const data = encodeFunctionData({ abi: agenticCommerceAbi, functionName, args })
  return { to: ARC_MEMO_CONTRACT, value: 0n, abi: memoAbi, functionName: 'memo', args: [target, data, memo.memoId, memo.memoData] }
}

export function registerAgentCall(metadataUri) {
  return { to: IDENTITY_REGISTRY, value: 0n, abi: identityAbi, functionName: 'register', args: [String(metadataUri || '')] }
}

export function createJobCall({ agentId, referenceId, provider, evaluator, description, expiresInHours = 24 }) {
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + Math.max(1, Number(expiresInHours) || 24) * 3600)
  const memo = buildJobMemo({ agentId, referenceId })
  return memoCall(AGENTIC_COMMERCE, 'createJob', [getAddress(provider), getAddress(evaluator), expiredAt, String(description || ''), ZERO_ADDRESS], memo)
}

export function setBudgetCall({ agentId, jobId, amount }) {
  const memo = buildJobMemo({ agentId, referenceId: jobId, amount })
  return memoCall(AGENTIC_COMMERCE, 'setBudget', [BigInt(jobId), parseUnits(String(amount), 6), '0x'], memo)
}

export function fundJobCalls({ agentId, jobId, amount }) {
  const units = parseUnits(String(amount), 6)
  const memo = buildJobMemo({ agentId, referenceId: jobId, amount })
  return [
    { to: ARC_USDC, value: 0n, abi: approveAbi, functionName: 'approve', args: [AGENTIC_COMMERCE, units] },
    memoCall(AGENTIC_COMMERCE, 'fund', [BigInt(jobId), '0x'], memo),
  ]
}

export function submitDeliverableCall({ agentId, jobId, deliverable }) {
  const memo = buildJobMemo({ agentId, referenceId: jobId })
  return memoCall(AGENTIC_COMMERCE, 'submit', [BigInt(jobId), hashTextBytes32(deliverable), '0x'], memo)
}

export function completeJobCall({ agentId, jobId, reason }) {
  const memo = buildJobMemo({ agentId, referenceId: jobId })
  return memoCall(AGENTIC_COMMERCE, 'complete', [BigInt(jobId), hashTextBytes32(String(reason || 'deliverable-approved')), '0x'], memo)
}

export function parseJobIdFromLogs(logs) {
  for (const log of logs || []) {
    try {
      const decoded = decodeEventLog({ abi: agenticCommerceAbi, data: log.data, topics: log.topics })
      if (decoded.eventName === 'JobCreated') return decoded.args.jobId.toString()
    } catch { /* keep scanning */ }
  }
  throw new Error('JobCreated event tidak ditemukan di receipt.')
}

export function parseAgentIdFromLogs(logs, owner) {
  const normalizedOwner = getAddress(owner).toLowerCase()
  for (const log of logs || []) {
    try {
      const decoded = decodeEventLog({ abi: identityAbi, data: log.data, topics: log.topics })
      if (decoded.eventName === 'Transfer' && getAddress(decoded.args.to).toLowerCase() === normalizedOwner) {
        return decoded.args.tokenId.toString()
      }
    } catch { /* keep scanning */ }
  }
  throw new Error('Transfer event agent tidak ditemukan di receipt.')
}

function publicClient() {
  const rpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
  const chain = defineChain({
    id: Number(process.env.ARC_CHAIN_ID || 5042002),
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  })
  return createPublicClient({ chain, transport: http(rpc, { timeout: 12_000, retryCount: 1 }) })
}

// The ARC Memo contract routes through the callFrom precompile which is
// EOA-only (tx.origin must equal msg.sender). An ERC-4337 MSCA can never be
// the memo sender, so every job mutation is signed by the session delegate
// EOA — the same key that authorizes the MSCA UserOps. The delegate is
// auto-funded from the MSCA (native gas + the escrow amount) by the tools.
export async function signEoaTransaction({ privateKey, to, abi, functionName, args = [], value = 0n, chainKey = 'arc-testnet' }) {
  const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`)
  const rpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
  const chain = defineChain({
    id: Number(process.env.ARC_CHAIN_ID || 5042002),
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'ArcScan', url: 'https://testnet.arcscan.app' } },
  })
  const transport = http(rpc, { timeout: 15_000, retryCount: 1 })
  const wallet = createWalletClient({ account, chain, transport })
  const publicClient = createPublicClient({ chain, transport })
  const txHash = await wallet.writeContract({
    address: to,
    abi,
    functionName,
    args,
    ...(value ? { value } : {}),
    gas: 900_000n,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 })
  if (receipt.status !== 'success') {
    const err = new Error('Agentic job EOA transaction reverted')
    err.receipt = receipt
    throw err
  }
  return { txHash, explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`, receipt }
}

/** Resolve the active session delegate EOA (private key decrypted from vault) for a wallet. */
function resolveDelegate(walletAddress) {
  const session = getSessionKey(walletAddress)
  if (!session || session.active !== true) throw new Error('Session not available: no_session')
  if (!session.delegatePrivateKey || !session.delegateAddress) throw new Error('Session not available: missing delegate key')
  return { delegateAddress: getAddress(session.delegateAddress), delegatePrivateKey: session.delegatePrivateKey }
}

/** Public helper: return only the delegate EOA address for an active session wallet. */
export function resolveDelegateAddress(walletAddress) {
  return resolveDelegate(walletAddress).delegateAddress
}

/**
 * Top up the delegate EOA from the Agent Wallet MSCA so it can sign memo txs.
 * On Arc the native USDC (18-dec) and the ERC-20 interface (6-dec) share the
 * SAME underlying balance, so a single value transfer covers both the escrow
 * amount (fund) and the gas for every memo tx (paid in USDC on Arc). Without
 * the gas margin the fund() memo reverts (balance < escrow + gas).
 * No-ops when the delegate already holds enough. Returns the delegate signer.
 */
export async function topUpDelegateEoa(walletAddress, { nativeAmount = '0.2', usdcAmount = '0' } = {}) {
  const { delegateAddress, delegatePrivateKey } = resolveDelegate(walletAddress)
  const rpc = publicClient()
  const [delegateBal, mscaBal] = await Promise.all([
    rpc.getBalance({ address: delegateAddress }).catch(() => 0n),
    rpc.getBalance({ address: getAddress(walletAddress) }).catch(() => 0n),
  ])
  // Express everything in 18-dec native units: escrow (6-dec input) + gas buffer.
  const needed = parseUnits(String(usdcAmount || '0'), 18) + parseUnits(String(nativeAmount || '0.2'), 18)
  const shortfall = needed - delegateBal
  if (shortfall > 0n) {
    if (mscaBal < shortfall) {
      throw new Error(`Agent Wallet USDC tidak cukup untuk job ini (butuh ${formatUnits(needed, 18)}, tersedia ${formatUnits(mscaBal, 18)}). Top up wallet via bridge/faucet lalu coba lagi.`)
    }
    const res = await executeViaSession(walletAddress, [{ to: delegateAddress, value: shortfall, data: '0x' }], { paymaster: true, chainKey: 'arc-testnet', feeProfile: 'arc-pay', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true })
    if (res.status !== 'success') throw new Error(`delegate top-up failed: ${res.reason || res.error || 'unknown'}`)
  }
  return { delegateAddress, delegatePrivateKey }
}

/** Execute a single memo job mutation signed by the delegate EOA (auto-funded). */
export async function executeMemoViaDelegate(walletAddress, call, { usdcAmount = '0', nativeAmount = '0.2' } = {}) {
  const { delegatePrivateKey } = await topUpDelegateEoa(walletAddress, { nativeAmount, usdcAmount })
  const result = await signEoaTransaction({ privateKey: delegatePrivateKey, ...call })
  return { ...result, delegateAddress: getAddress((await resolveDelegate(walletAddress)).delegateAddress) }
}

/** Fund escrow: top-up delegate USDC → delegate approves commerce → delegate memo-fund. */
export async function executeFundViaDelegate(walletAddress, { agentId, jobId, amount }) {
  const { delegatePrivateKey } = await topUpDelegateEoa(walletAddress, { usdcAmount: amount })
  const units = parseUnits(String(amount), 6)
  const approve = await signEoaTransaction({ privateKey: delegatePrivateKey, to: ARC_USDC, abi: erc20Abi, functionName: 'approve', args: [AGENTIC_COMMERCE, units] })
  const fundCall = fundJobCalls({ agentId, jobId, amount })[1]
  const fund = await signEoaTransaction({ privateKey: delegatePrivateKey, to: fundCall.to, abi: fundCall.abi, functionName: fundCall.functionName, args: fundCall.args })
  return {
    approveTxHash: approve.txHash,
    txHash: fund.txHash,
    explorerUrl: fund.explorerUrl,
    delegateAddress: getAddress((await resolveDelegate(walletAddress)).delegateAddress),
    approveExplorerUrl: `https://testnet.arcscan.app/tx/${approve.txHash}`,
  }
}

export async function readAgenticJob(jobId) {
  const rpc = publicClient()
  const raw = await rpc.readContract({
    address: AGENTIC_COMMERCE,
    abi: agenticCommerceAbi,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  })
  const job = raw || {}
  const statusIndex = Number(job.status ?? 0)
  return {
    id: String(job.id ?? jobId),
    client: String(job.client ?? ''),
    provider: String(job.provider ?? ''),
    evaluator: String(job.evaluator ?? ''),
    description: String(job.description ?? ''),
    budget: formatUnits(BigInt(job.budget ?? 0n), 6),
    expiredAt: Number(job.expiredAt ?? 0),
    status: JOB_STATUS[statusIndex] ?? `Status ${statusIndex}`,
    hook: String(job.hook ?? ZERO_ADDRESS),
    contract: AGENTIC_COMMERCE,
    network: 'arc-testnet',
  }
}
