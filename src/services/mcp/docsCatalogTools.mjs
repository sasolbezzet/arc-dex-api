// Docs / catalog / guide MCP tools (read-only, self-contained). Ported from
// the arcox-mcp runtime so plugin agents get the same service catalog, docs
// search, UI map, action planning, and execution guide. Split out of
// mcpServer.mjs for maintainability.
/**
 * @param {object} ctx
 * @param {Function} ctx.registerTool   registerTool(name, desc, schema, handler) with error boundary
 * @param {Function} ctx.jsonText       JSON.stringify helper
 * @param {Function} ctx.mscaRequiredResult helper for "session required" responses
 * @param {object}   ctx.z              zod (or compatible) for schemas
 * @param {Function} ctx.resolveMsca    () => resolveActiveMsca(userId, boundMscaWalletAddress)
 * @param {Function} ctx.apiGet         apiGet(path, ownerWallet)
 */
export function registerDocsCatalogTools(ctx) {
  const { registerTool, jsonText, mscaRequiredResult, z, resolveMsca, apiGet } = ctx

  const arcoxPages = [
    { id: 'swap', title: 'Swap', purpose: 'Swap retail tokens on Arc Testnet from Agent Wallet (MSCA).', userInputs: ['tokenIn', 'tokenOut', 'amountIn'], actions: ['arcox_quote_swap', 'arcox_execute_swap'] },
    { id: 'bridge', title: 'Bridge', purpose: 'Bridge USDC across Arc/Base/Arbitrum Sepolia via verified ArcoxRouter + CCTP.', userInputs: ['fromChain', 'toChain', 'token', 'amount'], actions: ['arcox_quote_bridge', 'arcox_execute_bridge', 'arcox_bridge_status', 'arcox_retry_bridge_mint'] },
    { id: 'send', title: 'Send', purpose: 'Send supported tokens to another address from the Agent Wallet.', userInputs: ['recipient', 'token', 'amount'], actions: ['arcox_quote_send', 'arcox_execute_send'] },
    { id: 'pay', title: 'ARCOX Pay', purpose: 'Create and pay USDC invoice/payment requests on Arc Testnet.', userInputs: ['amount', 'merchantAddress'], actions: ['arcox_create_payment_request', 'arcox_quote_payment_request', 'arcox_pay_payment_request', 'arcox_check_payment_status'] },
    { id: 'intel', title: 'Intel', purpose: 'Read-only Arkham address/entity/token/portfolio intelligence through ARCOX API (x402 paid). No swap, bridge, send, buy, or sell execution.', userInputs: ['address/entity/token'], actions: ['arcox_intel_search', 'arcox_intel_get_address', 'arcox_intel_get_entity', 'arcox_intel_get_token', 'arcox_intel_get_balances', 'arcox_intel_get_portfolio', 'arcox_intel_get_flows', 'arcox_intel_get_history', 'arcox_intel_get_volume', 'arcox_intel_get_counterparties', 'arcox_intel_get_transfers', 'arcox_x402_pay_invoice'] },
    { id: 'ai_router', title: 'AI Router', purpose: 'Manage API keys, list models, call models, and inspect usage.', userInputs: ['prompt'], actions: ['get_ai_router_status', 'create_ai_api_key', 'list_ai_models', 'call_ai_model', 'get_usage_logs'] },
  ]
  const arcoxActions = [
    { id: 'swap', page: 'swap', intentExamples: ['swap 1 eurc to usdc', 'berapa dapat usdc dari 5 eurc'], requiredSlots: ['tokenIn', 'tokenOut', 'amountIn'], safeExecution: 'quote_then_confirm' },
    { id: 'bridge', page: 'bridge', intentExamples: ['bridge 1 usdc dari arc ke base', 'bridge dari arbitrum ke arc'], requiredSlots: ['fromChain', 'toChain', 'token', 'amount'], safeExecution: 'quote_then_confirm' },
    { id: 'send', page: 'send', intentExamples: ['send 5 usdc ke 0x...', 'kirim usdc dari agent wallet'], requiredSlots: ['recipient', 'token', 'amount'], safeExecution: 'quote_then_confirm' },
    { id: 'pay_invoice', page: 'pay', intentExamples: ['create payment request 10 usdc ke 0x...', 'bayar invoice arcox'], requiredSlots: ['amount', 'merchantAddress'], safeExecution: 'quote_then_confirm' },
    { id: 'intel', page: 'intel', intentExamples: ['analyze address 0x...', 'check token btc', 'show wallet balances', 'show token holders'], requiredSlots: ['address/entity/token'], safeExecution: 'x402_paid_read' },
  ]
  const arcoxChainSupport = {
    Arc_Testnet: { bridge: true, router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7', circleWallet: true, aliases: ['arc', 'arc testnet'] },
    Ethereum_Sepolia: { bridge: true, router: '0x53aB114FeE64b177B8D6066056DfD03Ea38D0ef1', circleWallet: false, aliases: ['ethereum', 'eth sepolia'] },
    Base_Sepolia: { bridge: true, router: '0x9425cC5b3C8B9e0FCb35beBdE737B4365A614Acc', circleWallet: false, aliases: ['base', 'base sepolia'] },
    Arbitrum_Sepolia: { bridge: true, router: '0x5dCAA895dDc7350cF0f9eb69E69536a4548b0cA7', circleWallet: false, aliases: ['arbitrum', 'arb sepolia'] },
  }
  const arcoxRetailRules = [
    'Always quote before swap, bridge, send, or invoice payment.',
    'Never execute a value-moving action without explicit user confirmation (yes/ya).',
    'Bridge pending is normal after burn; poll arcox_bridge_status and retry mint with the burn tx.',
    'Agent may prepare plans, but user-owned funds require explicit confirmation.',
  ]
  const arcoxDocsCatalog = [
    { id: 'overview', title: 'ARCOX Overview', tags: ['dex', 'arc', 'wallet'], body: 'ARCOX DEX is a retail Arc Testnet app for swap, bridge, send, ARCOX Pay invoices, and agent workflows. Value-moving actions must quote before execution.' },
    { id: 'pay', title: 'ARCOX Pay', tags: ['pay', 'invoice', 'usdc'], body: 'ARCOX Pay creates public USDC invoice/payment links on Arc Testnet. Invoice payment requires preview and confirmation.' },
    { id: 'bridge-retry', title: 'Bridge Retry', tags: ['bridge', 'retry', 'cctp'], body: 'CCTP bridge has approve, burn, attestation, and mint stages. If burn succeeded but mint is pending, retry mint instead of repeating the burn.' },
    { id: 'mcp-safety', title: 'MCP Safety Rules', tags: ['mcp', 'agent', 'safety'], body: 'Agents must call quote tools first, show preview, receive explicit confirmation, then execute with previewId and confirmationText.' },
    { id: 'intel-x402', title: 'Intel x402', tags: ['intel', 'x402', 'arkham'], body: 'ARCOX Intel is x402 paid: unpaid requests return an invoice; pay via arcox_x402_pay_invoice then retry with paymentId.' },
  ]

  registerTool('arcox_search_docs', 'Search ARCOX product and MCP documentation. Use this before guessing an unfamiliar ARCOX flow.', {
    query: z.string().describe('Search query'),
  }, async (params) => {
    const words = String(params.query || '').toLowerCase().split(/\W+/).filter(Boolean)
    const results = arcoxDocsCatalog.map(doc => {
      const haystack = [doc.id, doc.title, ...(doc.tags || []), doc.body].join(' ').toLowerCase()
      const score = words.reduce((sum, w) => sum + (haystack.includes(w) ? 1 : 0), 0)
      return { id: doc.id, title: doc.title, tags: doc.tags, score, snippet: doc.body.slice(0, 220) }
    }).filter(item => item.score > 0 || !words.length).sort((a, b) => b.score - a.score)
    return { content: [{ type: 'text', text: jsonText({ query: params.query, results, safeNextStep: results.length ? 'Call arcox_read_doc with the selected id before acting on unfamiliar flows.' : 'No doc match found. Ask the user to clarify the desired ARCOX flow.' }) }] }
  })

  registerTool('arcox_read_doc', 'Read a structured ARCOX documentation page by id returned from arcox_search_docs.', {
    id: z.string().describe('Document id from arcox_search_docs'),
  }, async (params) => {
    const doc = arcoxDocsCatalog.find(item => item.id === String(params.id || '').toLowerCase())
    if (!doc) return { content: [{ type: 'text', text: jsonText({ error: `Unknown ARCOX doc id: ${params.id}` }) }] }
    return { content: [{ type: 'text', text: jsonText({ ...doc }) }] }
  })

  registerTool('arcox_service_catalog', 'Return a concise catalog of ARCOX MCP services, capabilities, safety rules, and example prompts.', {}, async () => {
    return { content: [{ type: 'text', text: jsonText({
      project: 'ARCOX DEX + ARCOX MCP',
      safety: 'All value-moving tools must quote/preview first and require user confirmation.',
      services: [
        { name: 'wallet_balances', description: 'Read Agent Wallet MSCA balances across chains.' },
        { name: 'swap', description: 'Quote and execute supported Arc swaps with preview-before-execute.' },
        { name: 'bridge', description: 'Quote and execute supported USDC CCTP bridge routes; attestation-ready destinations mint automatically or via arcox_retry_bridge_mint.' },
        { name: 'send', description: 'Quote and send supported Arc tokens from the Agent Wallet.' },
        { name: 'arcox_pay', description: 'Create/quote/pay/check ARCOX Pay invoice workflows.' },
        { name: 'intel_x402', description: 'ARCOX Intel via backend Arkham API with Arc Testnet USDC x402 payment.' },
        { name: 'ai_router', description: 'Check AI Router status, create/revoke API keys, list models, call models, and inspect usage.' },
        { name: 'agentic_jobs', description: 'List/create/complete Agentic Economy jobs through the AI Router API.' },
      ],
      examplePrompts: [
        'show all wallet balances', 'quote bridge 1 usdc from arc to base', 'check auto mint worker status for 0xBURN_TX',
        'send 1 eurc from agent wallet to 0x...', 'retry bridge 0xBURN_TX from arbitrum sepolia to arc', 'quote swap 1 eurc to usdc',
        'create payment request 10 usdc to 0x...', 'check x402 invoice arcox_x402_...', 'list ai router models', 'call ai router model with prompt ...',
      ],
    }) }] }
  })

  registerTool('arcox_catalog', 'Backward-compatible alias for arcox_service_catalog.', {}, async () => ({
    content: [{ type: 'text', text: jsonText({
      project: 'ARCOX DEX + ARCOX MCP',
      safety: 'All value-moving tools must quote/preview first and require user confirmation.',
      services: [
        { name: 'wallet_balances', description: 'Read Agent Wallet MSCA balances across chains.' },
        { name: 'swap', description: 'Quote and execute supported Arc swaps with preview-before-execute.' },
        { name: 'bridge', description: 'Quote and execute supported USDC CCTP bridge routes; attestation-ready destinations mint automatically or via arcox_retry_bridge_mint.' },
        { name: 'send', description: 'Quote and send supported Arc tokens from the Agent Wallet.' },
        { name: 'arcox_pay', description: 'Create/quote/pay/check ARCOX Pay invoice workflows.' },
        { name: 'intel_x402', description: 'ARCOX Intel via backend Arkham API with Arc Testnet USDC x402 payment.' },
        { name: 'ai_router', description: 'Check AI Router status, create/revoke API keys, list models, call models, and inspect usage.' },
        { name: 'agentic_jobs', description: 'List/create Agentic Economy jobs through the AI Router API.' },
      ],
      examplePrompts: [
        'show all wallet balances', 'quote bridge 1 usdc from arc to base', 'check auto mint worker status for 0xBURN_TX',
        'send 1 eurc from agent wallet to 0x...', 'retry bridge 0xBURN_TX from arbitrum sepolia to arc', 'quote swap 1 eurc to usdc',
        'create payment request 10 usdc to 0x...', 'check x402 invoice arcox_x402_...', 'list ai router models', 'call ai router model with prompt ...',
      ],
    }) }],
  }))

  registerTool('arcox_execution_guide', 'Return exact step-by-step tool routes for every ARCOX MCP flow so agents do not guess tool order.', {
    intent: z.string().optional().describe('Optional filter: swap, bridge, send, pay, intel, retry'),
  }, async (params) => {
    const guide = {
      rule: 'Never guess tool order. For every value-moving request: quote first, show preview, wait for user yes/ya, then execute with previewId and confirmationText.',
      flows: [
        { intent: 'swap', steps: ['arcox_quote_swap', 'show preview', 'user yes', 'arcox_execute_swap with confirmed=true, previewId, confirmationText'] },
        { intent: 'bridge', steps: ['arcox_quote_bridge', 'show preview', 'user yes', 'arcox_execute_bridge', 'if pending: arcox_bridge_status / arcox_retry_bridge_mint'] },
        { intent: 'send', steps: ['arcox_quote_send', 'show preview', 'user yes', 'arcox_execute_send'] },
        { intent: 'pay', steps: ['arcox_create_payment_request or arcox_get_payment_request', 'arcox_quote_payment_request', 'show preview', 'user yes', 'arcox_pay_payment_request'] },
        { intent: 'intel', steps: ['arcox_intel_get_* to get invoice', 'arcox_x402_pay_invoice without confirmed for preview', 'user yes', 'pay with confirmed=true, previewId', 'retry intel with paymentId'] },
        { intent: 'retry', steps: ['arcox_bridge_status with burnTxHash', 'if attestation ready: arcox_retry_bridge_mint'] },
      ],
      recovery: ['If a tool returns preview_required, call the same tool without confirmed to get previewId.', 'If invoice status is payment_required/settlement_pending, poll status; do not ask for txHash.', 'If a call times out, check status/history before repeating value-moving execution.'],
    }
    const intent = String(params.intent || '').toLowerCase()
    const flows = intent ? guide.flows.filter(f => f.intent.includes(intent) || intent.includes(f.intent)) : guide.flows
    return { content: [{ type: 'text', text: jsonText({ ...guide, flows }) }] }
  })

  registerTool('arcox_ui_map', 'Return the full ARCOX DEX page/action map so an agent can understand the Web UI.', {}, async () => ({
    content: [{ type: 'text', text: jsonText({ pages: arcoxPages, actions: arcoxActions, chains: arcoxChainSupport, retailRules: arcoxRetailRules }) }],
  }))

  registerTool('arcox_action_plan', 'Convert a user intent into a cautious ARCOX action plan with missing slots and signing rules.', {
    intent: z.string().describe('User intent, e.g. bridge 1 usdc arc ke base'),
    pageHint: z.string().optional(),
  }, async (params) => {
    const text = `${params.intent} ${params.pageHint || ''}`.toLowerCase()
    const action = arcoxActions.map(a => ({ action: a, score: [a.id, a.page, ...a.intentExamples].join(' ').toLowerCase().split(/\W+/).reduce((sum, w) => sum + (w && text.includes(w) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score)[0]
    if (!action?.score) return { content: [{ type: 'text', text: jsonText({ status: 'needs_clarification', reason: 'No matching ARCOX action found.', safeNextStep: 'Call arcox_execution_guide, then ask whether user wants swap, bridge, send, pay, or intel.' }) }] }
    const page = arcoxPages.find(p => p.id === action.action.page)
    return { content: [{ type: 'text', text: jsonText({ status: 'planned', matchedAction: action.action, page, missingSlots: action.action.requiredSlots, safetyRules: arcoxRetailRules, safeNextStep: action.action.safeExecution === 'quote_then_confirm' ? 'Quote/preview first, request explicit user confirmation, then execute with previewId and confirmationText.' : 'Fetch quote/status only.' }) }] }
  })

  registerTool('arcox_agent_status', 'Return the bound Agent Wallet MSCA status, delegate, and balances without exposing signing secrets.', {}, async () => {
    const info = await resolveMsca()
    if (!info) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
    const balances = await apiGet(`/api/multi-balance/${encodeURIComponent(info.walletAddress)}`, info.walletAddress).catch(() => null)
    return { content: [{ type: 'text', text: jsonText({
      status: 'active', walletAddress: info.walletAddress, delegateAddress: info.delegateAddress, active: true,
      balances: balances?.balances || null,
      safeNextStep: 'Read-only status. For balances use arcox_wallet_balances.',
    }) }] }
  })
}
