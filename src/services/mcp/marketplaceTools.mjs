// MCP tools over the ARCOX x402 marketplace mirror.
//
// Discovery (search/quote) is free and read-only: it answers "what exists in
// the x402 directory, what does it cost, and what would ARCOX charge me".
// arcox_marketplace_call is the only paid tool — it follows the same x402
// invoice lifecycle as the Intel tools (402 → pay → retry with paymentId) so
// the user always approves the spend. The invoice charges only the ARCOX
// platform fee: the provider price is settled directly from the buying agent's
// own MSCA, so the fee is never hidden in a marked-up provider price.
export function registerMarketplaceTools(ctx) {
  const { registerTool, jsonText, z, backendUrl, mintOwnerToken, resolveMsca } = ctx

  const ownerHeaders = async () => {
    const sessionInfo = await resolveMsca()
    return sessionInfo?.active && sessionInfo.walletAddress
      ? { Authorization: `Bearer ${mintOwnerToken()}`, 'X-Arcox-Owner': sessionInfo.walletAddress }
      : {}
  }

  registerTool('arcox_marketplace_search', 'Search the mirrored Circle x402 marketplace (paid HTTP APIs from third-party providers) by keyword, category, chain, or price cap. Free and read-only: it returns each provider price and the ARCOX platform fee, not a charge.', {
    query: z.string().optional().describe('Keyword matched against description, provider, tags, and URL'),
    category: z.enum(['SOCIAL_INTELLIGENCE', 'WEB_SEARCH_RESEARCH', 'FINANCIAL_ANALYSIS', 'DATA_ENRICHMENT', 'INFRASTRUCTURE', 'PREDICTION_MARKETS', 'CREATIVE']).optional(),
    network: z.string().optional().describe('Chain filter: label (Base, Arc, Arbitrum), CAIP-2 id, or CLI key (BASE, ARC, ARB)'),
    maxPriceUsdc: z.number().positive().optional().describe('Only resources at or below this provider price'),
    gatewayOnly: z.boolean().optional().describe('Only resources that accept Circle Gateway payments'),
    limit: z.number().int().positive().max(50).optional(),
  }, async (params) => {
    const search = new URLSearchParams()
    if (params.query) search.set('q', params.query)
    if (params.category) search.set('category', params.category)
    if (params.network) search.set('network', params.network)
    if (params.maxPriceUsdc !== undefined) search.set('maxPriceUsdc', String(params.maxPriceUsdc))
    if (params.gatewayOnly) search.set('gatewayOnly', 'true')
    search.set('limit', String(params.limit || 15))
    const r = await fetch(`${backendUrl}/api/marketplace/catalog?${search.toString()}`)
    const data = await r.json().catch(() => ({}))
    return { content: [{ type: 'text', text: jsonText({ readOnly: true, ...data, safeNextStep: 'Panggil arcox_marketplace_inspect dengan id/resource untuk melihat harga + platform fee, lalu arcox_marketplace_call untuk membelinya melalui ARCOX.' }) }] }
  })

  registerTool('arcox_marketplace_inspect', 'Show one mirrored marketplace resource in full: provider, method, request schema, every accepted chain with its price, and the exact ARCOX platform fee the buyer would pay on top. Free and read-only; nothing is charged.', {
    resource: z.string().describe('Resource id (mkt_...), full URL, or a unique URL fragment'),
    chain: z.string().optional().describe('Preferred payment chain (e.g. ARC, BASE, ARB)'),
  }, async (params) => {
    const search = new URLSearchParams({ resource: params.resource })
    if (params.chain) search.set('chain', params.chain)
    const r = await fetch(`${backendUrl}/api/marketplace/quote?${search.toString()}`)
    const data = await r.json().catch(() => ({}))
    if (!data?.ok) return { content: [{ type: 'text', text: jsonText({ readOnly: true, ok: false, ...data, safeNextStep: 'Cari dulu dengan arcox_marketplace_search.' }) }] }
    return { content: [{ type: 'text', text: jsonText({ readOnly: true, ...data, resourceInput: data.resource?.input || null, safeNextStep: `Bayar fee ${data.quote?.platformFee?.amountUsdc} USDC lewat arcox_marketplace_call (harga provider ${data.quote?.upstream?.amountUsdc} USDC dibayar langsung dari Agent Wallet MSCA pembeli), lalu setujui invoice x402.` }) }] }
  })

  registerTool('arcox_marketplace_call', 'Buy a mirrored x402 marketplace resource through ARCOX. Returns an x402 invoice for the ARCOX platform fee only; the provider price is paid directly from the agent\u2019s own Agent Wallet (MSCA, ERC-1271/EIP-3009). After the user approves and pays the invoice, retry with paymentId to receive the provider response. Paid tool.', {
    resource: z.string().describe('Resource id (mkt_...), full URL, or unique URL fragment'),
    id: z.string().optional().describe('Alias of resource when using the mkt_ id'),
    chain: z.string().optional().describe('Preferred payment chain for the provider (e.g. ARC, BASE, ARB)'),
    data: z.union([z.string(), z.record(z.any())]).optional().describe('Request body for POST/PUT providers'),
    headers: z.record(z.string()).optional().describe('Extra provider headers, e.g. a required auth header'),
    maxAmountUsdc: z.number().positive().optional().describe('Refuse the call if the total exceeds this USDC amount'),
    paymentId: z.string().optional().describe('paymentId of a paid invoice to unlock the provider response'),
  }, async (params) => {
    const body = {
      resource: params.id || params.resource,
      chain: params.chain,
      data: params.data,
      headers: params.headers,
      maxAmountUsdc: params.maxAmountUsdc,
    }
    const r = await fetch(`${backendUrl}/api/marketplace/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await ownerHeaders()), 'X-Payment-Id': params.paymentId || '' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({}))
    if (data?.paymentRequired || r.status === 402 || data?.x402?.invoiceId) {
      return { content: [{ type: 'text', text: jsonText({ paymentRequired: true, ...data, safeNextStep: 'Call arcox_x402_pay_invoice tanpa confirmed untuk preview, minta persetujuan user, lalu retry tool ini dengan paymentId yang sama.' }) }] }
    }
    if (data?.ok === false) {
      return { content: [{ type: 'text', text: jsonText({ ok: false, ...data, safeNextStep: data.safeNextStep || 'Resource provider gagal. Jangan charge ulang sebelum rekonsiliasi invoice.' }) }] }
    }
    return { content: [{ type: 'text', text: jsonText({ readOnly: false, ...data }) }] }
  })
}
