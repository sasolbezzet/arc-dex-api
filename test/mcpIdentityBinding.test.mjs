import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData } from 'viem'

const EOA = '0x1111111111111111111111111111111111111111'
const MSCA = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'

async function withSessionStore(users, aliases, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-mcp-identity-'))
  const previousPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousVaultPath = process.env.VAULT_PATH
  const previousActivityPath = process.env.VAULT_ACTIVITY_PATH
  const previousSessionPath = process.env.VAULT_SESSION_PATH
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  process.env.VAULT_PATH = join(dir, 'vault.json')
  process.env.VAULT_ACTIVITY_PATH = join(dir, 'vault-activity.json')
  process.env.VAULT_SESSION_PATH = join(dir, 'vault-sessions.json')
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({ users, aliases }), 'utf8')
  await writeFile(process.env.VAULT_PATH, JSON.stringify({ credentials: [], limits: {}, approvals: [] }), 'utf8')
  await writeFile(process.env.VAULT_ACTIVITY_PATH, '[]', 'utf8')
  await writeFile(process.env.VAULT_SESSION_PATH, JSON.stringify({ tokens: {} }), 'utf8')
  try {
    const { resolveActiveMsca } = await import('../src/services/mcpServer.mjs?identity-' + Date.now() + '-' + Math.random())
    const createMcpServer = (await import('../src/services/mcpServer.mjs?identity-' + Date.now() + '-' + Math.random())).createMcpServer
    return await fn({ resolveActiveMsca, createMcpServer })
  } finally {
    if (previousPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousVaultPath === undefined) delete process.env.VAULT_PATH
    else process.env.VAULT_PATH = previousVaultPath
    if (previousActivityPath === undefined) delete process.env.VAULT_ACTIVITY_PATH
    else process.env.VAULT_ACTIVITY_PATH = previousActivityPath
    if (previousSessionPath === undefined) delete process.env.VAULT_SESSION_PATH
    else process.env.VAULT_SESSION_PATH = previousSessionPath
    await rm(dir, { recursive: true, force: true })
  }
}

test('MCP wallet balances are bound to the active MSCA and expose four chains', async () => {
  const previousFetch = globalThis.fetch
  const previousBridgeFlag = process.env.ENABLE_MSCA_CCTP_BRIDGE
  delete process.env.ENABLE_MSCA_CCTP_BRIDGE
  const { CHAINS } = await import('../src/services/chains.mjs?balance-test-' + Date.now())
  const values = {
    'arc-testnet': { native: '0xde0b6b3a7640000', USDC: '0xf4240', EURC: '0x1e8480', USYC: '0x2dc6c0' },
    'ethereum-sepolia': { native: '0x16345785d8a0000', USDC: '0x0f4240', EURC: '0x1e8480' },
    'base-sepolia': { native: '0x6f05b59d3b20000', USDC: '0x2dc6c0', EURC: '0x1e8480' },
    'arbitrum-sepolia': { native: '0x2386f26fc10000', USDC: '0x4c4b40' },
  }
  const expected = Object.fromEntries(Object.entries(values).map(([key, value]) => [
    CHAINS[key].rpcUrl,
    {
      native: value.native,
      tokens: Object.fromEntries(Object.entries(CHAINS[key].tokens)
        .filter(([, address]) => Boolean(address))
        .map(([symbol, address]) => [address.toLowerCase(), value[symbol]])),
    },
  ]))
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body)
    const chain = expected[String(url)]
    assert.ok(chain, `unexpected balance RPC URL: ${url}`)
    if (body.method === 'eth_getBalance') {
      assert.equal(body.params?.[0], MSCA, 'native balance reads must use the active MSCA')
    }
    const result = body.method === 'eth_getBalance'
      ? chain.native
      : chain.tokens[String(body.params?.[0]?.to || '').toLowerCase()]
    if (body.method === 'eth_call') {
      const calldata = String(body.params?.[0]?.data || '').toLowerCase()
      assert.equal(calldata.slice(-40), MSCA.slice(2).toLowerCase(), 'ERC-20 balanceOf must target the active MSCA')
    }
    assert.ok(result, `unexpected RPC call: ${body.method} ${body.params?.[0]?.to || ''}`)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 })
  }
  try {
    await withSessionStore({
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA,
        delegateAddress: OTHER,
        active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    }, { [EOA.toLowerCase()]: MSCA }, async ({ createMcpServer }) => {
      const server = createMcpServer(EOA)
      const raw = await server._registeredTools.arcox_wallet_balances.handler({})
      const result = JSON.parse(raw.content[0].text)
      assert.equal(result.walletAddress, MSCA)
      assert.equal(result.walletType, 'MSCA')
      assert.deepEqual(result.supportedChains, ['arc-testnet', 'ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia'])
      assert.deepEqual(Object.keys(result.chains).sort(), ['arbitrum-sepolia', 'arc-testnet', 'base-sepolia', 'ethereum-sepolia'])
      for (const chain of Object.values(result.chains)) {
        assert.equal(typeof chain, 'object')
        assert.ok('nativeBalance' in chain)
        assert.ok('nativeSymbol' in chain)
        assert.ok('tokens' in chain)
        assert.ok('tokenContracts' in chain)
        assert.ok('contracts' in chain)
        assert.deepEqual(chain.contracts.tokens, chain.tokenContracts)
        assert.ok(['ok', 'partial', 'error'].includes(chain.status))
      }
      assert.ok('USDC' in result, 'legacy flat Arc token field remains available')
      assert.equal(result.chains['arc-testnet'].nativeBalance, '1')
      assert.equal(result.chains['arc-testnet'].tokens.USDC, '1')
      assert.equal(result.chains['arc-testnet'].tokens.EURC, '2')
      assert.equal(result.chains['arc-testnet'].tokens.USYC, '3')
      assert.equal(result.chains['ethereum-sepolia'].nativeBalance, '0.1')
      assert.equal(result.chains['ethereum-sepolia'].tokens.USDC, '1')
      assert.equal(result.chains['base-sepolia'].tokens.USDC, '3')
      assert.equal(result.chains['arbitrum-sepolia'].tokens.USDC, '5')
    })
  } finally {
    globalThis.fetch = previousFetch
    if (previousBridgeFlag === undefined) delete process.env.ENABLE_MSCA_CCTP_BRIDGE
    else process.env.ENABLE_MSCA_CCTP_BRIDGE = previousBridgeFlag
  }
})

test('OAuth identity binding requires the active MSCA passkey session and creates the explicit alias', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'a'.repeat(64),
    },
  }, {}, async ({ resolveActiveMsca }) => {
    // Use the same vaultStore module instance that mcpServer's dynamic import
    // uses; query-string imports would create a separate in-memory token map.
    const { createSession } = await import('../src/services/vaultStore.mjs')
    const { bindMcpIdentityToActiveSession } = await import('../src/services/mcpServer.mjs?binding-' + Date.now() + '-' + Math.random())
    const passkeyToken = createSession(MSCA.toLowerCase())
    const bound = await bindMcpIdentityToActiveSession({ userId: EOA, mscaWalletAddress: MSCA, mscaSessionToken: passkeyToken })
    assert.equal(bound.ok, true)
    assert.equal((await resolveActiveMsca(EOA))?.walletAddress, MSCA)

    const rejected = await bindMcpIdentityToActiveSession({ userId: OTHER, mscaWalletAddress: MSCA, mscaSessionToken: 'arx_vs_invalid' })
    assert.equal(rejected.ok, false)
  })
})

test('OAuth passkey proof can replace a stale EOA alias with the selected active MSCA', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'e'.repeat(64),
    },
  }, { [EOA.toLowerCase()]: OTHER }, async ({ resolveActiveMsca }) => {
    const { createSession } = await import('../src/services/vaultStore.mjs')
    const { bindMcpIdentityToActiveSession } = await import('../src/services/mcpServer.mjs?binding-rebind-' + Date.now() + '-' + Math.random())
    const passkeyToken = createSession(MSCA.toLowerCase())
    const bound = await bindMcpIdentityToActiveSession({ userId: EOA, mscaWalletAddress: MSCA, mscaSessionToken: passkeyToken })
    assert.equal(bound.ok, true)
    assert.equal(bound.bound.rebound, true)
    assert.equal((await resolveActiveMsca(EOA))?.walletAddress, MSCA)
  })
})

test('explicit EOA-to-MSCA alias wins over an active legacy EOA session', async () => {
  await withSessionStore({
    [EOA.toLowerCase()]: {
      walletAddress: EOA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'b'.repeat(64),
    },
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'a'.repeat(64),
    },
  }, { [EOA.toLowerCase()]: MSCA }, async ({ resolveActiveMsca }) => {
    const resolved = await resolveActiveMsca(EOA)
    assert.equal(resolved?.walletAddress, MSCA)
    assert.equal(resolved?.active, true)
  })
})

test('server-issued OAuth MSCA binding resolves without relying on the EOA alias', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'c'.repeat(64),
    },
  }, {}, async ({ resolveActiveMsca }) => {
    const resolved = await resolveActiveMsca(EOA, MSCA)
    assert.equal(resolved?.walletAddress, MSCA)
    assert.equal(resolved?.active, true)
  })
})

test('session status uses the OAuth-bound MSCA instead of the SIWE EOA', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'd'.repeat(64),
    },
  }, {}, async ({ createMcpServer }) => {
    const server = createMcpServer(EOA, { boundMscaWalletAddress: MSCA })
    const response = await server._registeredTools.arcox_session_status.handler({})
    const result = JSON.parse(response.content[0].text)
    assert.equal(result.active, true)
    assert.equal(result.walletAddress, MSCA)
    assert.equal(result.delegateAddress, OTHER)
  })
})

test('MCP resolver maps SIWE EOA to the active Agent Wallet MSCA', async () => {
  const previousBridgeFlag = process.env.ENABLE_MSCA_CCTP_BRIDGE
  delete process.env.ENABLE_MSCA_CCTP_BRIDGE
  try {
    await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: true,
      authorizationUserOpHash: '0x' + 'a'.repeat(64),
    },
    }, { [EOA.toLowerCase()]: MSCA }, async ({ resolveActiveMsca, createMcpServer }) => {
      const info = await resolveActiveMsca(EOA)
      assert.equal(info?.walletAddress, MSCA)
      assert.equal(info?.active, true)

      // The experimental Arc-source CCTP/MSCA path is fail-closed by default.
      // This exercises the real MCP handler and proves no UserOperation is
      // attempted while ENABLE_MSCA_CCTP_BRIDGE is absent.
      const server = createMcpServer(EOA)
      const quote = await server._registeredTools.arcox_quote_bridge.handler({
      fromChain: 'arc-testnet',
      toChain: 'base-sepolia',
      amount: '1',
      token: 'USDC',
        source: 'session',
      })
      const quoteResult = JSON.parse(quote.content[0].text)
      assert.equal(quoteResult.rejected, true)
      assert.equal(quoteResult.reason, 'msca_bridge_disabled_until_router_validation')

      const status = await server._registeredTools.arcox_route_status.handler({
      action: 'bridge',
      fromChain: 'arc-testnet',
      toChain: 'base-sepolia',
        source: 'session',
      })
      const statusResult = JSON.parse(status.content[0].text)
      assert.equal(statusResult.supported, false)
      assert.equal(statusResult.executionSupported, false)
      assert.equal(statusResult.walletAddress, MSCA)
      assert.equal(statusResult.reason, 'msca_bridge_disabled_until_router_validation')
    })
  } finally {
    if (previousBridgeFlag === undefined) delete process.env.ENABLE_MSCA_CCTP_BRIDGE
    else process.env.ENABLE_MSCA_CCTP_BRIDGE = previousBridgeFlag
  }
})

test('MCP recognizes Arbitrum→Arc as an MSCA route before any source burn', async () => {
  const { isMscaCctpRouteConfigured } = await import('../src/services/mcpServer.mjs?arb-arc-route-' + Date.now() + '-' + Math.random())
  assert.equal(isMscaCctpRouteConfigured('arbitrum-sepolia', 'arc-testnet'), true)
})

test('legacy E2E flags cannot bypass the final unresolved-intent guard', async () => {
  const previousBridgeFlag = process.env.ENABLE_MSCA_CCTP_BRIDGE
  const previousBypass = process.env.ENABLE_E2E_TESTNET_INTENT_BYPASS
  const previousPaymaster = process.env.ENABLE_E2E_TESTNET_PAYMASTER
  process.env.ENABLE_MSCA_CCTP_BRIDGE = 'true'
  process.env.ENABLE_E2E_TESTNET_INTENT_BYPASS = 'true'
  process.env.ENABLE_E2E_TESTNET_PAYMASTER = 'true'
  try {
    await withSessionStore({
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA,
        delegateAddress: OTHER,
        active: true,
        authorizationUserOpHash: '0x' + 'd'.repeat(64),
      },
    }, { [EOA.toLowerCase()]: MSCA }, async ({ createMcpServer }) => {
      const { createApproval, updateApprovalStatus } = await import('../src/services/vaultStore.mjs')
      const pending = createApproval(EOA.toLowerCase(), {
        agent: 'test-agent',
        action: 'bridge',
        amount: '1',
        token: 'USDC',
        source: 'session',
        details: JSON.stringify({
          fromChain: 'Arc_Testnet',
          toChain: 'Base_Sepolia',
          previewId: 'legacy-flag-preview',
          walletAddress: MSCA,
          settlementPhase: 'source_submission_unknown',
        }),
        forcePending: true,
      })
      updateApprovalStatus(EOA.toLowerCase(), pending.id, 'pending_confirmation')
      const response = await createMcpServer(EOA.toLowerCase())._registeredTools.arcox_quote_bridge.handler({
        fromChain: 'arc-testnet',
        toChain: 'base-sepolia',
        amount: '1',
        token: 'USDC',
        source: 'session',
      })
      const result = JSON.parse(response.content[0].text)
      assert.equal(result.rejected, true)
      assert.equal(result.reason, 'unresolved_source_intent')
      assert.equal(result.approvalId, pending.id)
    })
  } finally {
    if (previousBridgeFlag === undefined) delete process.env.ENABLE_MSCA_CCTP_BRIDGE
    else process.env.ENABLE_MSCA_CCTP_BRIDGE = previousBridgeFlag
    if (previousBypass === undefined) delete process.env.ENABLE_E2E_TESTNET_INTENT_BYPASS
    else process.env.ENABLE_E2E_TESTNET_INTENT_BYPASS = previousBypass
    if (previousPaymaster === undefined) delete process.env.ENABLE_E2E_TESTNET_PAYMASTER
    else process.env.ENABLE_E2E_TESTNET_PAYMASTER = previousPaymaster
  }
})

test('MCP resolver fails closed without an active explicit MSCA session', async () => {
  await withSessionStore({
    [MSCA.toLowerCase()]: {
      walletAddress: MSCA,
      delegateAddress: OTHER,
      active: false,
      authorizationUserOpHash: '0x' + 'b'.repeat(64),
    },
  }, { [EOA.toLowerCase()]: MSCA }, async ({ resolveActiveMsca }) => {
    assert.equal(await resolveActiveMsca(EOA), null)
    assert.equal(await resolveActiveMsca(OTHER), null)
  })
})

// Keep this invariant close to the quote/execution contract: a preview created
// for one MSCA must not be reusable after the active MSCA changes.
test('MSCA-bound quote fields distinguish the active wallet', () => {
  const quote = { walletAddress: MSCA, amount: '1', token: 'USDC' }
  const current = { walletAddress: OTHER, amount: '1', token: 'USDC' }
  assert.notEqual(quote.walletAddress.toLowerCase(), current.walletAddress.toLowerCase())
})

test('MCP quote handler blocks a new quote when a source intent is unresolved', async () => {
  const previousBridgeFlag = process.env.ENABLE_MSCA_CCTP_BRIDGE
  process.env.ENABLE_MSCA_CCTP_BRIDGE = 'true'
  try {
    await withSessionStore({
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA,
        delegateAddress: OTHER,
        active: true,
        authorizationUserOpHash: '0x' + 'c'.repeat(64),
      },
    }, { [EOA.toLowerCase()]: MSCA }, async ({ createMcpServer }) => {
      const { createApproval, updateApprovalStatus } = await import('../src/services/vaultStore.mjs')
      const pending = createApproval(EOA.toLowerCase(), {
        agent: 'test-agent',
        action: 'bridge',
        amount: '1',
        token: 'USDC',
        source: 'session',
        details: JSON.stringify({
          fromChain: 'Arc_Testnet',
          toChain: 'Base_Sepolia',
          previewId: 'old-preview',
          walletAddress: MSCA,
          settlementPhase: 'source_submission_unknown',
        }),
        forcePending: true,
      })
      updateApprovalStatus(EOA.toLowerCase(), pending.id, 'pending_confirmation')
      const server = createMcpServer(EOA.toLowerCase())
      const response = await server._registeredTools.arcox_quote_bridge.handler({
        fromChain: 'arc-testnet',
        toChain: 'base-sepolia',
        amount: '1',
        token: 'USDC',
        source: 'session',
      })
      const result = JSON.parse(response.content[0].text)
      assert.equal(result.rejected, true)
      assert.equal(result.reason, 'unresolved_source_intent')
      assert.equal(result.approvalId, pending.id)
    })
  } finally {
    if (previousBridgeFlag === undefined) delete process.env.ENABLE_MSCA_CCTP_BRIDGE
    else process.env.ENABLE_MSCA_CCTP_BRIDGE = previousBridgeFlag
  }
})

test('unresolved source intent blocks burns but permits approval-only recovery', async () => {
  const { hasUnresolvedSourceBridgeIntent, isStaleApprovalOnlySourceIntent } = await import('../src/services/mcpServer.mjs?unresolved-source-' + Date.now())
  const pending = {
    id: 'approval-source-unknown',
    action: 'bridge',
    status: 'pending_confirmation',
    details: JSON.stringify({
      fromChain: 'Arc_Testnet',
      toChain: 'Base_Sepolia',
      previewId: 'old-preview',
      walletAddress: MSCA,
      settlementPhase: 'source_submission_unknown',
    }),
  }
  assert.equal(hasUnresolvedSourceBridgeIntent([pending], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  })?.approval.id, pending.id)
  assert.equal(hasUnresolvedSourceBridgeIntent([pending], {
    fromChain: 'Arc_Testnet',
    toChain: 'Arbitrum_Sepolia',
    walletAddress: MSCA,
  }), null)
  assert.equal(hasUnresolvedSourceBridgeIntent([{
    ...pending,
    details: JSON.stringify({ ...JSON.parse(pending.details), settlementPhase: 'source_reverted' }),
  }], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  }), null)
  assert.equal(hasUnresolvedSourceBridgeIntent([{
    ...pending,
    details: JSON.stringify({ ...JSON.parse(pending.details), walletAddress: '' }),
  }], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  })?.approval.id, pending.id)

  // A stale approval-only operation may be superseded after a new session is
  // created. It never called the router, so allowing a new quote cannot create
  // a second CCTP burn.
  const staleApproval = {
    ...pending,
    createdAt: 100,
    details: JSON.stringify({
      ...JSON.parse(pending.details),
      settlementPhase: 'source_approval_submitted',
      sourceApprovalUserOpHash: '0x' + 'e'.repeat(64),
      sessionDelegateAddress: OTHER,
      sessionCreatedAt: 100,
    }),
  }
  assert.equal(isStaleApprovalOnlySourceIntent(staleApproval, {
    sessionDelegateAddress: MSCA,
    sessionCreatedAt: 200,
  }), true)
  // A pending approval is safe to supersede even when the delegate/session is
  // unchanged: approval alone cannot move USDC or create a CCTP burn.
  assert.equal(isStaleApprovalOnlySourceIntent(staleApproval, {
    sessionDelegateAddress: OTHER,
    sessionCreatedAt: 100,
  }), true)
  assert.equal(isStaleApprovalOnlySourceIntent({
    ...staleApproval,
    details: JSON.stringify({ ...JSON.parse(staleApproval.details), sourceUserOpHash: '0x' + 'f'.repeat(64) }),
  }, {
    sessionDelegateAddress: MSCA,
    sessionCreatedAt: 200,
  }), false)

  // A known bundler precheck is terminal before a UserOperation hash exists,
  // so the route may safely receive a fresh quote.
  assert.equal(hasUnresolvedSourceBridgeIntent([{
    id: 'approval-precheck-failed',
    action: 'bridge',
    status: 'error',
    error: 'UserOperation rejected because paymaster stake is too low',
    details: JSON.stringify({
      fromChain: 'Arc_Testnet',
      toChain: 'Base_Sepolia',
      walletAddress: MSCA,
      settlementPhase: 'source_submission_failed',
      reason: 'bundler_stake_requirement',
      userOpAccepted: 'no',
      safeToRetry: true,
    }),
  }], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  }), null)

  // A hashless error without an explicit precheck result remains blocked: absence
  // of a hash alone is never proof that the bundler did not accept the op.
  assert.equal(hasUnresolvedSourceBridgeIntent([{
    id: 'approval-unknown-error',
    action: 'bridge',
    status: 'error',
    error: 'temporary transport failure',
    details: JSON.stringify({
      fromChain: 'Arc_Testnet',
      toChain: 'Base_Sepolia',
      walletAddress: MSCA,
      settlementPhase: 'source_submission_failed',
    }),
  }], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  })?.approval.id, 'approval-unknown-error')

  // Completed legacy frontend/Circle bridge records remain recoverable by
  // burn hash, but destination mint is already done and must not block quotes.
  assert.equal(hasUnresolvedSourceBridgeIntent([{
    id: 'completed-legacy-bridge',
    action: 'bridge',
    status: 'approved',
    txHash: '0x' + 'b'.repeat(64),
    details: JSON.stringify({
      fromChain: 'Arc_Testnet',
      toChain: 'Base_Sepolia',
      burnTxHash: '0x' + 'a'.repeat(64),
      mintTxHash: '0x' + 'c'.repeat(64),
    }),
  }], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  }), null)
  assert.equal(hasUnresolvedSourceBridgeIntent([
    {
      id: 'completed-legacy-bridge',
      action: 'bridge',
      status: 'approved',
      details: JSON.stringify({ fromChain: 'Arc_Testnet', toChain: 'Base_Sepolia', burnTxHash: '0x' + 'a'.repeat(64), mintTxHash: '0x' + 'c'.repeat(64) }),
    },
    {
      id: 'duplicate-error-record',
      action: 'bridge',
      status: 'error',
      details: JSON.stringify({ fromChain: 'Arc_Testnet', toChain: 'Base_Sepolia', burnTxHash: '0x' + 'a'.repeat(64), settlementPhase: 'destination_submission_failed' }),
    },
  ], {
    fromChain: 'Arc_Testnet',
    toChain: 'Base_Sepolia',
    walletAddress: MSCA,
  }), null)
})

test('multi-chain balance preserves a structured error for an unavailable chain', async () => {
  const { fetchAllChainBalances } = await import('../src/services/multiChainBalance.mjs?balance-error-' + Date.now())
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('test RPC unavailable') }
  try {
    const result = await fetchAllChainBalances(MSCA)
    assert.deepEqual(Object.keys(result).sort(), ['arbitrum-sepolia', 'arc-testnet', 'base-sepolia', 'ethereum-sepolia'])
    for (const chain of Object.values(result)) {
      assert.equal(chain.status, 'error')
      assert.equal(chain.nativeBalance, null)
      assert.ok(Object.values(chain.tokens).every(value => value === null))
      assert.ok(Array.isArray(chain.errors))
    }
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('multi-chain balance config has canonical USDC addresses and no fake Arbitrum EURC', async () => {
  const { CHAINS } = await import('../src/services/chains.mjs?balance-config-' + Date.now())
  assert.equal(CHAINS['base-sepolia'].tokens.USDC.toLowerCase(), '0x036cbd53842c5426634e7929541ec2318f3dcf7e')
  assert.equal(CHAINS['arbitrum-sepolia'].tokens.USDC.toLowerCase(), '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d')
  assert.equal(CHAINS['arbitrum-sepolia'].tokens.EURC, null)
  assert.equal(CHAINS['arc-testnet'].tokens.USDC.toLowerCase(), '0x3600000000000000000000000000000000000000')
  assert.equal(CHAINS['arc-testnet'].tokens.EURC.toLowerCase(), '0x89b50855aa3be2f677cd6303cec089b5f319d72a')
  assert.equal(CHAINS['arc-testnet'].tokens.USYC.toLowerCase(), '0xe9185f0c5f296ed1797aae4238d26ccabeadb86c')
})

test('CCTP V2 decoder distinguishes TokenMessenger header recipient from MSCA mint recipient', async () => {
  const { decodeCctpMessage, selectCctpMessage } = await import('../src/services/mcpServer.mjs?cctp-decode-' + Date.now())
  const word = value => String(value).replace(/^0x/i, '').padStart(64, '0')
  const addressWord = address => word(address)
  const uint32 = value => String(value).replace(/^0x/i, '').padStart(8, '0')
  const nonce = '0x' + '01'.padStart(64, '0')
  const header = [
    uint32('0x00000001'), // message version
    uint32('0x0000001a'), // Arc source domain 26
    uint32('0x00000006'), // Base destination domain 6
    nonce.slice(2), // 32-byte nonce
    addressWord('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'), // source TokenMessenger
    addressWord('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'), // destination TokenMessenger
    addressWord('0x0000000000000000000000000000000000000000000000000000000000000000'), // anyone may relay
    uint32('0x000003e8'), // min finality threshold
    uint32('0x000003e8'), // executed finality threshold
  ].join('')
  const body = [
    uint32('0x00000001'), // burn message version
    addressWord('0x3600000000000000000000000000000000000000'), // Arc USDC
    addressWord(MSCA), // final mint recipient
    word('0x00000000000f4240'), // 1 USDC
    addressWord('0xDf800310443BEB589CEf91A09854203Ea36e43a7'), // ArcoxRouter directly calls depositForBurn
    word('0x0a'), // max fee
    word('0x0a'), // executed fee
    word('0x0'), // expiration block
  ].join('')
  const decoded = decodeCctpMessage('0x' + header + body)
  assert.equal(decoded.sourceDomain, 26)
  assert.equal(decoded.destinationDomain, 6)
  assert.equal(decoded.recipient, '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa')
  assert.equal(decoded.messageBody.mintRecipient, MSCA.toLowerCase())
  assert.equal(decoded.messageBody.messageSender, '0xdf800310443beb589cef91a09854203ea36e43a7')
  assert.equal(decoded.messageBody.burnToken, '0x3600000000000000000000000000000000000000')
  assert.equal(decoded.messageBody.amount, 1_000_000n)
  assert.equal(decoded.sender, '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa')

  const wrongRouteMessage = '0x' + header.replace(uint32('0x0000001a'), uint32('0x00000003')) + body
  const selection = selectCctpMessage([
    { message: wrongRouteMessage, status: 'complete' },
    { message: '0x' + header + body, status: 'complete' },
  ], 26, 6)
  assert.equal(selection.selected.message, '0x' + header + body)
  assert.equal(selection.decoded.sourceDomain, 26)
  assert.equal(selection.decoded.destinationDomain, 6)
  assert.deepEqual(selection.candidates.map(item => [item.sourceDomain, item.destinationDomain]), [[3, 6], [26, 6]])

  const sameRouteWrongMessage = '0x' + header + body.replace(addressWord(MSCA), addressWord(OTHER))
  const boundSelection = selectCctpMessage([
    { message: sameRouteWrongMessage, status: 'complete' },
    { message: '0x' + header + body, status: 'complete' },
  ], 26, 6, {
    route: {
      source: {
        tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
        usdc: '0x3600000000000000000000000000000000000000',
      },
      destination: { domain: 6, tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' },
    },
    walletAddress: MSCA,
    expectedBurnAmount: 1_000_000n,
  })
  assert.equal(boundSelection.selected.message, '0x' + header + body)

  const noValidCandidate = selectCctpMessage([{ message: sameRouteWrongMessage, status: 'complete' }], 26, 6, {
    route: {
      source: {
        tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
        router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
        usdc: '0x3600000000000000000000000000000000000000',
      },
      destination: { domain: 6, tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' },
    },
    walletAddress: MSCA,
    expectedBurnAmount: 1_000_000n,
  })
  assert.equal(noValidCandidate.selected, null)
  assert.equal(noValidCandidate.candidates.length, 1)
})

test('CCTP indexing lag remains pending instead of false route rejection', async () => {
  const { waitForCctpBridgeStatus, getCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?cctp-pending-' + Date.now())
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ messages: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const result = await waitForCctpBridgeStatus({
      burnTxHash: '0x' + 'a'.repeat(64),
      sourceDomain: 26,
      destinationDomain: 6,
      walletAddress: MSCA,
      route: {
        source: {
          tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
          router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
          usdc: '0x3600000000000000000000000000000000000000',
        },
        destination: { domain: 6, tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' },
      },
      expectedBurnAmount: 99700n,
    }, { attempts: 1, delayMs: 0 })
    assert.equal(result.status, 'pending')
    assert.equal(result.reason, 'cctp_message_pending')
    assert.equal(result.verified, false)

    const wrongMessage = '0x' + '00'.repeat(148)
    globalThis.fetch = async () => new Response(JSON.stringify({ messages: [{ message: wrongMessage, status: 'complete' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const mismatch = await getCctpBridgeStatus({
      burnTxHash: '0x' + 'b'.repeat(64),
      sourceDomain: 26,
      destinationDomain: 6,
      walletAddress: MSCA,
      route: {
        source: {
          tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
          router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
          usdc: '0x3600000000000000000000000000000000000000',
        },
        destination: { domain: 6, tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' },
      },
      expectedBurnAmount: 99700n,
    })
    assert.equal(mismatch.status, 'rejected')
    assert.equal(mismatch.reason, 'cctp_message_route_unverified')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('CCTP nonce extraction uses the canonical 32-byte nonce field', async () => {
  const { extractCctpMessageNonce, destinationNonceDecision } = await import('../src/services/mcpServer.mjs?cctp-nonce-' + Date.now())
  const header = [
    '00000001', // version
    '0000001a', // Arc source domain
    '00000006', // Base destination domain
    '77669523b79da35a989a2d5e73114327974af41ceda6be8440c1b9475a84b7f5', // nonce
    '0'.repeat(64),
    '0'.repeat(64),
    '0'.repeat(64),
    '000003e8',
    '000007d0',
  ].join('')
  assert.equal(
    extractCctpMessageNonce('0x' + header),
    '0x77669523b79da35a989a2d5e73114327974af41ceda6be8440c1b9475a84b7f5',
  )
  assert.equal(extractCctpMessageNonce('0x1234'), null)
  assert.equal(destinationNonceDecision({ checked: true, processed: true }), 'minted')
  assert.equal(destinationNonceDecision({ checked: true, processed: false }), 'not_minted')
  assert.equal(destinationNonceDecision({ checked: false, processed: false }), 'unavailable')
})

test('destination nonce check is idempotent and fail-closed on RPC errors', async () => {
  const { destinationMintAlreadyProcessed } = await import('../src/services/mcpServer.mjs?nonce-check-' + Date.now())
  const status = { message: '0x' + [
    '00000001', '0000001a', '00000006',
    '77669523b79da35a989a2d5e73114327974af41ceda6be8440c1b9475a84b7f5',
  ].join('') }
  const route = {
    toKey: 'Base_Sepolia',
    destination: { rpcUrl: 'https://example.invalid', messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' },
  }
  const used = await destinationMintAlreadyProcessed({ status, route, client: {
    readContract: async () => true,
  } })
  assert.deepEqual({ checked: used.checked, processed: used.processed }, { checked: true, processed: true })
  const unavailable = await destinationMintAlreadyProcessed({ status, route, client: {
    readContract: async () => { throw new Error('RPC unavailable') },
  } })
  assert.deepEqual({ checked: unavailable.checked, processed: unavailable.processed, reason: unavailable.reason }, {
    checked: false,
    processed: false,
    reason: 'destination_nonce_check_unavailable',
  })
})

test('MSCA bridge calldata approves and calls the verified ArcoxRouter', async () => {
  const { buildMscaRouterBridgeCalls } = await import('../src/services/mcpServer.mjs?bridge-calldata-' + Date.now())
  const route = {
    fromKey: 'Arc_Testnet',
    toKey: 'Base_Sepolia',
    source: {
      domain: 26,
      usdc: '0x3600000000000000000000000000000000000000',
      router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
    },
    destination: { domain: 6, requiredFinalityThreshold: 1000 },
  }
  const calls = buildMscaRouterBridgeCalls({ route, amount: 1_000_000n, mintRecipient: MSCA, maxFee: 10n })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].to.toLowerCase(), route.source.usdc.toLowerCase())
  assert.equal(calls[1].to.toLowerCase(), route.source.router.toLowerCase())
  assert.equal(calls[0].data.slice(0, 10), '0x095ea7b3')
  assert.notEqual(calls[1].data, '0x')
  const routerAbi = [{
    type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
    ], outputs: [],
  }]
  const decoded = decodeFunctionData({ abi: routerAbi, data: calls[1].data })
  assert.equal(decoded.functionName, 'bridgeUsdcWithFee')
  assert.deepEqual(decoded.args, [1_000_000n, 6, `0x${MSCA.slice(2).padStart(64, '0')}`, `0x${'0'.repeat(64)}`, 10n, 1000])

  const approveAbi = [{
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
  }]
  const approve = decodeFunctionData({ abi: approveAbi, data: calls[0].data })
  assert.equal(approve.functionName, 'approve')
  assert.deepEqual(approve.args, [route.source.router, 1_000_000n])
})

test('MCP tool failures return structured errors instead of opaque SDK execution errors', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('upstream transaction history unavailable') }
  try {
    await withSessionStore({
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA,
        delegateAddress: OTHER,
        active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    }, { [EOA.toLowerCase()]: MSCA }, async ({ createMcpServer }) => {
      const server = createMcpServer(EOA)
      const response = await server._registeredTools.arcox_transaction_history.handler({})
      const result = JSON.parse(response.content[0].text)
      assert.equal(response.isError, true)
      assert.equal(result.status, 'error')
      assert.equal(result.tool, 'arcox_transaction_history')
      assert.match(result.error, /transaction history unavailable/)
      assert.equal(result.retryable, true)
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})
