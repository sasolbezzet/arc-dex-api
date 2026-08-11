import test from 'node:test'
import assert from 'node:assert/strict'

const walletAddress = '0x1111111111111111111111111111111111111111'
const delegateAddress = '0x2222222222222222222222222222222222222222'
const userOpHash = `0x${'11'.repeat(32)}`

test('records one submitted authorization hash without activating the reservation', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'arcox-auth-attempt-'))
  const path = join(dir, 'session-keys.json')
  await writeFile(path, JSON.stringify({ users: { [walletAddress.toLowerCase()]: { walletAddress, delegateAddress, chain: 'arc-testnet', active: false, pendingAuthorization: true } }, aliases: {} }))
  const previousPath = process.env.SESSION_KEYS_PATH
  process.env.SESSION_KEYS_PATH = path
  try {
    const { recordSessionAuthorizationAttempt } = await import('../src/services/sessionKeyService.mjs?auth-test-record-' + Date.now())
    const result = recordSessionAuthorizationAttempt(walletAddress, { walletAddress, delegateAddress, authorizationUserOpHash: userOpHash })
    assert.equal(result.authorizationUserOpHash, userOpHash)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(saved.users[walletAddress.toLowerCase()].active, false)
    assert.equal(saved.users[walletAddress.toLowerCase()].authorizationUserOpHash, userOpHash)
    assert.throws(() => recordSessionAuthorizationAttempt(walletAddress, { walletAddress, delegateAddress, authorizationUserOpHash: '0x' + '22'.repeat(32) }), /different authorization/)
    const replaced = recordSessionAuthorizationAttempt(walletAddress, {
      walletAddress,
      delegateAddress,
      authorizationUserOpHash: '0x' + '22'.repeat(32),
      previousAuthorizationUserOpHash: userOpHash,
      previousOutcome: 'failed',
    })
    assert.equal(replaced.authorizationUserOpHash, '0x' + '22'.repeat(32))
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    await rm(dir, { recursive: true, force: true })
  }
})

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

test('authorization validation rejects an invalid zero-threshold addOwners payload', async () => {
  const { encodeFunctionData } = await import('viem')
  const { validateAuthorizationUserOperation } = await import('../src/services/sessionKeyService.mjs?auth-test-zero-threshold')
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
  const callData = encodeFunctionData({ abi, functionName: 'addOwners', args: [[delegateAddress], [1n], [], [], 1n] })
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
