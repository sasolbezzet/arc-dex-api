import test from 'node:test'
import assert from 'node:assert/strict'

const walletAddress = '0x1111111111111111111111111111111111111111'
const delegateAddress = '0x2222222222222222222222222222222222222222'
const userOpHash = `0x${'11'.repeat(32)}`

test('classifies Circle Modular 401 as a client-key configuration error', async () => {
  const { classifyCircleModularError } = await import('../src/services/sessionKeyService.mjs?auth-test-circle-key-' + Date.now())
  assert.equal(classifyCircleModularError(new Error('HTTP request failed: 401 Invalid credentials')), 'circle_modular_client_key_invalid')
  assert.equal(classifyCircleModularError(new Error('temporary receipt unavailable')), null)
})

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

test('destination chain authorization never falls back to the base-chain legacy hash', async () => {
  const { resolveAuthorizationUserOpHash } = await import('../src/services/sessionKeyService.mjs?auth-test-chain-hash')
  const entry = {
    chain: 'arc-testnet',
    authorizationUserOpHash: '0x' + '11'.repeat(32),
    authorizationUserOpHashes: { 'base-sepolia': '0x' + '22'.repeat(32) },
  }
  assert.equal(resolveAuthorizationUserOpHash(entry, 'arc-testnet'), '0x' + '11'.repeat(32))
  assert.equal(resolveAuthorizationUserOpHash(entry, 'base-sepolia'), '0x' + '22'.repeat(32))
  assert.equal(resolveAuthorizationUserOpHash(entry, 'arbitrum-sepolia'), '')
})

test('session aliases cannot be rebound to a different MSCA', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'arcox-alias-bind-'))
  const path = join(dir, 'session-keys.json')
  const owner = '0x' + '44'.repeat(20)
  const first = '0x' + '55'.repeat(20)
  const second = '0x' + '66'.repeat(20)
  await writeFile(path, JSON.stringify({ users: {}, aliases: { [owner]: first } }))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  process.env.SESSION_KEYS_PATH = path
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  try {
    const { reserveSessionKey } = await import('../src/services/sessionKeyService.mjs?auth-test-alias-' + Date.now())
    assert.throws(() => reserveSessionKey(owner, { walletAddress: second, ownerAddress: owner }), /already bound to another MSCA/)
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
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

test('authorization validation accepts Circle zero-threshold addOwners payload', async () => {
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
  assert.equal(result.ok, true)
})

test('authorization validation rejects a threshold-changing addOwners payload', async () => {
  const { encodeFunctionData } = await import('viem')
  const { validateAuthorizationUserOperation } = await import('../src/services/sessionKeyService.mjs?auth-test-threshold-change')
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
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'delegate authorization calldata mismatch')
})
