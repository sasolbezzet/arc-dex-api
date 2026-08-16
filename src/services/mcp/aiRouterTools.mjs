// AI Router tools (owner-scoped, backed by /api/ai-router) + ARCOX Intel full
// wallet report (x402-paid) + Agent Jobs (via AI Router API key, agent:jobs
// scope). Split out of mcpServer.mjs for maintainability.
/**
 * @param {object} ctx
 * @param {Function} ctx.registerTool   registerTool(name, desc, schema, handler) with error boundary
 * @param {Function} ctx.jsonText       JSON.stringify helper
 * @param {Function} ctx.mscaRequiredResult helper for "session required" responses
 * @param {object}   ctx.z              zod (or compatible) for schemas
 * @param {Function} ctx.resolveMsca    () => resolveActiveMsca(userId, boundMscaWalletAddress)
 * @param {Function} ctx.apiGet         apiGet(path, ownerWallet)
 * @param {Function} ctx.apiPost        apiPost(path, body, ownerWallet)
 * @param {Function} ctx.mintOwnerToken () => owner bearer token for the current userId
 * @param {string}   ctx.backendUrl     backend base URL
 */
export function registerAiRouterTools(ctx) {
  const { registerTool, jsonText, mscaRequiredResult, z, resolveMsca, apiGet, apiPost, mintOwnerToken, backendUrl } = ctx

  // ── ARCOX INTEL full wallet report (x402-paid) ──
  registerTool('arcox_intel_quote_wallet_report', 'Quote an ARCOX Intel full wallet report. Shows x402 price and confirmation requirement before paid analysis.', {
    address: z.string().describe('Wallet address (0x...)'),
  }, async (params) => {
    try {
      const sessionInfo = await (await import('../vaultStore.mjs')).getSessionKeyInfo(ctx.userId)
      const r = await fetch(`${backendUrl}/api/intel/report/address/${encodeURIComponent(params.address)}`, { headers: { ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken()}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}) } })
      const data = await r.json()
      return { content: [{ type: 'text', text: jsonText({ ...data, safeNextStep: data?.paymentRequired || data?.invoice ? 'Invoice x402 dibuat. Pay via arcox_x402_pay_invoice (tanpa confirmed) untuk preview, lalu retry dengan paymentId.' : 'Report tersedia. Call arcox_intel_execute_wallet_report dengan paymentId jika belum ter-unlock.' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'quote wallet report failed' }) }] }
    }
  })

  registerTool('arcox_intel_execute_wallet_report', 'Execute an ARCOX Intel full wallet report after x402 payment. If no paymentId is supplied, returns a payment preview/invoice only.', {
    address: z.string().describe('Wallet address (0x...)'),
    paymentId: z.string().optional().describe('x402 paymentId if already paid'),
  }, async (params) => {
    try {
      const sessionInfo = await (await import('../vaultStore.mjs')).getSessionKeyInfo(ctx.userId)
      const r = await fetch(`${backendUrl}/api/intel/report/address/${encodeURIComponent(params.address)}`, { headers: { ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken()}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}), 'X-Payment-Id': params.paymentId || '' } })
      const data = await r.json()
      if (r.status === 402 || data?.paymentRequired) return { content: [{ type: 'text', text: jsonText({ paymentRequired: true, ...data, safeNextStep: 'Pay via arcox_x402_pay_invoice (tanpa confirmed) untuk preview, lalu retry tool ini dengan paymentId.' }) }] }
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'execute wallet report failed' }) }] }
    }
  })

  // ── AI ROUTER tools (owner-scoped, backed by /api/ai-router) ──
  const routerOwner = async () => {
    const info = await resolveMsca()
    return info?.walletAddress || ''
  }

  registerTool('get_ai_router_status', 'Get ARCOX AI Router status for the bound Agent Wallet owner.', {
    ownerAddress: z.string().optional().describe('Optional explicit owner address (must match the active MSCA)'),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/status?ownerAddress=${encodeURIComponent(owner)}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'ai router status failed' }) }] }
    }
  })

  registerTool('list_agent_identities', 'List Arc Agent Identities owned by the bound Agent Wallet.', {
    ownerAddress: z.string().optional(), refresh: z.boolean().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/agent-identities?ownerAddress=${encodeURIComponent(owner)}${params.refresh ? '&refresh=true' : ''}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list agent identities failed' }) }] }
    }
  })

  registerTool('select_agent_identity', 'Select an owned Arc Agent Identity as the active identity for new API keys and Agent Jobs.', {
    agentId: z.string().describe('Agent id'), ownerAddress: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiPost('/api/ai-router/agent-identities/select', { ownerAddress: owner, agentId: params.agentId }, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'select agent identity failed' }) }] }
    }
  })

  registerTool('get_ai_router_api_keys', 'List AI Router API keys for the bound Agent Wallet owner.', {
    ownerAddress: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/api-keys?ownerAddress=${encodeURIComponent(owner)}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list api keys failed' }) }] }
    }
  })

  registerTool('create_ai_api_key', 'Create a standard ARCOX AI Router API key. Returns the key once; backend stores only its hash.', {
    ownerAddress: z.string().optional(), label: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiPost('/api/ai-router/api-keys', { ownerAddress: owner, label: params.label || 'ARCOX MCP AI Router' }, owner)
      return { content: [{ type: 'text', text: jsonText({ ...data, safeNextStep: 'Copy the apiKey now. ARCOX stores only the hash and cannot show it again.' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'create api key failed' }) }] }
    }
  })

  registerTool('revoke_ai_api_key', 'Revoke an ARCOX AI Router API key owned by the bound Agent Wallet.', {
    keyId: z.string().describe('Key id'), ownerAddress: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiPost(`/api/ai-router/api-keys/${encodeURIComponent(params.keyId)}/revoke`, { ownerAddress: owner }, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'revoke api key failed' }) }] }
    }
  })

  registerTool('list_ai_models', 'List OpenAI-compatible ARCOX AI Router models.', {}, async () => {
    try {
      const data = await apiGet('/api/ai-router/models', ctx.userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list models failed' }) }] }
    }
  })

  registerTool('get_usage_logs', 'Get ARCOX AI Router usage logs for the bound Agent Wallet owner.', {
    ownerAddress: z.string().optional(), limit: z.number().optional().describe('Default 10'),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/usage?ownerAddress=${encodeURIComponent(owner)}&limit=${params.limit || 10}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'usage logs failed' }) }] }
    }
  })

  registerTool('call_ai_model', 'Call ARCOX AI Router directly with a standard arx_sk API key (billing via Unified Balance Auto Pay).', {
    prompt: z.string().describe('User prompt'),
    model: z.string().optional().describe('Default arcox/auto'),
    apiKey: z.string().optional().describe('arx_sk_... API key. Required unless set in backend env.'),
  }, async (params) => {
    try {
      const apiKey = String(params.apiKey || process.env.ARCOX_AI_ROUTER_API_KEY || '').trim()
      if (!apiKey.startsWith('arx_sk_')) return { content: [{ type: 'text', text: jsonText({ error: 'ARCOX AI Router API key is required (arx_sk_...). Create one with create_ai_api_key.' }) }] }
      const r = await fetch(`${backendUrl}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: params.model || 'arcox/auto', messages: [{ role: 'user', content: params.prompt }], temperature: 0.7 }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await r.json().catch(() => ({}))
      if (r.status === 402) return { content: [{ type: 'text', text: jsonText({ status: 'payment_required', ...data, safeNextStep: 'Deposit USDC to Unified Balance in ARCOX Web UI, enable Auto Pay, then retry.' }) }] }
      if (!r.ok || data?.error) return { content: [{ type: 'text', text: jsonText({ error: data?.error?.message || data?.error || `HTTP ${r.status}` }) }] }
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'call ai model failed' }) }] }
    }
  })

  // ── AGENT JOBS (via AI Router API key, agent:jobs scope) ──
  registerTool('list_agent_jobs', 'List identity-bound Agent Job summaries for the ARCOX API key.', {
    apiKey: z.string().describe('arx_sk_... API key with agent:jobs scope'), limit: z.number().optional().describe('Default 50'),
  }, async (params) => {
    try {
      const key = String(params.apiKey || '').trim()
      if (!key.startsWith('arx_sk_')) return { content: [{ type: 'text', text: jsonText({ error: 'ARCOX API key required (arx_sk_... with agent:jobs scope).' }) }] }
      const r = await fetch(`${backendUrl}/api/ai-router/agent-jobs?limit=${params.limit || 50}`, { headers: { Authorization: `Bearer ${key}` } })
      const data = await r.json()
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list agent jobs failed' }) }] }
    }
  })

  registerTool('create_agent_job', 'Record an identity-bound Agent Job through the AI Router API key.', {
    apiKey: z.string().describe('arx_sk_... API key with agent:jobs scope'),
    agentId: z.string().optional(), jobId: z.string().optional(), txHash: z.string().optional(), memoId: z.string().optional(),
    status: z.string().optional().describe('Default created'),
  }, async (params) => {
    try {
      const key = String(params.apiKey || '').trim()
      if (!key.startsWith('arx_sk_')) return { content: [{ type: 'text', text: jsonText({ error: 'ARCOX API key required (arx_sk_... with agent:jobs scope).' }) }] }
      const r = await fetch(`${backendUrl}/api/ai-router/agent-jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ agentId: params.agentId, jobId: params.jobId, txHash: params.txHash, memoId: params.memoId, status: params.status || 'created' }),
      })
      const data = await r.json()
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'create agent job failed' }) }] }
    }
  })
}
