// On-chain Agentic Jobs MCP tools (ERC-8004 identity + ERC-8183 commerce via
// ARC Memo), executed by the Agent Wallet MSCA session key. Ported from the
// frontend Agentic panel. Split out of mcpServer.mjs for maintainability.
import { getAddress } from 'viem'

/**
 * @param {object} ctx
 * @param {Function} ctx.registerTool      registerTool(name, desc, schema, handler) with error boundary
 * @param {Function} ctx.jsonText          JSON.stringify helper
 * @param {Function} ctx.mscaRequiredResult helper for "session required" responses
 * @param {object}   ctx.z                 zod (or compatible) for schemas
 * @param {Function} ctx.resolveMsca       () => resolveActiveMsca(userId, boundMscaWalletAddress)
 * @param {Function} ctx.mintOwnerToken    () => owner bearer token for the current userId
 * @param {string}   ctx.backendUrl        backend base URL
 */
export function registerAgenticTools(ctx) {
  const { registerTool, jsonText, mscaRequiredResult, z, resolveMsca, mintOwnerToken, backendUrl } = ctx

  const agenticResolveAgentId = async (paramsAgentId) => {
    if (paramsAgentId) return String(paramsAgentId).trim()
    try {
      const info = await resolveMsca()
      if (!info) return ''
      const { getActiveAgentId } = await import('../aiRouterStore.mjs')
      return String(getActiveAgentId(info.walletAddress) || '')
    } catch {
      return ''
    }
  }
  const agenticConfirm = (params, action) => {
    if (!params.confirmed) {
      return { status: 'preview', action, requiresUserConfirmation: true, safeNextStep: `Tampilkan preview ini ke user. Setelah user bilang yes/ya, panggil tool dengan confirmed=true dan confirmationText.` }
    }
    const text = String(params.confirmationText || '').trim().toLowerCase()
    if (text !== 'yes' && text !== 'ya') {
      return { status: 'confirmation_required', reason: 'Konfirmasi eksplisit (ya/yes) wajib sebelum eksekusi.' }
    }
    return null
  }
  // The ARC Memo contract is EOA-only (callFrom requires tx.origin == msg.sender),
  // so every job mutation is signed by the session delegate EOA, auto-funded
  // from the Agent Wallet MSCA. fund_job additionally moves USDC: top-up the
  // delegate → approve commerce → memo fund.
  const agenticExec = async (params, { action, calls, buildResult, fund = false, agentId = '' }) => {
    const blocked = agenticConfirm(params, action)
    if (blocked) return { content: [{ type: 'text', text: jsonText(blocked) }] }
    try {
      const info = await resolveMsca()
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const svc = await import('../agenticJobsService.mjs')
      const result = fund
        ? await svc.executeFundViaDelegate(info.walletAddress, { agentId, jobId: params.jobId, amount: params.amount })
        : await svc.executeMemoViaDelegate(info.walletAddress, calls[0])
      return { content: [{ type: 'text', text: jsonText({ status: 'success', executed: true, txHash: result.txHash, explorerUrl: result.explorerUrl, delegateAddress: result.delegateAddress, ...(result.approveTxHash ? { approveTxHash: result.approveTxHash, approveExplorerUrl: result.approveExplorerUrl } : {}), ...(await buildResult(result)) }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', executed: false, error: e?.message || 'agentic job execution failed' }) }] }
    }
  }

  registerTool('arcox_agentic_register_agent', 'Register the Agent Wallet as an on-chain Agent Identity (ERC-8004 SBT) for Agent Jobs. Returns the minted agentId. Requires confirmation.', {
    metadataUri: z.string().describe('Identity metadata URI (ipfs://...) stored on-chain'),
    confirmed: z.boolean().optional().describe('Must be true to execute'),
    confirmationText: z.string().optional(),
  }, async (params) => {
    const blocked = agenticConfirm(params, 'register_agent_identity')
    if (blocked) return { content: [{ type: 'text', text: jsonText(blocked) }] }
    try {
      const info = await resolveMsca()
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const { registerAgentCall, parseAgentIdFromLogs } = await import('../agenticJobsService.mjs')
      const { executeViaSession } = await import('../sessionKeyService.mjs')
      const result = await executeViaSession(info.walletAddress, [registerAgentCall(params.metadataUri)], { paymaster: true, chainKey: 'arc-testnet', feeProfile: 'arc-pay', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true })
      if (result.status !== 'success') {
        return { content: [{ type: 'text', text: jsonText({ status: result.status, executed: false, reason: result.reason || 'register failed', error: result.error, txHash: result.txHash }) }] }
      }
      const agentId = parseAgentIdFromLogs(result.receipt?.logs, info.walletAddress)
      return { content: [{ type: 'text', text: jsonText({ status: 'success', executed: true, agentId, walletAddress: info.walletAddress, txHash: result.txHash, explorerUrl: result.explorerUrl, safeNextStep: `Agent identity #${agentId} terdaftar. Gunakan agentId ini untuk arcox_agentic_create_job.` }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', executed: false, error: e?.message || 'register agent failed' }) }] }
    }
  })

  registerTool('arcox_agentic_get_agent', 'Read an on-chain Agent Identity (owner + metadataURI) from the ERC-8004 registry.', {
    agentId: z.string().describe('Agent Identity id (SBT token id)'),
  }, async (params) => {
    try {
      const { getAgentIdentity } = await import('../agentIdentityService.mjs')
      const identity = await getAgentIdentity(params.agentId)
      return { content: [{ type: 'text', text: jsonText({ status: 'ok', identity }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', error: e?.message || 'read agent failed' }) }] }
    }
  })

  registerTool('arcox_agentic_create_job', 'Create an on-chain ERC-8183 Agent Job via ARC Memo from the Agent Wallet MSCA. Requires provider, evaluator, description. Returns jobId. Requires confirmation.', {
    provider: z.string().describe('Provider address (0x...)'),
    evaluator: z.string().describe('Evaluator address (0x...)'),
    description: z.string().describe('Job description'),
    expiresInHours: z.number().optional().describe('Default 24'),
    agentId: z.string().optional().describe('On-chain Agent Identity id; falls back to the active identity'),
    confirmed: z.boolean().optional(),
    confirmationText: z.string().optional(),
  }, async (params) => {
    const blocked = agenticConfirm(params, 'create_agentic_job')
    if (blocked) return { content: [{ type: 'text', text: jsonText(blocked) }] }
    try {
      const agentId = await agenticResolveAgentId(params.agentId)
      if (!/^\d+$/.test(agentId)) return { content: [{ type: 'text', text: jsonText({ status: 'agent_identity_required', reason: 'Daftarkan Agent Identity dulu via arcox_agentic_register_agent (atau pilih via select_agent_identity).' }) }] }
      const info = await resolveMsca()
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const { createJobCall, parseJobIdFromLogs, executeMemoViaDelegate, resolveDelegateAddress } = await import('../agenticJobsService.mjs')
      // The ARC Memo contract is EOA-only, so the job client is the session
      // delegate EOA. setBudget/submit require msg.sender == provider and
      // complete requires msg.sender == evaluator — all memo calls come from
      // the delegate, so provider/evaluator must be the delegate too unless the
      // user explicitly names other addresses (which then must be EOAs the
      // delegate can impersonate — i.e. the delegate itself in practice).
      const delegate = getAddress(info.delegateAddress || resolveDelegateAddress(info.walletAddress))
      const provider = params.provider ? getAddress(params.provider) : delegate
      const evaluator = params.evaluator ? getAddress(params.evaluator) : delegate
      const referenceId = (await import('crypto')).randomUUID()
      const result = await executeMemoViaDelegate(info.walletAddress, createJobCall({ agentId, referenceId, provider, evaluator, description: params.description, expiresInHours: params.expiresInHours }))
      const jobId = parseJobIdFromLogs(result.receipt?.logs)
      return { content: [{ type: 'text', text: jsonText({ status: 'success', executed: true, jobId, agentId, txHash: result.txHash, explorerUrl: result.explorerUrl, delegateAddress: result.delegateAddress, safeNextStep: `Job #${jobId} dibuat. Baca dengan arcox_agentic_get_job, set budget via arcox_agentic_set_budget, lalu fund escrow via arcox_agentic_fund_job.` }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', executed: false, error: e?.message || 'create job failed' }) }] }
    }
  })

  registerTool('arcox_agentic_get_job', 'Read an on-chain ERC-8183 Agent Job (status, budget, client, provider, evaluator, description).', {
    jobId: z.string().describe('Job id'),
  }, async (params) => {
    try {
      const { readAgenticJob } = await import('../agenticJobsService.mjs')
      const job = await readAgenticJob(params.jobId)
      return { content: [{ type: 'text', text: jsonText({ status: 'ok', job }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', error: e?.message || 'read job failed' }) }] }
    }
  })

  registerTool('arcox_agentic_set_budget', 'Set the budget of an on-chain ERC-8183 job (USDC). Requires confirmation.', {
    jobId: z.string().describe('Job id'),
    amount: z.string().describe('Budget in USDC (e.g. 1 for 1 USDC)'),
    agentId: z.string().optional(),
    confirmed: z.boolean().optional(),
    confirmationText: z.string().optional(),
  }, async (params) => {
    const agentId = await agenticResolveAgentId(params.agentId)
    if (!/^\d+$/.test(agentId)) return { content: [{ type: 'text', text: jsonText({ status: 'agent_identity_required' }) }] }
    return agenticExec(params, {
      action: `set_budget job #${params.jobId} ${params.amount} USDC`,
      calls: [(await import('../agenticJobsService.mjs')).setBudgetCall({ agentId, jobId: params.jobId, amount: params.amount })],
      buildResult: async () => ({ jobId: params.jobId, agentId, amount: params.amount, note: 'Budget diset. Lanjutkan dengan arcox_agentic_fund_job untuk mengisi escrow.' }),
    })
  })

  registerTool('arcox_agentic_fund_job', 'Approve USDC and fund the ERC-8183 job escrow in a single UserOp (moves real USDC from the Agent Wallet). Requires confirmation.', {
    jobId: z.string().describe('Job id'),
    amount: z.string().describe('Amount in USDC to fund escrow'),
    agentId: z.string().optional(),
    confirmed: z.boolean().optional(),
    confirmationText: z.string().optional(),
  }, async (params) => {
    const agentId = await agenticResolveAgentId(params.agentId)
    if (!/^\d+$/.test(agentId)) return { content: [{ type: 'text', text: jsonText({ status: 'agent_identity_required' }) }] }
    return agenticExec(params, {
      action: `fund_job #${params.jobId} ${params.amount} USDC (approve + fund escrow)`,
      calls: [],
      fund: true,
      agentId,
      buildResult: async () => ({ jobId: params.jobId, agentId, amount: params.amount, note: 'Escrow terisi. Provider bisa submit deliverable via arcox_agentic_submit_deliverable.' }),
    })
  })

  registerTool('arcox_agentic_submit_deliverable', 'Submit a deliverable (bytes32 hash) for an on-chain ERC-8183 job. Requires confirmation.', {
    jobId: z.string().describe('Job id'),
    deliverable: z.string().describe('Deliverable text; hashed to bytes32 on-chain'),
    agentId: z.string().optional(),
    confirmed: z.boolean().optional(),
    confirmationText: z.string().optional(),
  }, async (params) => {
    const agentId = await agenticResolveAgentId(params.agentId)
    if (!/^\d+$/.test(agentId)) return { content: [{ type: 'text', text: jsonText({ status: 'agent_identity_required' }) }] }
    return agenticExec(params, {
      action: `submit_deliverable job #${params.jobId}`,
      calls: [(await import('../agenticJobsService.mjs')).submitDeliverableCall({ agentId, jobId: params.jobId, deliverable: params.deliverable })],
      buildResult: async () => ({ jobId: params.jobId, agentId, deliverableHash: (await import('../agenticJobsService.mjs')).hashTextBytes32(params.deliverable) }),
    })
  })

  registerTool('arcox_agentic_complete_job', 'Complete an on-chain ERC-8183 job (settle escrow) with a reason hash. Requires confirmation.', {
    jobId: z.string().describe('Job id'),
    reason: z.string().optional().describe('Reason text; hashed to bytes32 (default deliverable-approved)'),
    agentId: z.string().optional(),
    confirmed: z.boolean().optional(),
    confirmationText: z.string().optional(),
  }, async (params) => {
    const agentId = await agenticResolveAgentId(params.agentId)
    if (!/^\d+$/.test(agentId)) return { content: [{ type: 'text', text: jsonText({ status: 'agent_identity_required' }) }] }
    return agenticExec(params, {
      action: `complete_job #${params.jobId}`,
      calls: [(await import('../agenticJobsService.mjs')).completeJobCall({ agentId, jobId: params.jobId, reason: params.reason })],
      buildResult: async () => ({ jobId: params.jobId, agentId, reasonHash: (await import('../agenticJobsService.mjs')).hashTextBytes32(String(params.reason || 'deliverable-approved')) }),
    })
  })

  registerTool('arcox_agentic_ask', 'Ask the hosted ARCOX agent for a plan/simulation mapped to the Agentic jobs workflow (read-only; no funds move).', {
    prompt: z.string().describe('Task prompt'),
    agentId: z.string().optional(),
  }, async (params) => {
    try {
      const info = await resolveMsca()
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const r = await fetch(`${backendUrl}/api/agent/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(mintOwnerToken() ? { Authorization: `Bearer ${mintOwnerToken()}` } : {}) },
        body: JSON.stringify({ prompt: params.prompt, agentId: params.agentId || '', owner: info.walletAddress, address: info.walletAddress, requester: info.walletAddress, source: 'arcox-mcp' }),
        signal: AbortSignal.timeout(30_000),
      })
      const data = await r.json().catch(() => ({}))
      return { content: [{ type: 'text', text: jsonText({ status: r.ok ? 'ok' : 'error', ...data }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', error: e?.message || 'agent ask failed' }) }] }
    }
  })
}
