import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, getAddress, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { IDENTITY_REGISTRY } from './agentIdentityService.mjs'

export const ARC_MEMO_CONTRACT = process.env.ARC_MEMO_CONTRACT || '0x5294E9927c3306DcBaDb03fe70b92e01cCede505'
const memoAbi = [{
  type: 'function', name: 'memo', stateMutability: 'nonpayable',
  inputs: [
    { name: 'target', type: 'address' },
    { name: 'data', type: 'bytes' },
    { name: 'memoId', type: 'bytes32' },
    { name: 'memoData', type: 'bytes' },
  ], outputs: [],
}]
const ownerOfAbi = [{ type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] }]

export function buildAgentMemo(input = {}) {
  const agentId = String(input.agentId || '').trim()
  const sbtTokenId = String(input.sbtTokenId || '').trim()
  if (!/^\d+$/.test(agentId) && !/^\d+$/.test(sbtTokenId)) return null
  const paymentId = String(input.paymentId || '')
  const referenceId = String(input.jobId || input.requestId || '')
  const identity = /^\d+$/.test(agentId) ? `agent:${agentId}` : `pass:${sbtTokenId}`
  const memoId = keccak256(toHex(`${identity}:${paymentId}:${referenceId}`))
  const metadata = {
    ...(agentId ? { agentId } : {}),
    ...(sbtTokenId ? { sbtTokenId } : {}),
    ...(input.apiKeyIdHash ? { apiKeyIdHash: String(input.apiKeyIdHash) } : {}),
    paymentIdHash: paymentId ? keccak256(toHex(paymentId)) : undefined,
    ...(input.jobId ? { jobIdHash: keccak256(toHex(String(input.jobId))) } : {}),
    ...(input.requestId ? { requestIdHash: keccak256(toHex(String(input.requestId))) } : {}),
    service: String(input.service || 'ai_router').slice(0, 24),
    ...(input.model ? { model: String(input.model).slice(0, 64) } : {}),
    ...(input.amount ? { amount: String(input.amount).slice(0, 32) } : {}),
    ...(input.treasury ? { treasury: getAddress(input.treasury) } : {}),
    ...(input.settlementTxHash ? { settlementTxHash: String(input.settlementTxHash) } : {}),
  }
  return { memoId, memoData: toHex(JSON.stringify(metadata)), metadata }
}

export async function submitAgentMemoProof(input = {}) {
  const memo = buildAgentMemo(input)
  if (!memo) return { status: 'not_required' }
  const privateKey = delegatePrivateKey()
  if (!privateKey) return { status: 'unavailable', reason: 'AI Router delegate signer is not configured' }
  const account = privateKeyToAccount(privateKey)
  const chain = defineChain({
    id: Number(process.env.ARC_CHAIN_ID || 5042002), name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [process.env.ARC_RPC_URL || process.env.RPC || 'https://rpc.testnet.arc.network/'] } },
  })
  const transport = http(chain.rpcUrls.default.http[0], { timeout: 12_000, retryCount: 1 })
  const wallet = createWalletClient({ account, chain, transport })
  const publicClient = createPublicClient({ chain, transport })
  const tokenId = input.agentId || input.sbtTokenId
  const target = input.agentId ? IDENTITY_REGISTRY : getAddress(input.apiPassAddress)
  const ownerOfData = encodeFunctionData({ abi: ownerOfAbi, functionName: 'ownerOf', args: [BigInt(tokenId)] })
  const txHash = await wallet.writeContract({ address: ARC_MEMO_CONTRACT, abi: memoAbi, functionName: 'memo', args: [target, ownerOfData, memo.memoId, memo.memoData] })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 })
  if (receipt.status !== 'success') throw new Error('Agent memo proof transaction reverted')
  return { status: 'submitted', txHash, memoId: memo.memoId, memoData: memo.memoData }
}

function delegatePrivateKey() {
  const key = process.env.AI_ROUTER_DELEGATE_PRIVATE_KEY || process.env.EOA_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY || ''
  if (!key) return ''
  return key.startsWith('0x') ? key : `0x${key}`
}
