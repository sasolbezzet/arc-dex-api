// ARCOX Intel (x402-paid, read-only) + x402 payment MCP tools. Intel endpoints
// return an invoice (paymentRequired) until paid; after arcox_x402_pay_invoice
// (MSCA), retry with paymentId → unlockedResult. Split out of mcpServer.mjs.
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
  const normalizeIntelTokenId = value => {
    const raw = String(value || '').trim()
    return intelTokenAliases[raw.toUpperCase()] || raw
  }
  const isProviderNotFound = (status, data) => status === 404
    || /\b(?:not[ -]?found|unknown token|token unavailable)\b/i.test(String(data?.error || data?.message || ''))
  const intelTool = (name, desc, pathFromId, schema) => registerTool(name, desc, schema, async (params) => {
    const normalizedParams = name === 'arcox_intel_get_token'
      ? { ...params, id: normalizeIntelTokenId(params.id) }
      : params
    const path = pathFromId(normalizedParams)
    const { getSessionKeyInfo } = await import('../vaultStore.mjs')
    const sessionInfo = await getSessionKeyInfo(ctx.userId)
    const headers = {
      ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken()}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}),
      'X-Payment-Id': normalizedParams.paymentId || '',
    }
    const r = await fetch(`${backendUrl}/api/intel${path}`, { headers })
    const data = await r.json()
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
      return { content: [{ type: 'text', text: jsonText({ paymentRequired: true, ...data, safeNextStep: 'Invoice x402 dibuat. Call arcox_x402_pay_invoice (tanpa confirmed) untuk preview. Setelah user setuju dan bayar, retry intel tool dengan paymentId yang sama.' }) }] }
    }
    if (data?.unlockedResult) {
      return { content: [{ type: 'text', text: jsonText({ intelPresentation: data.intelPresentation, result: data.unlockedResult, x402Payment: data.x402Payment }) }] }
    }
    if (normalizedParams.paymentId && isProviderNotFound(r.status, data)) {
      return { content: [{ type: 'text', text: jsonText({
        status: 'provider_not_found',
        result: null,
        x402Payment: data?.x402Payment || (providerOutcome ? publicInvoice(providerOutcome) : { paymentId: normalizedParams.paymentId, serviceStatus: 'provider_not_found', refundEligible: false, refundStatus: 'outcome_unavailable' }),
        error: data?.error || data?.message || 'Intel provider tidak menemukan token/data setelah pembayaran.',
        refundReviewRecorded: Boolean(providerOutcome),
        message: providerOutcome
          ? 'Pembayaran tercatat, tetapi data provider tidak ditemukan. Tidak ada charge ulang; refund ditandai pending_review dan harus diproses melalui treasury/refund workflow.'
          : 'Pembayaran tercatat, tetapi status refund belum dapat disimpan pada backend invoice. Jangan charge ulang; lakukan rekonsiliasi invoice sebelum memproses refund.',
      }) }] }
    }
    return { content: [{ type: 'text', text: jsonText(data) }] }
  })

  intelTool('arcox_intel_get_address', 'Get address intelligence via ARCOX Intel (may require x402 payment).', p => `/address/${encodeURIComponent(p.address)}/all`, {
    address: z.string().describe('EVM address (0x...)'),      paymentId: z.string().optional().describe('x402 paymentId if already paid'),

  })
  intelTool('arcox_intel_get_contract', 'Get contract intelligence.', p => `/contract/${encodeURIComponent(p.chain)}/${encodeURIComponent(p.address)}`, {
    chain: z.string().describe('Chain (ethereum, base, arbitrum)'),
    address: z.string().describe('Contract address'),
    paymentId: z.string().optional(),
  })
  intelTool('arcox_intel_get_entity', 'Get entity intelligence.', p => `/entity/${encodeURIComponent(p.entity)}`, {
    entity: z.string().describe('Entity name/organization'),
    paymentId: z.string().optional(),
  })
  intelTool('arcox_intel_get_token', 'Get token intelligence. Common aliases such as BTC are normalized before the paid provider request.', p => (p.address ? `/token/${encodeURIComponent(p.chain)}/${encodeURIComponent(p.address)}` : `/token/${encodeURIComponent(p.id)}`), {
    id: z.string().optional().describe('Token id/symbol'),
    chain: z.string().optional(),
    address: z.string().optional(),
    paymentId: z.string().optional(),
  })
  intelTool('arcox_intel_get_tx', 'Get transaction intelligence.', p => `/tx/${encodeURIComponent(p.hash)}`, {
    hash: z.string().describe('Transaction hash'),
    paymentId: z.string().optional(),
  })
  intelTool('arcox_intel_search', 'Search / intel via Arkham search.', p => { const params = new URLSearchParams({ query: p.query }); return `/search?${params.toString()}` }, {
    query: z.string().describe('Search query'),
    paymentId: z.string().optional(),
  })

  // ── x402 PAYMENT TOOLS (MSCA session-key only) ──

  registerTool('arcox_x402_pay_invoice', 'Pay an ARCOX x402 invoice from the Agent Wallet (MSCA via session key). Call WITHOUT confirmed to get a preview; show it to user; then call with confirmed=true + previewId + confirmationText.', {
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

  registerTool('arcox_x402_invoice_status', 'Check status of an ARCO x402 invoice (pending → paid).', {
    invoiceId: z.string().describe('ARCO x402 invoice ID or paymentId'),
  }, async (params) => {
    try {
      const invoice = await getX402Invoice(params.invoiceId)
      if (!invoice) return { content: [{ type: 'text', text: jsonText({ status: 'not_found' }) }] }
      return { content: [{ type: 'text', text: jsonText({ status: invoice.status, invoice }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', error: e?.message || 'status error' }) }] }
    }
  })
}
