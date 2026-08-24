// ARCOX Card MCP tools — list owner-scoped test cards and spend at simulated
// merchants. MCP execution is restricted to an OAuth-authenticated active MSCA
// and requires explicit confirmation before a spend. In on-chain card mode,
// settlement debits testnet USDC from that MSCA through the session key.

import { listCards, spendWithCard } from '../cardSimulator.mjs'
import { readCardRecords } from '../supabasePersistence.mjs'

/**
 * @param {Object} ctx
 * @param {Function} ctx.registerTool registerTool(name, desc, schema, handler)
 * @param {Object} ctx.z zod
 * @param {Function} ctx.jsonText JSON stringify helper
 * @param {Function} ctx.mscaRequiredResult result when no session
 * @param {Function} ctx.apiGet GET helper with owner bearer
 * @param {Function} ctx.apiPost POST helper with owner bearer
 * @param {string} ctx.userId owner identity
 */
export function registerCardTools(ctx) {
  const { registerTool, z, jsonText, mscaRequiredResult, apiGet, apiPost, userId } = ctx

  const requireSession = async () => {
    const msca = await ctx.resolveMsca()
    if (!msca) return null
    return msca
  }

  registerTool('arcox_card_config', 'Read ARCOX Card Simulator config (brand, limits, note).', {}, async () => {
    try {
      const config = await apiGet('/api/cards/config', userId)
      return { content: [{ type: 'text', text: jsonText(config) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'config failed' }) }] }
    }
  })

  registerTool('arcox_card_list_merchants', 'List simulated merchants where a test card can spend (test mode only).', {}, async () => {
    try {
      const data = await apiGet('/api/cards/merchants', userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'merchants failed' }) }] }
    }
  })

  registerTool('arcox_card_balance', 'Read the test USDC balance of the connected agent wallet (card simulator).', {}, async () => {
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      const data = await apiGet('/api/cards/balance', userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'balance failed' }) }] }
    }
  })

  registerTool('arcox_card_fund', 'Add test USDC to the card simulator balance (test mode only).', {
    amount: z.string().describe('Amount of test USDC to add'),
  }, async (params) => {
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      const data = await apiPost('/api/cards/balance/fund', { amount: String(params.amount || '25') }, userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'fund failed' }) }] }
    }
  })

  registerTool('arcox_card_create', 'Create a test virtual Visa card for the connected agent Wallet (simulator).', {
    label: z.string().optional().describe('Card label'),
    perTxLimit: z.string().optional().describe('Max per transaction in USDC'),
    dailyLimit: z.string().optional().describe('Max per day in USDC'),
    monthlyLimit: z.string().optional().describe('Max per month in USDC'),
    blockedCategories: z.array(z.string()).optional(),
  }, async (params) => {
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      const data = await apiPost('/api/cards', {
        label: params.label, perTxLimit: params.perTxLimit, dailyLimit: params.dailyLimit,
        monthlyLimit: params.monthlyLimit, blockedCategories: params.blockedCategories || [],
      }, userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'create card failed' }) }] }
    }
  })

  registerTool('arcox_card_list', 'List masked test cards owned by the active Agent Wallet MSCA. PAN and CVV are never returned.', {}, async () => {
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      // Read directly from the same card service used by the HTTP route. This
      // binds the result to the exact MSCA resolved by the MCP OAuth session,
      // not merely to the SIWE/EOA tenant identity.
      const localCards = listCards(msca.walletAddress)
      const read = await readCardRecords(msca.walletAddress, localCards)
      const data = {
        ok: true,
        walletAddress: msca.walletAddress,
        walletType: 'MSCA',
        cards: read.cards,
        persistenceSource: read.source,
      }
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list failed' }) }] }
    }
  })

  registerTool('arcox_card_spend', 'Authorize and settle a purchase with a test card at a simulated merchant. In on-chain mode this moves real testnet USDC from the Agent Wallet MSCA (session-key path). Requires explicit user confirmation.', {
    cardId: z.string().describe('Card id'),
    merchantId: z.string().describe('Merchant id from arcox_card_list_merchants'),
    amount: z.string().describe('Amount in USDC'),
    description: z.string().optional(),
    confirmed: z.boolean().optional().describe('Must be true after the user agrees'),
    confirmationText: z.string().optional().describe('yes/ya after user approval'),
  }, async (params) => {
    if (!params.confirmed || !['yes', 'ya'].includes(String(params.confirmationText || '').trim().toLowerCase())) {
      return { content: [{ type: 'text', text: jsonText({
        status: 'confirmation_required', reason: 'Card spend moves USDC from the Agent Wallet MSCA on-chain. Tunjukkan merchant, amount, dan peringatan ini ke user; setelah user setuju, panggil ulang dengan confirmed=true dan confirmationText=yes/ya.',
        merchant: params.merchantId, amount: params.amount, description: params.description,
      }) }] }
    }
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      // MCP already has two independent controls before reaching this point:
      // OAuth was bound to the active MSCA, and the user explicitly confirmed
      // the merchant/amount above. Call the shared service directly so the
      // browser-only fresh-WebAuthn guard does not incorrectly block a valid
      // MCP agent payment. The service still enforces card ownership, status,
      // limits, balance, merchant policy, and on-chain settlement.
      const result = await spendWithCard(msca.walletAddress, params.cardId, {
        merchantId: params.merchantId,
        amount: String(params.amount),
        description: params.description,
        walletAddress: msca.walletAddress,
      })
      return { content: [{ type: 'text', text: jsonText({
        ok: Boolean(result.approved),
        ...result,
        walletAddress: msca.walletAddress,
        walletType: 'MSCA',
        source: 'mcp-session',
      }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'spend failed' }) }] }
    }
  })

  registerTool('arcox_card_transactions', 'List all card transactions of the connected wallet (optionally by card).', {
    cardId: z.string().optional(),
  }, async (params) => {
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      const path = params.cardId ? `/api/cards/${encodeURIComponent(params.cardId)}/transactions` : '/api/cards/my-transactions'
      const data = await apiGet(path, userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'transactions failed' }) }] }
    }
  })

  registerTool('arcox_card_refund_tx', 'Refund a settled card transaction (test mode; returns test USDC to balance).', {
    cardId: z.string().describe('Card id'),
    txId: z.string().describe('Transaction id'),
  }, async (params) => {
    const msca = await requireSession()
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      const data = await apiPost(`/api/cards/${encodeURIComponent(params.cardId)}/refund`, { txId: params.txId }, userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'refund failed' }) }] }
    }
  })
}