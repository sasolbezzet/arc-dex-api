import { Router } from 'express'
import { createPublicClient, defineChain, getAddress, http, isAddress, parseUnits, formatUnits } from 'viem'
import { validateSession, createApproval, listApprovals, updateApprovalStatus } from '../services/vaultStore.mjs'
import { getSessionKeyInfo } from '../services/vaultStore.mjs'
import { sendViaSession } from '../services/sessionKeyService.mjs'
import { CHAINS, MSCA_SUPPORTED_CHAIN_KEYS } from '../services/chains.mjs'

const router = Router()
const QUOTE_TTL_MS = 5 * 60 * 1000
const STABLE_TOKENS = new Set(['USDC', 'EURC', 'USYC'])

function authAddress(req) {
  const header = String(req.headers.authorization || '')
  if (!header.startsWith('Bearer ')) return ''
  return String(validateSession(header.slice(7)) || '').toLowerCase()
}

async function requireMsca(req, res, next) {
  const owner = authAddress(req)
  if (!owner || !isAddress(owner)) return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  const info = await getSessionKeyInfo(owner)
  if (!info?.active || !info.walletAddress || getAddress(info.walletAddress).toLowerCase() !== owner) {
    return res.status(401).json({ error: 'Active authenticated MSCA session required' })
  }
  req.msca = info
  req.owner = owner
  next()
}

function normalizeChain(value) {
  const key = String(value || 'arc-testnet').trim().toLowerCase()
  const aliases = { arc: 'arc-testnet', arc_testnet: 'arc-testnet', base: 'base-sepolia', base_sepolia: 'base-sepolia', arbitrum: 'arbitrum-sepolia', arbitrum_sepolia: 'arbitrum-sepolia' }
  return aliases[key] || key
}

function amountUnits(amount, token) {
  const raw = String(amount ?? '').trim()
  if (!/^\d+(?:\.\d{1,18})?$/.test(raw) || Number(raw) <= 0) throw new Error('Amount must be greater than zero')
  return parseUnits(raw, STABLE_TOKENS.has(token) ? 6 : 18)
}

function chainClient(chainKey) {
  const chain = CHAINS[chainKey]
  return createPublicClient({
    chain: defineChain({ id: chain.id, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [chain.rpcUrl] } } }),
    transport: http(chain.rpcUrl, { timeout: 12_000, retryCount: 1 }),
  })
}

function validateRequest({ to, amount, token, chainKey }) {
  if (!isAddress(to)) throw new Error('Valid EVM recipient required')
  if (!CHAINS[chainKey] || !MSCA_SUPPORTED_CHAIN_KEYS.includes(chainKey)) throw new Error(`MSCA does not support chain: ${chainKey}`)
  if (!CHAINS[chainKey].tokens[token]) throw new Error(`Token ${token} is not configured on ${chainKey}`)
  const units = amountUnits(amount, token)
  return { to: getAddress(to), amount: String(amount), token, chainKey, units }
}

router.get('/status', requireMsca, async (req, res) => {
  res.json({ active: true, walletAddress: req.msca.walletAddress, walletType: 'MSCA', delegateAddress: req.msca.delegateAddress, chain: req.msca.chain || 'arc-testnet' })
})

router.post('/send/quote', requireMsca, async (req, res) => {
  try {
    const token = String(req.body?.token || 'USDC').trim().toUpperCase()
    const chainKey = normalizeChain(req.body?.fromChain || req.body?.chain)
    const request = validateRequest({ to: req.body?.to, amount: req.body?.amount, token, chainKey })
    const balance = await chainClient(chainKey).readContract({
      address: CHAINS[chainKey].tokens[token],
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [getAddress(req.msca.walletAddress)],
    })
    const decimals = STABLE_TOKENS.has(token) ? 6 : 18
    const supported = balance >= request.units
    const expiresAt = Date.now() + QUOTE_TTL_MS
    const approval = createApproval(req.owner, {
      agent: 'local-mcp-msca', action: 'send', amount: request.amount, token, source: 'msca', to: request.to,
      details: JSON.stringify({ quoteType: 'msca_send', chainKey, walletAddress: req.msca.walletAddress, expiresAt }),
      forcePending: true,
    })
    res.json({
      status: 'quote', preview: true, previewId: approval.id, expiresAt: new Date(expiresAt).toISOString(),
      action: 'send', source: 'msca', walletAddress: req.msca.walletAddress, walletType: 'MSCA',
      fromChain: chainKey, to: request.to, amount: request.amount, token,
      balance: formatUnits(balance, decimals), supported, platformFee: '0', recipientReceives: request.amount,
      approvalRequired: true, confirmationText: 'yes',
      safeNextStep: 'Show this preview and execute only after the user explicitly replies yes or ya.',
    })
  } catch (error) {
    res.status(400).json({ error: error?.message || 'MSCA send quote failed' })
  }
})

router.post('/send', requireMsca, async (req, res) => {
  let approval
  try {
    if (req.body?.confirmed !== true || !['yes', 'ya'].includes(String(req.body?.confirmationText || '').trim().toLowerCase())) {
      return res.status(400).json({ error: 'Explicit confirmation yes/ya is required after the MSCA send preview' })
    }
    const token = String(req.body?.token || 'USDC').trim().toUpperCase()
    const chainKey = normalizeChain(req.body?.fromChain || req.body?.chain)
    const request = validateRequest({ to: req.body?.to, amount: req.body?.amount, token, chainKey })
    approval = listApprovals(req.owner).find(item => item.id === String(req.body?.previewId || ''))
    if (!approval || approval.action !== 'send' || approval.source !== 'msca' || approval.status !== 'pending') return res.status(409).json({ error: 'MSCA send preview is missing, expired, already used, or not owned by this wallet' })
    let details
    try { details = JSON.parse(approval.details || '{}') } catch { details = null }
    if (!details || details.quoteType !== 'msca_send' || Date.now() > Number(details.expiresAt || 0) || details.chainKey !== chainKey || details.walletAddress.toLowerCase() !== req.msca.walletAddress.toLowerCase() || approval.to.toLowerCase() !== request.to.toLowerCase() || approval.amount !== request.amount || approval.token.toUpperCase() !== token) {
      return res.status(409).json({ error: 'MSCA send parameters differ from the original preview; re-quote before executing' })
    }
    updateApprovalStatus(req.owner, approval.id, 'pending_confirmation')
    const result = await sendViaSession(req.owner, request.to, request.amount, token, { chainKey })
    if (result.status !== 'success') {
      updateApprovalStatus(req.owner, approval.id, 'error', { error: result.reason || 'MSCA send failed', userOpHash: result.userOpHash })
      return res.status(409).json({ status: 'error', executed: false, error: result.reason || 'MSCA send failed', userOpHash: result.userOpHash || null })
    }
    updateApprovalStatus(req.owner, approval.id, 'success', { txHash: result.txHash, explorerUrl: result.explorerUrl })
    return res.json({ status: 'executed', executed: true, action: 'send', source: 'msca', walletAddress: req.msca.walletAddress, walletType: 'MSCA', fromChain: chainKey, to: request.to, amount: request.amount, token, txHash: result.txHash, explorerUrl: result.explorerUrl, previewId: approval.id })
  } catch (error) {
    if (approval?.id) updateApprovalStatus(req.owner, approval.id, 'error', { error: error?.message || 'MSCA send failed' })
    return res.status(error?.status || 400).json({ status: 'error', executed: false, error: error?.message || 'MSCA send failed' })
  }
})

export default router
