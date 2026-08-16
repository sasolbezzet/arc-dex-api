import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, keccak256, toHex, getAddress } from 'viem'
import {
  agenticCommerceAbi,
  AGENTIC_COMMERCE,
  ARC_USDC,
  buildJobMemo,
  createJobCall,
  setBudgetCall,
  fundJobCalls,
  submitDeliverableCall,
  completeJobCall,
  hashTextBytes32,
  parseJobIdFromLogs,
  parseAgentIdFromLogs,
  JOB_STATUS,
} from '../src/services/agenticJobsService.mjs'
import { ARC_MEMO_CONTRACT } from '../src/services/arcMemoService.mjs'

const DELEGATE = '0x7635330Bb4a39bAb334bD2d68B22a294e0A1a2Dc'

test('buildJobMemo produces deterministic memoId + memoData (frontend convention)', () => {
  const a = buildJobMemo({ agentId: '878956', referenceId: '42', amount: '1' })
  const b = buildJobMemo({ agentId: '878956', referenceId: '42', amount: '1' })
  assert.equal(a.memoId, b.memoId)
  assert.equal(a.memoData, b.memoData)
  assert.equal(a.memoId, keccak256(toHex('878956::42')))
  assert.ok(a.memoId.startsWith('0x'))
  assert.ok(a.memoData.startsWith('0x'))
})

test('buildJobMemo rejects missing/non-numeric agentId', () => {
  assert.throws(() => buildJobMemo({ agentId: '', referenceId: '1' }), /agentId\) required/i)
  assert.throws(() => buildJobMemo({ agentId: 'abc', referenceId: '1' }), /agentId\) required/i)
})

test('createJobCall wraps commerce calldata in an ARC Memo call', () => {
  const call = createJobCall({ agentId: '878956', referenceId: 'ref-1', provider: DELEGATE, evaluator: DELEGATE, description: 'demo', expiresInHours: 24 })
  assert.equal(call.to, ARC_MEMO_CONTRACT)
  assert.equal(call.functionName, 'memo')
  const [target, data] = call.args
  assert.equal(getAddress(target), getAddress(AGENTIC_COMMERCE))
  const decoded = decodeFunctionData({ abi: agenticCommerceAbi, data })
  assert.equal(decoded.functionName, 'createJob')
  assert.equal(getAddress(decoded.args[0]), getAddress(DELEGATE))
  assert.equal(getAddress(decoded.args[1]), getAddress(DELEGATE))
})

test('fundJobCalls returns approve + memo-fund pair in order', () => {
  const calls = fundJobCalls({ agentId: '878956', jobId: '180057', amount: '1' })
  assert.equal(calls.length, 2)
  const [approve, fund] = calls
  assert.equal(approve.to, ARC_USDC)
  assert.equal(approve.functionName, 'approve')
  assert.equal(getAddress(approve.args[0]), getAddress(AGENTIC_COMMERCE))
  assert.equal(approve.args[1], 1000000n) // 1 USDC in 6 decimals
  assert.equal(fund.to, ARC_MEMO_CONTRACT)
  assert.equal(fund.functionName, 'memo')
  const [target, data] = fund.args
  assert.equal(getAddress(target), getAddress(AGENTIC_COMMERCE))
  assert.equal(decodeFunctionData({ abi: agenticCommerceAbi, data }).functionName, 'fund')
})

test('setBudgetCall / submitDeliverableCall / completeJobCall encode correctly', () => {
  const budget = setBudgetCall({ agentId: '878956', jobId: '180057', amount: '0.5' })
  assert.equal(decodeFunctionData({ abi: agenticCommerceAbi, data: budget.args[1] }).functionName, 'setBudget')
  assert.equal(decodeFunctionData({ abi: agenticCommerceAbi, data: budget.args[1] }).args[1], 500000n)

  const submit = submitDeliverableCall({ agentId: '878956', jobId: '180057', deliverable: 'done' })
  assert.equal(decodeFunctionData({ abi: agenticCommerceAbi, data: submit.args[1] }).functionName, 'submit')
  assert.equal(decodeFunctionData({ abi: agenticCommerceAbi, data: submit.args[1] }).args[1], hashTextBytes32('done'))

  const complete = completeJobCall({ agentId: '878956', jobId: '180057', reason: 'ok' })
  assert.equal(decodeFunctionData({ abi: agenticCommerceAbi, data: complete.args[1] }).functionName, 'complete')
})

test('hashTextBytes32 is deterministic keccak256', () => {
  assert.equal(hashTextBytes32('x'), keccak256(toHex('x')))
  assert.equal(hashTextBytes32('x'), hashTextBytes32('x'))
})

test('parseJobIdFromLogs extracts JobCreated event', () => {
  const log = buildEventLog('JobCreated', [180057n, DELEGATE, DELEGATE, DELEGATE, 0n, '0x0000000000000000000000000000000000000000'])
  assert.equal(parseJobIdFromLogs([log]), '180057')
  assert.throws(() => parseJobIdFromLogs([]), /JobCreated event/i)
})

test('parseAgentIdFromLogs extracts Transfer event to owner', () => {
  const owner = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769'
  const log = buildEventLog('Transfer', ['0x0000000000000000000000000000000000000000', owner, 879998n], identityAbi)
  assert.equal(parseAgentIdFromLogs([log], owner), '879998')
  assert.throws(() => parseAgentIdFromLogs([log], DELEGATE), /Transfer event agent/i)
})

test('JOB_STATUS covers the commerce enum', () => {
  assert.deepEqual(JOB_STATUS, ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired'])
  assert.equal(JOB_STATUS[2], 'Submitted')
})

// ── helpers ──

const identityAbi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'metadataURI', type: 'string' }], outputs: [] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'event', name: 'Transfer', inputs: [
    { indexed: true, name: 'from', type: 'address' },
    { indexed: true, name: 'to', type: 'address' },
    { indexed: true, name: 'tokenId', type: 'uint256' },
  ], anonymous: false },
]

function buildEventLog(eventName, args, abi = agenticCommerceAbi) {
  const event = abi.find(item => item.type === 'event' && item.name === eventName)
  const indexed = event.inputs.filter(input => input.indexed)
  const nonIndexed = event.inputs.filter(input => !input.indexed)
  return {
    address: AGENTIC_COMMERCE,
    topics: [
      keccak256(toHex(`${eventName}(${event.inputs.map(i => i.type).join(',')})`)),
      ...indexed.map((input) => encodeTopic(input.type, args[event.inputs.indexOf(input)])),
    ],
    data: nonIndexed.length
      ? encodeAbiParameters(nonIndexed.map(i => ({ type: i.type })), nonIndexed.map(i => args[event.inputs.indexOf(i)]))
      : '0x',
  }
}

function encodeTopic(type, value) {
  if (type === 'address') return encodeAbiParameters([{ type: 'address' }], [value])
  if (type === 'uint256') return encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)])
  return keccak256(toHex(String(value)))
}

// make sure decodeEventLog import is exercised (used by the service itself)
assert.ok(typeof decodeEventLog === 'function')
