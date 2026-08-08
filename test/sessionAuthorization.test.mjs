import test from 'node:test'
import assert from 'node:assert/strict'

const walletAddress = '0x1111111111111111111111111111111111111111'
const delegateAddress = '0x2222222222222222222222222222222222222222'
const userOpHash = `0x${'11'.repeat(32)}`

test('authorization validation rejects a successful operation from another MSCA', async () => {
  const { validateAuthorizationUserOperation } = await import('../src/services/sessionKeyService.mjs?auth-test-1')
  const result = validateAuthorizationUserOperation({
    walletAddress,
    delegateAddress,
    authorizationUserOpHash: userOpHash,
    receipt: { success: true, sender: '0x3333333333333333333333333333333333333333', receipt: { status: 'success' } },
    operation: { sender: walletAddress, callData: '0x' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'authorization sender mismatch')
})

test('authorization validation requires addOwners calldata for the reserved delegate', async () => {
  const { validateAuthorizationUserOperation } = await import('../src/services/sessionKeyService.mjs?auth-test-2')
  const result = validateAuthorizationUserOperation({
    walletAddress,
    delegateAddress,
    authorizationUserOpHash: userOpHash,
    receipt: { success: true, sender: walletAddress, receipt: { status: 'success' } },
    operation: { sender: walletAddress, callData: '0xdeadbeef' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'delegate authorization calldata mismatch')
})

test('authorization validation accepts exact successful addOwners calldata', async () => {
  const { encodeFunctionData } = await import('viem')
  const { validateAuthorizationUserOperation } = await import('../src/services/sessionKeyService.mjs?auth-test-3')
  const abi = [{
    type: 'function', name: 'addOwners', stateMutability: 'nonpayable',
    inputs: [
      { name: 'ownersToAdd', type: 'address[]' }, { name: 'weightsToAdd', type: 'uint256[]' },
      { name: 'publicKeyOwnersToAdd', type: 'tuple[]', components: [{ name: 'x', type: 'uint256' }, { name: 'y', type: 'uint256' }] },
      { name: 'publicKeyWeightsToAdd', type: 'uint256[]' }, { name: 'newThresholdWeight', type: 'uint256' },
    ], outputs: [],
  }]
  const callData = encodeFunctionData({ abi, functionName: 'addOwners', args: [[delegateAddress], [1n], [], [], 0n] })
  const result = validateAuthorizationUserOperation({
    walletAddress,
    delegateAddress,
    authorizationUserOpHash: userOpHash,
    receipt: { success: true, sender: walletAddress, receipt: { status: 'success' } },
    operation: { sender: walletAddress, callData },
  })
  assert.equal(result.ok, true)
  assert.equal(result.delegateAddress.toLowerCase(), delegateAddress)
})
