// ARCOX Intel (x402-paid, read-only) + x402 payment MCP tools. Intel endpoints
// return an invoice (paymentRequired) until paid; after arcox_x402_pay_invoice
// (MSCA), retry with paymentId → unlockedResult. Split out of mcpServer.mjs.
//
// Important: Intel tools only read Arkham-backed data. They never call swap,
// bridge, send, approve, or any transaction execution path. The separate
// arcox_x402_pay_invoice tool only settles the access invoice after the user
// explicitly confirms the data request.
/**
 * @param {object} ctx
 * @param {Function} ctx.registerTool   registerTool(name, desc, schema, handler) with error boundary
 * @param {Function} ctx.jsonText       JSON.stringify helper
 * @param {object}   ctx.z              zod (or compatible) for schemas
 * @param {string}   ctx.backendUrl     backend base URL
 * @param {Function} ctx.mintOwnerToken () => owner bearer token for the current userId
 * @param {Function} ctx.markX402ServiceOutcome markX402ServiceOutcome(paymentId, outcome)
 * @param {Function} ctx.previewX402Pay previewX402Pay(userId, invoiceId)
 * @param {Function} ctx.executeX402Pay executeX402Pay(userId, invoiceId)
 * @param {Function} ctx.getX402Invoice getX402Invoice(invoiceId)
 * @param {Function} ctx.publicInvoice  publicInvoice(invoice) -> safe public shape
 */
export function registerIntelTools(ctx) {
  const { registerTool, jsonText, z, backendUrl, mintOwnerToken, markX402ServiceOutcome, previewX402Pay, executeX402Pay, getX402Invoice, publicInvoice } = ctx

  const intelTokenAliases = {
    BTC: 'bitcoin',
    XBT: 'bitcoin',
    ETH: 'ethereum',
    WETH: 'wrapped-ether',
    USDC: 'usd-coin',
    USDT: 'tether',
  }
  const addressServices = ['basic', 'all', 'enriched', 'balances', 'counterparties', 'flows', 'history', 'volume', 'portfolio']
  const entityServices = ['basic', 'summary', 'balances', 'counterparties', 'flows', 'history', 'volume', 'portfolio']
  const tokenServices = ['basic', 'market', 'holders', 'top-flow', 'trending', 'top', 'price-history', 'price-change', 'volume', 'contract', 'contract-holders']
  const timeWindows = ['1h', '24h', '7d', '30d', '1M', '1y', '60d']

  const normalizeIntelTokenId = value => {
    const raw = String(value || '').trim()
    return intelTokenAliases[raw.toUpperCase()] || raw
  }
  const isProviderNotFound = (status, data) => status === 404
    || /\b(?:not[ -]?found|unknown token|token unavailable)\b/i.test(String(data?.error || data?.message || ''))

  const appendQuery = (path, params = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
    }
    const encoded = query.toString()
    return encoded ? `${path}?${encoded}` : path
  }

  const queryParams = (params, keys) => Object.fromEntries(keys
    .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .map(key => [key, params[key]]))

  const addressPath = params => {
    const address = encodeURIComponent(params.address)
    const service = params.service || 'all'
    if (!addressServices.includes(service)) throw new Error(`Unsupported address service: ${service}`)
    const suffix = service === 'basic' ? '' : `/${service}`
    const path = `/address/${address}${suffix}`
    return appendQuery(path, queryParams(params, ['chains', 'flow', 'timeLast', 'timeGte', 'timeLte', 'usdGte', 'usdLte', 'limit', 'offset', 'tags', 'tokens', 'time']))
  }

  const entityPath = params => {
    const entity = encodeURIComponent(params.entity)
    const service = params.service || 'basic'
    if (!entityServices.includes(service)) throw new Error(`Unsupported entity service: ${service}`)
    const suffix = service === 'basic' ? '' : `/${service}`
    const path = `/entity/${entity}${suffix}`
    return appendQuery(path, queryParams(params, ['chains', 'flow', 'timeLast', 'timeGte', 'timeLte', 'usdGte', 'usdLte', 'limit', 'offset', 'tags', 'tokens', 'time']))
  }

  const tokenPath = params => {
    const service = params.service || 'basic'
    if (!tokenServices.includes(service)) throw new Error(`Unsupported token service: ${service}`)
    if (service === 'trending') return appendQuery('/token/trending', queryParams(params, ['chains', 'limit', 'offset']))
    if (service === 'top') return appendQuery('/token/top', queryParams(params, ['timeframe', 'from', 'to', 'orderByAgg', 'orderByDesc', 'orderByPercent', 'size', 'limit', 'offset']))
    if (service === 'price-history') {
      if (!params.id) throw new Error('Token service price-history requires id')
      return appendQuery(`/token/${encodeURIComponent(normalizeIntelTokenId(params.id))}/price-history`, queryParams(params, ['daily']))
    }
    if (service === 'price-change') {
      if (!params.id || !params.pastTime) throw new Error('Token service price-change requires id and pastTime')
      return appendQuery(`/token/${encodeURIComponent(normalizeIntelTokenId(params.id))}/price-change`, queryParams(params, ['pastTime']))
    }
    if (service === 'volume') {
      if (!params.id || !params.granularity) throw new Error('Token service volume requires id and granularity')
      return appendQuery(`/token/${encodeURIComponent(normalizeIntelTokenId(params.id))}/volume`, queryParams(params, ['granularity', 'timeLast']))
    }
    if (service === 'contract' || service === 'contract-holders') {
      if (!params.chain || !params.address) throw new Error(`Token service ${service} requires chain and address`)
      const suffix = service === 'contract-holders' ? '/holders' : ''
      return appendQuery(`/token/${encodeURIComponent(params.chain)}/${encodeURIComponent(params.address)}${suffix}`, queryParams(params, ['chains', 'timeLast', 'limit', 'offset', 'groupByEntity', 'poolAddress']))
    }
    if (!params.id) throw new Error(`Token service ${service} requires id`)
    const id = encodeURIComponent(normalizeIntelTokenId(params.id))
    const suffix = service === 'basic' ? '' : `/${service}`
    return appendQuery(`/token/${id}${suffix}`, queryParams(params, ['chains', 'timeLast', 'limit', 'offset', 'groupByEntity', 'poolAddress', 'granularity', 'daily', 'pastTime']))
  }

  const searchPath = params => appendQuery('/search', queryParams(params, [
    'query', 'arkhamEntities', 'arkhamAddresses', 'userEntities', 'userAddresses', 'ens', 'types',
    'services', 'twitter', 'opensea', 'tokens', 'pools', 'tags', 'polymarketEvents',
    'arkhamEntitiesOffset', 'arkhamAddressesOffset', 'userEntitiesOffset', 'userAddressesOffset',
    'ensOffset', 'typesOffset', 'servicesOffset', 'twitterOffset', 'openseaOffset', 'tokensOffset',
    'poolsOffset', 'tagsOffset', 'filterLimits', 'filterOffsets',
  ]))

  const intelTool = (name, desc, pathFromParams, schema) => registerTool(name, desc, schema, async (params) => {
    const normalizedParams = name === 'arcox_intel_get_token'
      ? { ...params, id: normalizeIntelTokenId(params.id) }
      : params
    const path = pathFromParams(normalizedParams)
    const { getSessionKeyInfo } = await import('../vaultStore.mjs')
    const sessionInfo = await getSessionKeyInfo(ctx.userId)
    const headers = {
      ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken()}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}),
      'X-Payment-Id': normalizedParams.paymentId || '',
    }
    const r = await fetch(`${backendUrl}/api/intel${path}`, { headers })
    const data = await r.json().catch(() => ({}))
    // A paid x402 request can still fail at the provider layer. Mark this as
    // a service outcome rather than reporting a successful unlock; the invoice
    // remains paid, while the explicit refund review state prevents silent loss.
    let providerOutcome = null
    if (normalizedParams.paymentId && isProviderNotFound(r.status, data)) {
      providerOutcome = markX402ServiceOutcome(normalizedParams.paymentId, {
        status: 'provider_not_found',
        reason: String(data?.error || data?.message || 'Intel provider returned not found'),
        refundEligible: true,
      })
    }
    if (r.status === 402 || data?.paymentRequired) {
      return { content: [{ type: 'text', text: jsonText({ readOnly: true, paymentRequired: true, ...data, safeNextStep: 'Invoice x402 dibuat. Call arcox_x402_pay_invoice (tanpa confirmed) untuk preview. Setelah user setuju dan bayar, retry intel tool dengan paymentId yang sama.' }) }] }
    }
    if (data?.unlockedResult) {
      return { content: [{ type: 'text', text: jsonText({ readOnly: true, intelPresentation: data.intelPresentation, result: data.unlockedResult, x402Payment: data.x402Payment }) }] }
    }
    if (normalizedParams.paymentId && isProviderNotFound(r.status, data)) {
      return { content: [{ type: 'text', text: jsonText({
        readOnly: true,
        status: 'provider_not_found',
        result: null,
        x402Payment: data?.x402Payment || (providerOutcome ? publicInvoice(providerOutcome) : { paymentId: normalizedParams.paymentId, serviceStatus: 'provider_not_found', refundEligible: false, refundStatus: 'outcome_unavailable' }),
        error: data?.error || data?.message || 'Intel provider tidak menemukan data setelah pembayaran.',
        refundReviewRecorded: Boolean(providerOutcome),
        message: providerOutcome
          ? 'Pembayaran tercatat, tetapi data provider tidak ditemukan. Tidak ada charge ulang; refund ditandai pending_review dan harus diproses melalui treasury/refund workflow.'
          : 'Pembayaran tercatat, tetapi status refund belum dapat disimpan pada backend invoice. Jangan charge ulang; lakukan rekonsiliasi invoice sebelum memproses refund.',
      }) }] }
    }
    return { content: [{ type: 'text', text: jsonText({ readOnly: true, ...data }) }] }
  })

  intelTool('arcox_intel_get_address', 'Read Arkham address intelligence through ARCOX x402. Read-only: supports basic, all, enriched, balances, counterparties, flows, history, volume, and portfolio.', addressPath, {
    address: z.string().describe('EVM or supported blockchain address'),
    service: z.enum(addressServices).optional().describe('Read-only service; defaults to all for backward compatibility'),
    chains: z.string().optional().describe('Comma-separated Arkham chain filters'),
    flow: z.enum(['in', 'out', 'self', 'all']).optional(),
    timeLast: z.enum(timeWindows).optional(),
    timeGte: z.string().optional(),
    timeLte: z.string().optional(),
    usdGte: z.string().optional(),
    usdLte: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().max(10000).optional(),
    tags: z.string().optional(),
    tokens: z.string().optional(),
    time: z.string().optional().describe('Portfolio snapshot Unix timestamp in milliseconds'),
    paymentId: z.string().optional().describe('x402 paymentId if already paid'),
  })

  intelTool('arcox_intel_get_entity', 'Read Arkham entity intelligence through ARCOX x402. Read-only: supports basic, summary, balances, counterparties, flows, history, volume, and portfolio.', entityPath, {
    entity: z.string().describe('Arkham entity identifier'),
    service: z.enum(entityServices).optional().describe('Read-only entity service; defaults to basic'),
    chains: z.string().optional(),
    flow: z.enum(['in', 'out', 'all']).optional(),
    timeLast: z.enum(timeWindows).optional(),
    timeGte: z.string().optional(),
    timeLte: z.string().optional(),
    usdGte: z.string().optional(),
    usdLte: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().max(10000).optional(),
    tags: z.string().optional(),
    tokens: z.string().optional(),
    time: z.string().optional(),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_token', 'Read Arkham token and market intelligence through ARCOX x402. Read-only: supports basic, market, holders, top-flow, trending, top, contract, and contract-holders.', tokenPath, {
    id: z.string().optional().describe('CoinGecko pricing ID or common symbol alias such as BTC'),
    chain: z.string().optional().describe('Required for contract and contract-holders services'),
    address: z.string().optional().describe('Token contract address for contract services'),
    service: z.enum(tokenServices).optional().describe('Read-only token service; defaults to basic'),
    chains: z.string().optional(),
    timeLast: z.enum(timeWindows).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().max(10000).optional(),
    groupByEntity: z.boolean().optional(),
    poolAddress: z.string().optional(),
    daily: z.boolean().optional(),
    pastTime: z.string().optional().describe('Required for price-change; RFC3339 timestamp'),
    granularity: z.string().optional().describe('Required for volume; e.g. 1h, 1d'),
    timeframe: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    orderByAgg: z.string().optional(),
    orderByDesc: z.boolean().optional(),
    orderByPercent: z.boolean().optional(),
    size: z.number().int().positive().max(100).optional(),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_balances', 'Read Arkham token balances for an address or entity through ARCOX x402. Never moves funds.', params => {
    const target = params.target || 'address'
    if (target === 'entity') {
      if (!params.entity) throw new Error('entity is required when target=entity')
      return appendQuery(`/entity/${encodeURIComponent(params.entity)}/balances`, queryParams(params, ['chains', 'cheap']))
    }
    if (!params.address) throw new Error('address is required when target=address')
    return appendQuery(`/address/${encodeURIComponent(params.address)}/balances`, queryParams(params, ['chains']))
  }, {
    target: z.enum(['address', 'entity']).optional().describe('Balance target; defaults to address'),
    address: z.string().optional(),
    entity: z.string().optional(),
    chains: z.string().optional(),
    cheap: z.boolean().optional().describe('Entity balances only: allow less real-time query'),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_portfolio', 'Read an Arkham address portfolio snapshot through ARCOX x402. Never moves funds.', params => {
    if (!params.address) throw new Error('address is required')
    return appendQuery(`/address/${encodeURIComponent(params.address)}/portfolio`, queryParams(params, ['time', 'chains']))
  }, {
    address: z.string().describe('Address to inspect'),
    time: z.string().optional().describe('Unix timestamp in milliseconds; defaults to current time on backend'),
    chains: z.string().optional(),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_contract', 'Read Arkham contract intelligence through ARCOX x402. Never executes contract calls.', p => `/contract/${encodeURIComponent(p.chain)}/${encodeURIComponent(p.address)}`, {
    chain: z.string().describe('Chain (ethereum, base, arbitrum, etc.)'),
    address: z.string().describe('Contract address'),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_tx', 'Read Arkham transaction intelligence through ARCOX x402. This only reads historical data and never submits a transaction.', p => {
    const service = p.service || 'basic'
    if (service === 'transfers') return appendQuery(`/tx/${encodeURIComponent(p.hash)}/transfers`, queryParams(p, ['chain', 'transferType']))
    if (service !== 'basic') throw new Error(`Unsupported transaction service: ${service}`)
    return `/tx/${encodeURIComponent(p.hash)}`
  }, {
    hash: z.string().describe('Transaction hash to inspect'),
    service: z.enum(['basic', 'transfers']).optional(),
    chain: z.string().optional().describe('Required for transfers'),
    transferType: z.enum(['external', 'internal', 'token']).optional(),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_search', 'Read-only search across Arkham addresses, entities, tokens, pools, ENS, services, tags, and Polymarket events.', searchPath, {
    query: z.string().describe('Search query'),
    arkhamEntities: z.number().int().min(0).max(50).optional(),
    arkhamAddresses: z.number().int().min(0).max(50).optional(),
    userEntities: z.number().int().min(0).max(50).optional(),
    userAddresses: z.number().int().min(0).max(50).optional(),
    ens: z.number().int().min(0).max(50).optional(),
    types: z.number().int().min(0).max(50).optional(),
    services: z.number().int().min(0).max(50).optional(),
    twitter: z.number().int().min(0).max(50).optional(),
    opensea: z.number().int().min(0).max(50).optional(),
    tokens: z.number().int().min(0).max(50).optional(),
    pools: z.number().int().min(0).max(50).optional(),
    tags: z.number().int().min(0).max(50).optional(),
    polymarketEvents: z.number().int().min(0).max(50).optional(),
    arkhamEntitiesOffset: z.number().int().min(0).max(500).optional(),
    arkhamAddressesOffset: z.number().int().min(0).max(500).optional(),
    userEntitiesOffset: z.number().int().min(0).max(500).optional(),
    userAddressesOffset: z.number().int().min(0).max(500).optional(),
    ensOffset: z.number().int().min(0).max(500).optional(),
    typesOffset: z.number().int().min(0).max(500).optional(),
    servicesOffset: z.number().int().min(0).max(500).optional(),
    twitterOffset: z.number().int().min(0).max(500).optional(),
    openseaOffset: z.number().int().min(0).max(500).optional(),
    tokensOffset: z.number().int().min(0).max(500).optional(),
    poolsOffset: z.number().int().min(0).max(500).optional(),
    tagsOffset: z.number().int().min(0).max(500).optional(),
    filterLimits: z.string().optional(),
    filterOffsets: z.string().optional(),
    paymentId: z.string().optional(),
  })

  const scopedReadSchema = {
    target: z.enum(['address', 'entity']).optional().describe('Read target; defaults to address'),
    address: z.string().optional(),
    entity: z.string().optional(),
    chains: z.string().optional(),
    flow: z.enum(['in', 'out', 'self', 'all']).optional(),
    timeLast: z.enum(timeWindows).optional(),
    timeGte: z.string().optional(),
    timeLte: z.string().optional(),
    usdGte: z.string().optional(),
    usdLte: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().max(10000).optional(),
    tags: z.string().optional(),
    tokens: z.string().optional(),
    time: z.string().optional(),
    paymentId: z.string().optional(),
  }

  const registerScopedReadTool = (name, service, label) => intelTool(name, `Read Arkham ${label} for an address or entity through ARCOX x402. This tool is strictly read-only and never moves funds.`, params => {
    const target = params.target || 'address'
    if (target === 'entity') {
      if (!params.entity) throw new Error(`entity is required when target=entity for ${name}`)
      return entityPath({ ...params, service })
    }
    if (!params.address) throw new Error(`address is required when target=address for ${name}`)
    return addressPath({ ...params, service })
  }, scopedReadSchema)

  registerScopedReadTool('arcox_intel_get_flows', 'flows', 'flows')
  registerScopedReadTool('arcox_intel_get_history', 'history', 'history')
  registerScopedReadTool('arcox_intel_get_volume', 'volume', 'volume')
  registerScopedReadTool('arcox_intel_get_counterparties', 'counterparties', 'counterparties')

  intelTool('arcox_intel_get_risk', 'Read Arkham compliance risk score or traced risk paths for an address through ARCOX x402. This never blocks, freezes, or moves funds.', params => {
    if (!params.address) throw new Error('address is required')
    const service = params.service || 'score'
    if (service !== 'score' && service !== 'paths') throw new Error(`Unsupported risk service: ${service}`)
    return `/risk/address/${encodeURIComponent(params.address)}${service === 'paths' ? '/paths' : ''}`
  }, {
    address: z.string().describe('Address to assess'),
    service: z.enum(['score', 'paths']).optional().describe('Risk score or traced transaction paths'),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_loans', 'Read Arkham lending and borrowing positions for an address through ARCOX x402. This never opens, closes, or changes a loan.', params => {
    if (!params.address) throw new Error('address is required')
    return appendQuery(`/loans/address/${encodeURIComponent(params.address)}`, queryParams(params, ['chains']))
  }, {
    address: z.string().describe('Address to inspect'),
    chains: z.string().optional().describe('Comma-separated Arkham chain filters'),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_network', 'Read Arkham supported chains or current network status through ARCOX x402. This is strictly informational.', params => {
    const service = params.service || 'status'
    if (service === 'chains') return '/chains'
    if (service === 'status') return '/networks/status'
    throw new Error(`Unsupported network service: ${service}`)
  }, {
    service: z.enum(['chains', 'status']).optional().describe('Supported chains or current status'),
    paymentId: z.string().optional(),
  })

  intelTool('arcox_intel_get_transfers', 'Read historical Arkham transaction transfers through ARCOX x402. This tool never submits or modifies a transaction.', params => {
    if (!params.hash) throw new Error('hash is required')
    return appendQuery(`/tx/${encodeURIComponent(params.hash)}/transfers`, queryParams(params, ['chain', 'transferType']))
  }, {
    hash: z.string().describe('Transaction hash to inspect'),
    chain: z.string().optional().describe('Arkham chain filter'),
    transferType: z.enum(['external', 'internal', 'token']).optional(),
    paymentId: z.string().optional(),
  })

  // ── x402 PAYMENT TOOLS (MSCA session-key only) ──

  registerTool('arcox_x402_pay_invoice', 'Pay an ARCOX x402 data-access invoice from the Agent Wallet (MSCA via session key). This is only the access payment; it does not execute a swap, bridge, send, or Arkham transaction.', {
    invoiceId: z.string().describe('ARCOX x402 invoiceId from an Intel tool'),
    confirmed: z.boolean().optional().describe('Must be true to execute payment'),
    confirmationText: z.string().optional().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) {
      try {
        const preview = await previewX402Pay(ctx.userId, params.invoiceId)
        if (preview.status !== 'preview') {
          return { content: [{ type: 'text', text: jsonText({ ...preview, invoiceId: params.invoiceId }) }] }
        }
        return { content: [{ type: 'text', text: jsonText({ status: 'preview', requiresUserConfirmation: true, amount: preview.amount, token: preview.token, recipient: preview.recipient, payer: preview.payer, invoiceId: params.invoiceId, instruction: preview.instruction, safeNextStep: 'Tampilkan preview ini ke user. Setelah user bilang yes/ya, panggil arcox_x402_pay_invoice dengan confirmed=true dan confirmationText.' }) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: jsonText({ status: 'error', error: e?.message || 'preview error' }) }] }
      }
    }
    if (String(params.confirmationText || '').trim().toLowerCase() !== 'yes' && String(params.confirmationText || '').trim().toLowerCase() !== 'ya') {
      return { content: [{ type: 'text', text: jsonText({ status: 'confirmation_required', reason: 'Konfirmasi eksplisit (ya/yes) wajib sebelum bayar x402.' }) }] }
    }
    try {
      const result = await executeX402Pay(ctx.userId, params.invoiceId)
      return { content: [{ type: 'text', text: jsonText(result) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', executed: false, error: e?.message || 'x402 payment error' }) }] }
    }
  })

  registerTool('arcox_x402_invoice_status', 'Read the status of an ARCOX x402 data-access invoice (pending → paid).', {
    invoiceId: z.string().describe('ARCOX x402 invoice ID or paymentId'),
  }, async (params) => {
    try {
      const invoice = await getX402Invoice(params.invoiceId)
      if (!invoice) return { content: [{ type: 'text', text: jsonText({ status: 'not_found' }) }] }
      return { content: [{ type: 'text', text: jsonText({ readOnly: true, status: invoice.status, invoice }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', error: e?.message || 'status error' }) }] }
    }
  })
}
