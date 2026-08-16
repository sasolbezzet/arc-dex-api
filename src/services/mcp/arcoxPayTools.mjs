// ARCOX Pay (invoice / payment request) MCP tools — backed by /api/invoices,
// executed with the Agent Wallet MSCA session key instead of a local EOA
// signer. Split out of mcpServer.mjs for maintainability.
import { createPublicClient, defineChain, formatUnits, getAddress, http, parseUnits } from 'viem'
import { resolveArcRpc } from '../../config/arcRpc.mjs'

/**
 * @param {object} ctx
 * @param {Function} ctx.registerTool    registerTool(name, desc, schema, handler) with error boundary
 * @param {Function} ctx.jsonText        JSON.stringify helper
 * @param {Function} ctx.mscaRequiredResult helper for "session required" responses
 * @param {object}   ctx.z               zod (or compatible) for schemas
 * @param {Function} ctx.resolveMsca     () => resolveActiveMsca(userId, boundMscaWalletAddress)
 * @param {Function} ctx.apiGet          apiGet(path, ownerWallet)
 * @param {Function} ctx.apiPost         apiPost(path, body, ownerWallet)
 * @param {Function} ctx.getToolHandler  getToolHandler(name) -> registered tool handler
 * @param {string}   ctx.userId          current userId/owner
 */
export function registerArcoxPayTools(ctx) {
  const { registerTool, jsonText, mscaRequiredResult, z, resolveMsca, apiGet, apiPost, getToolHandler, userId } = ctx

  const invoiceSummary = invoice => ({
    invoiceId: invoice?.invoiceId, orderId: invoice?.orderId, amount: invoice?.amount, token: invoice?.token,
    network: invoice?.network, merchantAddress: invoice?.merchantAddress, memo: invoice?.memo, status: invoice?.status,
    paymentUrl: invoice?.paymentUrl, txHash: invoice?.txHash, paidAt: invoice?.paidAt, expiresAt: invoice?.expiresAt, timeline: invoice?.timeline || [],
  })
  const assertPayableInvoice = invoice => {
    if (!invoice?.invoiceId) throw new Error('Invoice not found.')
    if (invoice.status === 'paid') throw new Error('Invoice already paid.')
    if (invoice.status === 'expired' || invoice.status === 'cancelled' || invoice.status === 'failed') throw new Error(`Invoice status is ${invoice.status}.`)
    if (Date.now() > new Date(invoice.expiresAt).getTime()) throw new Error('Invoice expired.')
    if (invoice.token !== 'USDC' || invoice.network !== 'arc-testnet') throw new Error('Only USDC invoices on arc-testnet are supported.')
  }

  registerTool('arcox_create_payment_request', 'Create an ARCOX Pay USDC invoice/payment request on Arc Testnet.', {
    amount: z.string().describe('Amount in human readable USDC'),
    merchantAddress: z.string().describe('Merchant wallet address that receives the payment'),
    token: z.string().optional().describe('Token symbol. Default USDC'),
    orderId: z.string().optional(),
    memo: z.string().optional(),
    expiresInMinutes: z.number().optional().describe('Default 15'),
  }, async (params) => {
    try {
      const invoice = await apiPost('/api/invoices', {
        orderId: params.orderId, amount: String(params.amount || ''), token: params.token || 'USDC', network: 'arc-testnet',
        merchantAddress: params.merchantAddress, memo: params.memo, expiresInMinutes: params.expiresInMinutes || 15,
      }, userId)
      if (invoice?.error) return { content: [{ type: 'text', text: jsonText({ error: invoice.error }) }] }
      return { content: [{ type: 'text', text: jsonText({ ...invoiceSummary(invoice), safeNextStep: 'Invoice dibuat. Call arcox_quote_payment_request dengan invoiceId sebelum pembayaran.' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'create payment request failed' }) }] }
    }
  })

  registerTool('arcox_get_payment_request', 'Read a full ARCOX Pay invoice/payment request.', {
    invoiceId: z.string().describe('Invoice id'),
  }, async (params) => {
    try {
      const invoice = await apiGet(`/api/invoices/${encodeURIComponent(params.invoiceId)}`, userId)
      if (invoice?.error) return { content: [{ type: 'text', text: jsonText({ error: invoice.error }) }] }
      return { content: [{ type: 'text', text: jsonText(invoiceSummary(invoice)) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'get payment request failed' }) }] }
    }
  })

  registerTool('arcox_quote_payment_request', 'Quote an ARCOX Pay invoice before payment execution. Required before arcox_pay_payment_request.', {
    invoiceId: z.string().describe('Invoice id'),
  }, async (params) => {
    try {
      const info = await resolveMsca()
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const invoice = await apiGet(`/api/invoices/${encodeURIComponent(params.invoiceId)}`, userId)
      if (invoice?.error) return { content: [{ type: 'text', text: jsonText({ error: invoice.error }) }] }
      assertPayableInvoice(invoice)
      const arcRpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
      const client = createPublicClient({ chain: defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 }, rpcUrls: { default: { http: arcRpc } } }), transport: http(arcRpc) })
      const amountUnits = parseUnits(String(invoice.amount), 6)
      const balance = await client.readContract({ address: '0x3600000000000000000000000000000000000000', abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'balanceOf', args: [info.walletAddress] }).catch(() => 0n)
      return { content: [{ type: 'text', text: jsonText({
        ...invoiceSummary(invoice), payerAddress: info.walletAddress, payerUsdcBalance: formatUnits(balance, 6),
        supported: balance >= amountUnits, requiresUserConfirmation: true,
        userMustCheck: ['Invoice id is correct.', 'Merchant address is correct.', 'Amount and token are correct.', 'This action moves funds and cannot be reversed after execution.'],
        safeNextStep: 'Tampilkan preview ini ke user. Setelah user bilang yes/ya, panggil arcox_pay_payment_request dengan invoiceId, previewId dan confirmationText.',
      }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'quote payment request failed' }) }] }
    }
  })

  registerTool('arcox_pay_payment_request', 'Pay a quoted ARCOX Pay invoice with the Agent Wallet MSCA. Requires previewId from arcox_quote_payment_request and user confirmation.', {
    invoiceId: z.string().describe('Invoice id'),
    amount: z.string().optional(),
    token: z.string().optional(),
    merchantAddress: z.string().optional(),
    previewId: z.string().optional(),
    confirmed: z.boolean().optional(),
    confirmationText: z.string().optional(),
  }, async (params) => {
    if (!params.confirmed) {
      const quote = await getToolHandler('arcox_quote_payment_request')({ invoiceId: params.invoiceId })
      const q = JSON.parse(quote.content[0].text)
      return { content: [{ type: 'text', text: jsonText({ status: 'preview', requiresUserConfirmation: true, ...q, safeNextStep: 'Tampilkan preview ini ke user. Setelah user bilang yes/ya, panggil arcox_pay_payment_request dengan confirmed=true dan confirmationText.' }) }] }
    }
    if (!['yes', 'ya'].includes(String(params.confirmationText || '').trim().toLowerCase())) {
      return { content: [{ type: 'text', text: jsonText({ status: 'confirmation_required', reason: 'Konfirmasi eksplisit (ya/yes) wajib sebelum bayar invoice.' }) }] }
    }
    try {
      const info = await resolveMsca()
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const invoice = await apiGet(`/api/invoices/${encodeURIComponent(params.invoiceId)}`, userId)
      if (invoice?.error) return { content: [{ type: 'text', text: jsonText({ error: invoice.error }) }] }
      assertPayableInvoice(invoice)
      if (params.amount && String(params.amount) !== String(invoice.amount)) throw new Error('Invoice amount changed after quote.')
      if (params.token && String(params.token).toUpperCase() !== String(invoice.token).toUpperCase()) throw new Error('Invoice token changed after quote.')
      if (params.merchantAddress && String(params.merchantAddress).toLowerCase() !== String(invoice.merchantAddress).toLowerCase()) throw new Error('Invoice merchantAddress changed after quote.')
      const { executeViaSession } = await import('../sessionKeyService.mjs')
      const result = await executeViaSession(info.walletAddress, [{
        to: '0x3600000000000000000000000000000000000000', value: 0n,
        abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
        functionName: 'transfer',
        args: [getAddress(invoice.merchantAddress), parseUnits(String(invoice.amount), 6)],
      }], { paymaster: true, chainKey: 'arc-testnet', feeProfile: 'arc-pay', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true })
      if (result.status !== 'success') {
        return { content: [{ type: 'text', text: jsonText({ status: 'error', executed: false, reason: result.reason || 'payment failed', error: result.error, txHash: result.txHash }) }] }
      }
      const paid = await apiPost(`/api/invoices/${encodeURIComponent(params.invoiceId)}/mark-paid`, { txHash: result.txHash, payerAddress: info.walletAddress }, userId)
      return { content: [{ type: 'text', text: jsonText({ status: 'paid', executed: true, txHash: result.txHash, explorerUrl: result.explorerUrl, invoice: invoiceSummary(paid?.invoice || paid || invoice) }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'error', executed: false, error: e?.message || 'pay payment request failed' }) }] }
    }
  })

  registerTool('arcox_check_payment_status', 'Check ARCOX Pay invoice status, tx hash, paidAt, and timeline.', {
    invoiceId: z.string().describe('Invoice id'),
  }, async (params) => {
    try {
      const data = await apiGet(`/api/invoices/${encodeURIComponent(params.invoiceId)}/status`, userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'check payment status failed' }) }] }
    }
  })

  registerTool('arcox_pay_get_payment_status', 'Legacy payment status compatibility. For x402 Intel invoices use arcox_x402_invoice_status.', {
    payment_id: z.string().describe('Legacy payment id'),
  }, async () => ({
    content: [{ type: 'text', text: jsonText({ status: 'disabled', reason: 'Legacy provider payment status is disabled. x402 now uses internal ARCOX invoices and Arc memo/on-chain reconciliation.', safeNextStep: 'Use arcox_x402_invoice_status with invoiceId or paymentId.' }) }],
  }))

  registerTool('arcox_pay_list_recent_payments', 'Legacy payment history compatibility. For x402 Intel invoices use arcox_x402_invoice_status.', {
    limit: z.number().optional().describe('Default 10'),
  }, async () => ({
    content: [{ type: 'text', text: jsonText({ status: 'disabled', reason: 'Legacy provider payment history is disabled. x402 now uses internal ARCOX invoices and Arc memo/on-chain reconciliation.', safeNextStep: 'Use arcox_x402_invoice_status for paid Intel invoices, or arcox_get_payment_request for ARCOX Pay invoices.' }) }],
  }))
}
