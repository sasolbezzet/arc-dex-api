// Remote HTTP MCP Server for ChatGPT / Claude
// Streamable HTTP transport + OAuth 2.1 with SIWE wallet auth
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, createHash } from 'crypto'
import { z } from 'zod'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'

// ── In-memory session store (production: use Redis) ──
const sessions = new Map() // sessionId -> { transport, server }
const executionQuotes = new Map() // previewId -> { userId, action, params, expires }
const authCodes = new Map() // code -> { clientId, userId, redirectUri, codeChallenge, expires }
const accessTokens = new Map() // token -> { userId, clientId, expires }

const SERVER_URL = process.env.SERVER_URL || 'https://arcoxdex.vercel.app'
const TOKEN_TTL = 3600 * 24 // 24 hours
const OAUTH_PATH = process.env.OAUTH_PATH || './data/oauth-clients.json'
const OAUTH_TOKENS_PATH = process.env.OAUTH_TOKENS_PATH || './data/oauth-tokens.json'

// ── Persistent OAuth client store ──
import { readJsonFile, atomicWriteJsonFile } from './jsonFileStore.mjs'

function loadClients() {
  const d = readJsonFile(OAUTH_PATH, { clients: {} })
  return new Map(Object.entries(d.clients || {}))
}
function saveClients(map) {
  const obj = Object.fromEntries(map)
  atomicWriteJsonFile(OAUTH_PATH, { clients: obj })
}

const oauthClients = loadClients()

function loadTokens() {
  const d = readJsonFile(OAUTH_TOKENS_PATH, { tokens: {} })
  return new Map(Object.entries(d.tokens || {}))
}
function saveTokens() {
  atomicWriteJsonFile(OAUTH_TOKENS_PATH, { tokens: Object.fromEntries(accessTokens) })
}
for (const [token, auth] of loadTokens()) {
  if (auth?.expires > Date.now()) accessTokens.set(token, auth)
}

// ── OAuth helpers ──
export function registerOAuthClient({ clientName, redirectUris = [] }) {
  const clientId = 'arcox_' + randomUUID().slice(0, 12)
  const clientSecret = randomUUID()
  oauthClients.set(clientId, { clientSecret, redirectUris, clientName })
  saveClients(oauthClients)
  return { clientId, clientSecret, clientName, redirectUris }
}

export function createAuthCode(clientId, userId, { redirectUri, codeChallenge } = {}) {
  const code = randomUUID()
  authCodes.set(code, { clientId, userId, redirectUri, codeChallenge, expires: Date.now() + 600000 }) // 10 min
  return code
}

export function exchangeCodeForToken(code, clientId, clientSecret, redirectUri, codeVerifier) {
  const auth = authCodes.get(code)
  if (!auth) return { error: 'invalid_grant', error_description: 'Invalid authorization code' }
  if (Date.now() > auth.expires) return { error: 'invalid_grant', error_description: 'Code expired' }
  if (auth.clientId !== clientId) return { error: 'invalid_grant', error_description: 'client_id mismatch' }
  if (!redirectUri || auth.redirectUri !== redirectUri) return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }
  if (!auth.codeChallenge || !codeVerifier || createHash('sha256').update(codeVerifier).digest('base64url') !== auth.codeChallenge) {
    return { error: 'invalid_grant', error_description: 'PKCE verification failed' }
  }
  const client = oauthClients.get(clientId)
  if (!client) return { error: 'invalid_client', error_description: 'Unknown client_id' }
  // If client registered with token_endpoint_auth_method=none, skip secret check
  if (clientSecret !== undefined && clientSecret !== '') {
    if (client.clientSecret !== clientSecret) return { error: 'invalid_client', error_description: 'Invalid client_secret' }
  }
  authCodes.delete(code)
  const token = 'arx_at_' + randomUUID().replace(/-/g, '')
  accessTokens.set(token, { userId: auth.userId, clientId, expires: Date.now() + TOKEN_TTL * 1000 })
  saveTokens()
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL,
    scope: 'mcp:tools',
  }
}

export function validateAccessToken(token) {
  const auth = accessTokens.get(token)
  if (!auth) return null
  if (Date.now() > auth.expires) {
    accessTokens.delete(token)
    saveTokens()
    return null
  }
  return auth
}

// Periodic sweep of expired auth codes + access tokens so these maps can't grow
// unbounded and contribute to gradual memory pressure / OOM kills.
const _authSweep = setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const [code, v] of authCodes) if (now > v.expires) authCodes.delete(code)
  for (const [tok, v] of accessTokens) if (now > v.expires) { accessTokens.delete(tok); changed = true }
  if (changed) saveTokens()
}, 10 * 60 * 1000)
if (_authSweep.unref) _authSweep.unref()

// Map an OAuth clientId to a normalized agent name (contains 'claude' or
// 'chatgpt' so the frontend StatusDot matching works). Falls back to the
// registered client name, then to a generic label.
export function resolveAgentName(clientId) {
  const client = oauthClients.get(clientId)
  const name = (client?.clientName || '').toLowerCase()
  if (name.includes('claude')) return 'claude-mcp'
  if (name.includes('chatgpt') || name.includes('openai') || name.includes('gpt')) return 'chatgpt-mcp'
  // Unknown client — return the registered name if any, else generic.
  return client?.clientName || 'mcp-agent'
}

// ── OAuth metadata endpoints ──
export function oauthMetadataHandler(req, res) {
  res.json({
    issuer: SERVER_URL,
    authorization_endpoint: `${SERVER_URL}/api/auth/authorize`,
    token_endpoint: `${SERVER_URL}/api/auth/token`,
    registration_endpoint: `${SERVER_URL}/api/auth/register`,
    jwks_uri: `${SERVER_URL}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:tools'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['none'],
  })
}

// ── Protected resource metadata (RFC 9728) ──
// The MCP resource server is the /mcp endpoint. Per RFC 9728 §3.1 the well-known
// document lives at /.well-known/oauth-protected-resource[/<resource-path>].
// We serve both the root and the /mcp-suffixed variant so Claude/ChatGPT can
// discover it regardless of how they compute the metadata URL.
const MCP_RESOURCE_URL = `${SERVER_URL}/mcp`

export function protectedResourceHandler(req, res) {
  res.json({
    resource: MCP_RESOURCE_URL,
    authorization_servers: [SERVER_URL],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:tools'],
  })
}

// ── OAuth Authorize endpoint ──
// GET /api/auth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...&code_challenge=...
export function oauthAuthorizeHandler(req, res) {
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query
  if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' })
  const client = oauthClients.get(client_id)
  if (!client) return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' })

  // Redirect to frontend Plugin page with OAuth params
  // Frontend handles SIWE login + approval, then redirects back to ChatGPT
  const params = new URLSearchParams({
    auth: 'mcp',
    client_id,
    redirect_uri,
    state: state || '',
    code_challenge: code_challenge || '',
  })
  res.redirect(302, `${SERVER_URL}/arc-dex/plugin?${params.toString()}`)
}

// ── SIWE message generation ──
export function siweMessageHandler(req, res) {
  const { address, client_id } = req.query
  if (!address) return res.status(400).json({ error: 'address required' })
  const domain = req.headers.host || 'arcoxdex.vercel.app'
  const nonce = randomUUID().slice(0, 8)
  const message = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nAuthorize ARCOX MCP Server\n\nURI: ${SERVER_URL}\nVersion: 1\nChain ID: 5042002\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`
  res.json({ message, nonce })
}

// ── SIWE verify + issue auth code ──
import { verifyMessage } from 'viem'
export async function siweVerifyHandler(req, res) {
  const { address, message, signature, clientId, redirectUri, state, codeChallenge } = req.body || {}
  if (!address || !message || !clientId) return res.status(400).json({ error: 'missing fields' })
  
  if (!redirectUri || !codeChallenge) return res.status(400).json({ error: 'missing_pkce_or_redirect_uri' })
  const client = oauthClients.get(clientId)
  if (!client || !client.redirectUris.includes(redirectUri)) return res.status(400).json({ error: 'invalid_redirect_uri' })
  try {
    const valid = await verifyMessage({ address, message, signature })
    if (!valid) return res.status(401).json({ error: 'invalid_signature' })
  } catch {
    return res.status(401).json({ error: 'signature_verification_failed' })
  }
  
  const userId = address.toLowerCase()
  const code = createAuthCode(clientId, userId, { redirectUri, codeChallenge })
  const redirect = `${redirectUri}?code=${code}&state=${state || ''}`
  res.json({ redirect })
}

// ── Token endpoint ──
export function oauthTokenHandler(req, res) {
  const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier } = req.body || {}
  if (grant_type === 'authorization_code') {
    const result = exchangeCodeForToken(code, client_id, client_secret, redirect_uri, code_verifier)
    if (result.error) return res.status(400).json(result)
    return res.json(result)
  }
  // refresh_token not implemented yet
  res.status(400).json({ error: 'unsupported_grant_type' })
}

// ── Dynamic Client Registration ──
export function oauthRegisterHandler(req, res) {
  const { client_name, redirect_uris = [], grant_types = ['authorization_code'], response_types = ['code'], token_endpoint_auth_method = 'none' } = req.body || {}
  const client = registerOAuthClient({ clientName: client_name || 'mcp-client', redirectUris: redirect_uris })
  res.status(201).json({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: grant_types,
    response_types: response_types,
    token_endpoint_auth_method: token_endpoint_auth_method,
  })
}

// ── Bearer token extraction ──
function extractBearer(req) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth.slice(7)
}

// ── Backend API helper ──
const BACKEND_URL = process.env.ARCOX_BACKEND_URL || 'http://localhost:3001'

import { mintOwnerToken } from './authToken.mjs'

// The MCP userId IS the SIWE-verified wallet address. Mint a backend auth token
// for it so the protected money endpoints (requireAuth) accept read-only quote
// calls. This does NOT move funds — execute tools still go through vault approval.
async function apiGet(path, ownerAddress) {
  const bearer = mintOwnerToken(ownerAddress)
  const r = await fetch(`${BACKEND_URL}${path}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  })
  return r.json()
}

async function apiPost(path, body, ownerAddress) {
  const bearer = mintOwnerToken(ownerAddress)
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  })
  return r.json()
}

// ── Auto-execute helper (Circle-source, server-signed) ──
// Map MCP chain slugs → backend CCTP keys.
const CHAIN_SLUG_TO_KEY = {
  'arc-testnet': 'Arc_Testnet', 'arc': 'Arc_Testnet', 'arc_testnet': 'Arc_Testnet',
  'ethereum-sepolia': 'Ethereum_Sepolia', 'eth-sepolia': 'Ethereum_Sepolia', 'ethereum_sepolia': 'Ethereum_Sepolia',
  'base-sepolia': 'Base_Sepolia', 'base_sepolia': 'Base_Sepolia',
  'arbitrum-sepolia': 'Arbitrum_Sepolia', 'arbitrum_sepolia': 'Arbitrum_Sepolia',
  'hyperevm-testnet': 'HyperEVM_Testnet', 'hyperevm_testnet': 'HyperEVM_Testnet',
}
function chainKey(slug) {
  if (!slug) return undefined
  const s = String(slug).toLowerCase().trim()
  return CHAIN_SLUG_TO_KEY[s] || slug
}

// Decide whether an agent-initiated action can auto-execute server-side.
// MCP server is MSCA-ONLY: only session-key (MSCA) auto-executes. Circle proxy
// wallet and EOA are explicitly NOT available to remote ChatGPT/Claude, per
// security policy (remote agents must only use the locked passkey MSCA).
async function canAutoExecute(userId, source, amount) {
  if (source !== 'session') {
    return { ok: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Circle proxy dan EOA tidak diizinkan untuk agent remote.' }
  }
  try {
    const { canExecuteViaSession } = await import('./sessionKeyService.mjs')
    const gate = canExecuteViaSession(userId, amount)
    return gate
  } catch { return { ok: false, reason: 'session_error' } }
}

// Record an auto-executed action into the vault as an approved entry (for the
// Plugin history + audit trail), with the on-chain txHash.
async function recordAutoExec(userId, { agent, action, amount, token, source, to, details, txHash, explorerUrl }) {
  const vault = await import('./vaultStore.mjs')
  const approval = vault.createApproval(userId, { agent, action, amount, token, source, to, details, forcePending: true })
  vault.approveRequest(userId, approval.id, { txHash, explorerUrl })
  return approval
}

// Best-effort current agent label for a user, from the most recent MCP session.
function resolveAgentForUser(userId) {
  try {
    const list = mcpSessionsRef?.(userId) || []
    const active = list.filter(s => s.active !== false).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
    return active[0]?.agent || 'mcp-agent'
  } catch { return 'mcp-agent' }
}
let mcpSessionsRef = null

function createExecutionQuote(userId, action, params) {
  const previewId = `quote_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const quote = { previewId, userId, action, params, walletAddress: params.walletAddress || '', expires: Date.now() + 5 * 60 * 1000 }
  executionQuotes.set(previewId, quote)
  return quote
}

function consumeExecutionQuote(userId, action, previewId, params) {
  const quote = executionQuotes.get(String(previewId || ''))
  if (!quote || quote.userId !== userId || quote.action !== action || Date.now() > quote.expires) return { ok: false, reason: 'invalid_or_expired_quote' }
  const fields = ['to', 'amount', 'token', 'tokenIn', 'tokenOut', 'amountIn', 'walletAddress']
  for (const field of fields) {
    if (quote.params[field] !== undefined && String(quote.params[field]) !== String(params[field])) return { ok: false, reason: 'quote_parameters_mismatch' }
  }
  executionQuotes.delete(quote.previewId)
  return { ok: true, quote }
}

// ── x402 via MSCA (session key) ──
// Arc Memo must be called directly by an EOA. An ERC-4337 MSCA therefore pays
// x402 with a plain USDC transfer from the MSCA. The invoice is bound to the
// exact MSCA payer and reconciled from the resulting Transfer event.
import { encodeFunctionData, getAddress } from 'viem'

const X402_ARC_USDC = process.env.X402_USDC_ADDRESS || '0x3600000000000000000000000000000000000000'
const X402_TRANSFER_ABI = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }]
const X402_APPROVE_ABI = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }]
const ADAPTER_EXECUTE_ABI = [{
  type: 'function', name: 'execute', stateMutability: 'payable',
  inputs: [
    { name: 'params', type: 'tuple', components: [
      { name: 'instructions', type: 'tuple[]', components: [
        { name: 'target', type: 'address' }, { name: 'data', type: 'bytes' }, { name: 'value', type: 'uint256' },
        { name: 'tokenIn', type: 'address' }, { name: 'amountToApprove', type: 'uint256' }, { name: 'tokenOut', type: 'address' }, { name: 'minTokenOut', type: 'uint256' },
      ] },
      { name: 'tokens', type: 'tuple[]', components: [{ name: 'token', type: 'address' }, { name: 'beneficiary', type: 'address' }] },
      { name: 'execId', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'metadata', type: 'bytes' },
    ] },
    { name: 'tokenInputs', type: 'tuple[]', components: [
      { name: 'permitType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'permitCalldata', type: 'bytes' },
    ] },
    { name: 'signature', type: 'bytes' },
  ], outputs: [],
}]

function normalizePreparedExecution(params) {
  if (!params || !Array.isArray(params.instructions) || params.execId === undefined || params.deadline === undefined) return null
  return {
    instructions: params.instructions.map(instruction => ({
      ...instruction,
      value: BigInt(instruction.value || 0),
      amountToApprove: BigInt(instruction.amountToApprove || 0),
      minTokenOut: BigInt(instruction.minTokenOut || 0),
    })),
    tokens: params.tokens || [],
    execId: BigInt(params.execId),
    deadline: BigInt(params.deadline),
    metadata: params.metadata || '0x',
  }
}

function buildPreparedSwapCalls(prepared, expected = {}) {
  const allowedAdapter = String(process.env.ARCOX_SWAP_ADAPTER || '').toLowerCase()
  // Never execute opaque adapter calldata without an explicit production
  // allowlist. This keeps MCP swaps fail-closed until the deployment config
  // names the exact audited adapter contract.
  if (!allowedAdapter || !prepared?.adapterContract || !Array.isArray(prepared.legs) || prepared.legs.length === 0) return null
  if (String(prepared.adapterContract).toLowerCase() !== allowedAdapter) return null
  if (expected.tokenIn && String(prepared.tokenIn || '').toUpperCase() !== String(expected.tokenIn).toUpperCase()) return null
  if (expected.tokenOut && String(prepared.tokenOut || '').toUpperCase() !== String(expected.tokenOut).toUpperCase()) return null
  for (const leg of prepared.legs) {
    if (!leg?.executionParams || !leg.signature || !leg.tokenInAddress || !leg.amountBaseUnits) return null
    const executionParams = normalizePreparedExecution(leg.executionParams)
    if (!executionParams) return null
    const amount = BigInt(leg.amountBaseUnits)
    calls.push({
      to: getAddress(leg.tokenInAddress),
      value: 0n,
      data: encodeFunctionData({ abi: X402_APPROVE_ABI, functionName: 'approve', args: [getAddress(prepared.adapterContract), amount] }),
    })
    calls.push({
      to: getAddress(prepared.adapterContract),
      value: 0n,
      data: encodeFunctionData({
        abi: ADAPTER_EXECUTE_ABI,
        functionName: 'execute',
        args: [executionParams, [{ permitType: 0, token: getAddress(leg.tokenInAddress), amount, permitCalldata: '0x' }], leg.signature],
      }),
    })
  }
  return calls
}

async function getX402Invoice(invoiceId) {
  const r = await fetch(`${BACKEND_URL}/api/x402/invoices/${encodeURIComponent(invoiceId)}/status`)
  if (!r.ok) return null
  const data = await r.json()
  return data?.x402 || data?.invoice || null
}

function invoiceAmountUnits(invoice) {
  const raw = invoice?.amountBaseUnits
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw)
  if (typeof raw === 'bigint') return raw
  const value = String(invoice?.uniqueAmount || invoice?.amount || '')
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error('Jumlah invoice x402 tidak valid')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
}

async function unlockX402Resource(userId, invoice) {
  const resourcePath = String(invoice.resource || '')
  if (!resourcePath.startsWith('/api/')) return null
  if (!invoice.paymentId) return null
  try {
    const r = await fetch(`${BACKEND_URL}${resourcePath}`, {
      headers: {
        Authorization: `Bearer ${mintOwnerToken(userId)}`,
        'X-Payment-Id': invoice.paymentId,
        ...(invoice.ownerWallet ? { 'X-Arcox-Owner': invoice.ownerWallet } : {}),
      },
    })
    if (!r.ok) return null
    const data = await r.json()
    return data
  } catch { return null }
}

// Estimate amount + build memo calldata. Preview only — no funds moved.
async function previewX402Pay(userId, invoiceId) {
  let invoice = await getX402Invoice(invoiceId)
  if (!invoice) throw new Error('x402 invoice not found')
  if (invoice.status === 'paid') {
    const unlocked = await unlockX402Resource(userId, invoice)
    return { status: 'paid', invoice, alreadyPaid: true, unlockedResult: unlocked }
  }
  if (invoice.status === 'expired') {
    return { status: 'expired', requiresNewInvoice: true, invoice }
  }
  if (invoice.asset !== 'USDC') throw new Error('Hanya invoice USDC yang didukung x402.')
  const { getSessionKeyInfo } = await import('./vaultStore.mjs')
  const info = await getSessionKeyInfo(userId)
  if (!info || !info.active) {
    return { status: 'session_required', message: 'Session key MSCA belum aktif. User harus setup Agent Wallet + session key dulu di Plugin page.' }
  }
  return {      status: 'preview',
      requiresUserConfirmation: true,
      invoice,
      payer: info.walletAddress,
      payerMatchesInvoice: String(invoice.ownerWallet || '').toLowerCase() === String(info.walletAddress || '').toLowerCase(),

    amount: invoice.uniqueAmount,
    token: 'USDC',
    recipient: invoice.recipient,
    paymentMethod: invoice.paymentMethod || 'arc-usdc-direct',
    instruction: `Konfirmasi untuk membayar ${invoice.uniqueAmount} USDC langsung dari Agent Wallet (MSCA ${info.walletAddress}) ke ${invoice.recipient} untuk ${invoice.invoiceId}. Pembayaran MSCA tidak menggunakan Arc Memo.`,
  }
}

// Execute a confirmed x402 payment from the MSCA. Moves funds.
async function executeX402Pay(userId, invoiceId) {
  const invoice = await getX402Invoice(invoiceId)
  if (!invoice) throw new Error('x402 invoice not found')
  if (invoice.status === 'paid') {
    const unlocked = await unlockX402Resource(userId, invoice)
    return { status: 'paid', invoice, alreadyPaid: true, unlockedResult: unlocked }
  }
  if (invoice.asset !== 'USDC') throw new Error('Hanya invoice USDC yang didukung x402.')
  if (!invoice.recipient || !/^0x[0-9a-fA-F]{40}$/.test(invoice.recipient)) throw new Error('x402 recipient is not configured')
  const info = await (await import('./vaultStore.mjs')).getSessionKeyInfo(userId)
  if (!info?.active || info.walletAddress?.toLowerCase() !== String(invoice.ownerWallet || '').toLowerCase()) {
    throw new Error('x402 invoice payer does not match the active MSCA')
  }
  const amountUnits = invoiceAmountUnits(invoice)

  const { executeViaSession } = await import('./sessionKeyService.mjs')
  const result = await executeViaSession(userId, [{
    to: X402_ARC_USDC,
    abi: X402_TRANSFER_ABI,
    functionName: 'transfer',
    args: [getAddress(invoice.recipient), amountUnits],
  }], { paymaster: true, chainKey: 'arc-testnet' })

  if (result.status !== 'success') {
    return { status: result.status, executed: false, error: result.reason || 'x402 payment via MSCA gagal', userOpHash: result.userOpHash }
  }

  let latest = invoice
  for (let i = 0; i < 20; i++) {
    const next = await getX402Invoice(invoiceId)
    if (!next) break
    latest = next
    if (latest.status === 'paid' || latest.status === 'expired') break
    await new Promise(res => setTimeout(res, 2000))
  }
  const unlocked = (latest.status === 'paid')
    ? await unlockX402Resource(userId, latest).catch(() => null)
    : null
  return {
    status: latest.status === 'paid' ? 'paid' : 'settlement_pending',
    invoice: latest,
    txHash: result.txHash,
    explorerUrl: result.explorerUrl,
    paymentMethod: 'arc-usdc-direct',
    unlockedResult: unlocked,
  }
}



// ── MCP Server factory ──
export function createMcpServer(userId) {
  const server = new McpServer({
    name: 'arcox-mcp',
    version: '1.0.0',
  })

  // ── READ-ONLY TOOLS ──

  server.tool('arcox_wallet_balances', 'Show Agent Wallet (MSCA) balances on Arc', {}, async () => {
    const data = await apiGet(`/api/balance/${userId}`, userId)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  })

  server.tool('arcox_transaction_history', 'Check transaction history and auto-mint worker status', {}, async () => {
    const data = await apiGet(`/api/tx-history?address=${userId}`, userId)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  })

  server.tool('arcox_route_status', 'Check if a swap/bridge/send route is supported', {
    action: z.string().describe('swap, bridge, or send'),
    fromChain: z.string().optional().describe('Source chain'),
    toChain: z.string().optional().describe('Destination chain'),
    token: z.string().optional().describe('Token symbol (USDC, EURC, cirBTC)'),
    source: z.string().optional().describe('session (MSCA)'),
  }, async (params) => {
    // Return supported routes info
    return { content: [{ type: 'text', text: JSON.stringify({
      supported: true,
      action: params.action,
      chains: { 'arc-testnet': 5042002, 'ethereum-sepolia': 11155111, 'base-sepolia': 84532, 'arbitrum-sepolia': 421614, 'solana-devnet': 'solana' },
      tokens: ['USDC', 'EURC', 'cirBTC'],
      sources: ['session'],
      note: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Call arcox_quote_swap or arcox_quote_bridge for a preview.',
    }) }] }
  })

  // ── SWAP TOOLS (quote → confirm → execute) ──

  server.tool('arcox_quote_swap', 'Get a swap quote preview. Show preview to user, wait for confirmation, then call arcox_execute_swap', {
    tokenIn: z.string().describe('Input token symbol (USDC, EURC, cirBTC)'),
    tokenOut: z.string().describe('Output token symbol'),
    amountIn: z.string().describe('Amount in human readable (e.g. "1")'),
    source: z.string().optional().describe('session (MSCA)'),
  }, async (params) => {
    const src = params.source || 'session'
    if (src !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote swap hanya untuk source=session.' }) }] }
    }
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const session = await getSessionKeyInfo(userId)
    if (!session?.active || !session.walletAddress) {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'no_session', message: 'Session key MSCA belum aktif.' }) }] }
    }
    const quoteData = await apiPost('/api/eoa-swap-quote', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, metamaskAddress: session.walletAddress }, session.walletAddress)
    if (!quoteData?.available && quoteData?.success === false) {
      return { content: [{ type: 'text', text: JSON.stringify(quoteData) }] }
    }
    // Prepare immutable calldata at preview time. Execution must use this exact
    // payload, not re-quote later with potentially different routing/slippage.
    const prepared = await apiPost('/api/eoa-swap-prepare', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, metamaskAddress: session.walletAddress }, session.walletAddress)
    const quote = createExecutionQuote(userId, 'swap', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, walletAddress: session.walletAddress, quote: quoteData, prepared })
    return { content: [{ type: 'text', text: JSON.stringify({ ...quoteData, previewId: quote.previewId, expiresAt: new Date(quote.expires).toISOString(), source: 'session', walletAddress: session.walletAddress, prepared: { source: prepared.source, route: prepared.route, amountOut: prepared.amountOut } }) }] }
  })

  server.tool('arcox_execute_swap', 'Execute a confirmed swap via Agent Wallet (MSCA/session key). Requires previewId from arcox_quote_swap and user confirmation.', {
    tokenIn: z.string().describe('Input token symbol'),
    tokenOut: z.string().describe('Output token symbol'),
    amountIn: z.string().describe('Exact amount from quote'),
    source: z.string().optional().describe('session (MSCA)'),
    previewId: z.string().describe('Preview ID from arcox_quote_swap'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Ask user to confirm first.' }) }] }
    const source = params.source || 'session'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Parameter source harus "session".' }) }] }
    }
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const activeSession = await getSessionKeyInfo(userId)
    const quoteCheck = consumeExecutionQuote(userId, 'swap', params.previewId, {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      walletAddress: activeSession?.walletAddress || '',
    })
    if (!quoteCheck.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
    const gate = await canAutoExecute(userId, source, params.amountIn)
    if (!gate.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: gate.reason, message: gate.reason === 'no_session' ? 'Session key MSCA belum diaktifkan. User harus setup Agent Wallet (MSCA) + session key di Plugin page.' : gate.message }) }] }
    }
    try {
      const preparedPayload = quoteCheck.quote.params.prepared
      if (!preparedPayload || preparedPayload.source !== 'stablecoin-service' || !preparedPayload.adapterContract) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'swap_route_not_supported_for_msca', message: 'Route ini belum aman untuk eksekusi MSCA.' }) }] }
      }
        const preparedCalls = buildPreparedSwapCalls(preparedPayload, { tokenIn: params.tokenIn, tokenOut: params.tokenOut })
      if (!preparedCalls) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'swap_calldata_unavailable', message: 'Quote swap ini belum menghasilkan calldata MSCA yang aman untuk dieksekusi.' }) }] }
      }
      const { swapViaSession } = await import('./sessionKeyService.mjs')
      const result = await swapViaSession(userId, { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, preparedCalls, chainKey: 'arc-testnet' })
      if (result.status === 'success') {
        await recordAutoExec(userId, {
          agent: resolveAgentForUser(userId), action: 'swap', amount: params.amountIn, token: params.tokenIn,
          source: 'session', details: JSON.stringify({ tokenOut: params.tokenOut, previewId: params.previewId }),
          txHash: result.txHash, explorerUrl: result.explorerUrl,
        })
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'executed', executed: true, txHash: result.txHash, explorerUrl: result.explorerUrl, message: `Swap ${params.amountIn} ${params.tokenIn} → ${params.tokenOut} berhasil via MSCA (session key).` }) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'session_failed', executed: false, error: result.reason || 'Session swap gagal' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'session_error', executed: false, error: e?.message || 'Session error' }) }] }
    }
  })

  // ── BRIDGE TOOLS (route → quote → confirm → execute) ──

  server.tool('arcox_quote_bridge', 'Get a bridge quote preview. Show preview to user, wait for confirmation, then call arcox_execute_bridge', {
    fromChain: z.string().describe('Source chain (arc-testnet, ethereum-sepolia, base-sepolia, arbitrum-sepolia, solana-devnet)'),
    toChain: z.string().describe('Destination chain'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol. Default USDC'),
    source: z.string().optional().describe('session (MSCA)'),
  }, async (params) => {
    // CCTP bridge via Agent Wallet (MSCA). Quote is informational; actual CCTP
    // completion through MSCA menunggu implementasi bridgeViaSession.
    const token = params.token || 'USDC'
    const src = params.source || 'session'
    if (src !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote bridge hanya untuk source=session.' }) }] }
    }
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const info = await getSessionKeyInfo(userId)
    const wallet = info?.active ? info.walletAddress : null
    return { content: [{ type: 'text', text: JSON.stringify({
      preview: true,
      route: `${params.fromChain} → ${params.toChain}`,
      amountIn: params.amount,
      token,
      source: 'session',
      destinationWallet: wallet,
      estimatedReceive: `~${params.amount} ${token}`,
      note: wallet ? 'MSCA → MSCA (destination = Agent Wallet yang sama).' : 'Eksekusi bridge MSCA belum tersedia; rute hanya bisa di-quote. Setup Agent Wallet + session key dulu di Plugin page.',
      previewId: `bridge_${Date.now()}`,
      safeNextStep: 'Tampilkan preview ini ke user. Catatan: eksekusi bridge MSCA menunggu implementasi CCTP via Agent Wallet diverifikasi.',
    }) }] }
  })

  server.tool('arcox_execute_bridge', 'Execute a confirmed bridge via Agent Wallet (MSCA/session key). Requires previewId from arcox_quote_bridge and user confirmation.', {
    fromChain: z.string().describe('Source chain'),
    toChain: z.string().describe('Destination chain'),
    amount: z.string().describe('Exact amount from quote'),
    token: z.string().optional().describe('Token symbol'),
    source: z.string().optional().describe('session (MSCA)'),
    previewId: z.string().describe('Preview ID from arcox_quote_bridge'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Ask user to confirm first.' }) }] }
    const source = params.source || 'session'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Circle proxy dan EOA tidak diizinkan untuk agent remote.' }) }] }
    }
    // MSCA bridge belum diimplementasikan (bridgeViaSession belum ada; CCTP
    // through MSCA belum terbukti end-to-end). JANGAN fallback ke Circle proxy
    // atau approval EOA — tolak jelas sampai jalur MSCA→MSCA selesai.
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'bridge_msca_unavailable', message: 'Bridge via Agent Wallet (MSCA) belum tersedia. Rute hanya bisa di-quote dulu; eksekusi bridge MSCA menunggu implementasi CCTP melalui MSCA diverifikasi.' }) }] }
  })

  // ── SEND TOOLS (quote → confirm → execute) ──

  server.tool('arcox_quote_send', 'Get a send quote preview. Show preview to user, wait for confirmation, then call arcox_execute_send', {
    to: z.string().describe('Recipient address'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol. Default USDC'),
    source: z.string().optional().describe('session'),
  }, async (params) => {
    const token = params.token || 'USDC'
    const src = params.source || 'session'
    if (src !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote send hanya untuk source=session.' }) }] }
    }
    // MSCA send quote (gas paid via paymaster; 30bps platform fee applies)
    return { content: [{ type: 'text', text: JSON.stringify({
      preview: true,
      action: 'send',
      to: params.to,
      amount: params.amount,
      token,
      source: 'session',
      note: 'Send via Agent Wallet (MSCA/session key): gas dibayar paymaster, 30bps platform fee berlaku.',
      ...(() => { const q = createExecutionQuote(userId, 'send', { to: params.to, amount: params.amount, token }); return { previewId: q.previewId, expiresAt: new Date(q.expires).toISOString() } })(),
      safeNextStep: 'Tampilkan preview ini ke user. Setelah user setuju, panggil arcox_execute_send dengan source=session dan confirmed=true.',
    }) }] }
  })

  server.tool('arcox_execute_send', 'Execute a confirmed send via Agent Wallet (MSCA/session key). Requires previewId from arcox_quote_send and user confirmation.', {
    to: z.string().describe('Recipient address'),
    amount: z.string().describe('Exact amount from quote'),
    token: z.string().optional().describe('Token symbol'),
    source: z.string().optional().describe('session (MSCA)'),
    previewId: z.string().describe('Preview ID from arcox_quote_send'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Ask user to confirm first.' }) }] }
    const source = params.source || 'session'
    const token = params.token || 'USDC'
    const quoteCheck = consumeExecutionQuote(userId, 'send', params.previewId, { to: params.to, amount: params.amount, token })
    if (!quoteCheck.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
    if (source !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Parameter source harus "session".' }) }] }
    }
    const gate = await canAutoExecute(userId, source, params.amount)
    if (!gate.ok) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: gate.reason, message: gate.reason === 'no_session' ? 'Session key MSCA belum diaktifkan. User harus setup Agent Wallet (MSCA) + session key di Plugin page.' : gate.message }) }] }
    }
    try {
      const { sendViaSession } = await import('./sessionKeyService.mjs')
      const result = await sendViaSession(userId, params.to, params.amount, token)
      if (result.status === 'success') {
        await recordAutoExec(userId, {
          agent: resolveAgentForUser(userId), action: 'send', amount: params.amount, token,
          source: 'session', to: params.to, details: JSON.stringify({ previewId: params.previewId }),
          txHash: result.txHash, explorerUrl: result.explorerUrl,
        })
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'executed', executed: true, txHash: result.txHash, explorerUrl: result.explorerUrl, message: `Kirim ${params.amount} ${token} ke ${params.to} berhasil via MSCA (session key).` }) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'session_failed', executed: false, error: result.reason || 'Session send gagal' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'session_error', executed: false, error: e?.message || 'Session error' }) }] }
    }
  })

  // ── VAULT TOOLS ──

  server.tool('arcox_vault_list_credentials', 'List vault credentials for the authenticated user', {}, async () => {
    const { listCredentials } = await import('./vaultStore.mjs')
    const creds = listCredentials(userId)
    return { content: [{ type: 'text', text: JSON.stringify({ credentials: creds }) }] }
  })

  server.tool('arcox_vault_request_approval', 'Request user approval for a transaction. Agent calls this before executing value-moving actions', {
    action: z.string().describe('swap, bridge, send'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol (USDC, EURC, etc)'),
    source: z.string().optional().describe('session (MSCA)'),
    to: z.string().optional().describe('Destination address'),
  }, async (params) => {
    const { createApproval } = await import('./vaultStore.mjs')
    const approval = createApproval(userId, { agent: 'chatgpt-mcp', ...params })
    return { content: [{ type: 'text', text: JSON.stringify({ approval }) }] }
  })

  server.tool('arcox_vault_get_limits', 'Get spending limits for the authenticated user', {}, async () => {
    const { getLimits } = await import('./vaultStore.mjs')
    const limits = getLimits(userId)
    return { content: [{ type: 'text', text: JSON.stringify({ limits }) }] }
  })

  // ── INFO TOOL ──

  server.tool('arcox_mcp_info', 'Get ARCOX MCP server info, available services, and execution guide', {}, async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          server: 'arcox-mcp',
          version: '1.1.0',
          url: SERVER_URL,
          userId,
          services: ['wallet_balances', 'swap', 'bridge', 'send', 'intel', 'x402', 'vault', 'transaction_history', 'route_status', 'session_key', 'get_request'],
          sources: {
            session: 'Agent Session Key (MSCA) — passkey-gated setup, gasless, within limits. SATU-SATUNYA sumber untuk agent remote.',
          },
          safety: 'MCP server MSCA-ONLY. Circle proxy dan EOA TIDAK tersedia untuk ChatGPT/Claude. All value-moving actions require quote preview + user confirmation. Flow: quote → show preview → user says ya → execute with previewId + confirmed=true.',
          execution_guide: {
            swap: ['arcox_quote_swap → show preview → user ya → arcox_execute_swap (source=session)'],
            bridge: ['arcox_quote_bridge → show preview → user ya → arcox_execute_bridge. Catatan: eksekusi bridge MSCA belum aktif; hanya quote.'],
            send: ['arcox_quote_send → show preview → user ya → arcox_execute_send (source=session)'],
            intel_x402: ['arcox_intel_get_* → jika paymentRequired → arcox_x402_pay_invoice (tanpa confirmed) preview → user ya → confirmed=true → retry intel tool dengan paymentId yang sama'],
            poll: ['After execute returns pending_* → arcox_get_request(approvalId) → poll until success/error'],
          },
        })
      }]
    }
  })

  // ── SESSION KEY STATUS ──
  server.tool('arcox_session_status', 'Check if Agent Session Key (MSCA) is active for the user. Returns wallet address, delegate address, and whether session signing is available.', {}, async () => {
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const info = await getSessionKeyInfo(userId)
    // Recording connection time here lets auto-detect choose the MSCA this user
    // most recently connected via Claude/agent — no hardcoded wallet.
    if (info && info.active) {
      try {
        const { touchSessionKey } = await import('./sessionKeyService.mjs')
        touchSessionKey(userId)
      } catch { /* non-fatal */ }
    }
    if (!info || !info.active) {
      return { content: [{ type: 'text', text: JSON.stringify({ active: false, message: 'Session key belum diaktifkan. User harus setup di Plugin page (passkey required).' }) }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify({
      active: true,
      walletAddress: info.walletAddress,
      delegateAddress: info.delegateAddress,
      createdAt: info.createdAt,
      message: 'Session key aktif. Agent bisa execute tx langsung dengan source=session.',
    }) }] }
  })

  // ── GET REQUEST (poll approval/tx status) ──
  server.tool('arcox_get_request', 'Poll the status of a previously submitted transaction request. Use after execute returns pending_* status. Returns current lifecycle status + txHash if available.', {
    approvalId: z.string().describe('Approval ID or request ID returned by execute tool'),
  }, async (params) => {
    const { listApprovals } = await import('./vaultStore.mjs')
    const approvals = listApprovals(userId)
    const a = approvals.find(x => x.id === params.approvalId)
    if (!a) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_found', error: 'Approval/request ID not found' }) }] }

    const response = {
      id: a.id,
      status: a.status,
      action: a.action,
      amount: a.amount,
      token: a.token,
      source: a.source,
      txHash: a.txHash || null,
      explorerUrl: a.explorerUrl || null,
      userOpHash: a.userOpHash || null,
      createdAt: a.createdAt,
      approvedAt: a.approvedAt || null,
      completedAt: a.completedAt || null,
      error: a.error || null,
    }

    // If there's a userOpHash and status is pending, try to check on-chain
    if (a.userOpHash && ['pending_signature', 'pending_confirmation'].includes(a.status)) {
      try {
        const { getUserOpStatus } = await import('./sessionKeyService.mjs')
        const liveStatus = await getUserOpStatus(userId, a.userOpHash)
        if (liveStatus.status !== a.status) {
          const { updateApprovalStatus } = await import('./vaultStore.mjs')
          updateApprovalStatus(userId, a.id, liveStatus.status, { txHash: liveStatus.txHash, explorerUrl: liveStatus.explorerUrl })
          response.status = liveStatus.status
          response.txHash = liveStatus.txHash || response.txHash
          response.explorerUrl = liveStatus.explorerUrl || response.explorerUrl
        }
      } catch { /* polling failed, return stored status */ }
    }

    return { content: [{ type: 'text', text: JSON.stringify(response) }] }
  })

  // ── INTEL (x402-paid, read-only, via MSCA payment) ──
  // Endpoint ini return invoice (paymentRequired) saat belum dibayar. Setelah
  // arcox_x402_pay_invoice (MSCA), retry dengan paymentId → unlockedResult.

  const intelTool = (name, desc, pathFromId, schema) => server.tool(name, desc, schema, async (params) => {
    const path = pathFromId(params)
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const sessionInfo = await getSessionKeyInfo(userId)
    const headers = {
      ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken(userId)}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}),
      'X-Payment-Id': params.paymentId || '',
    }
    const r = await fetch(`${BACKEND_URL}/api/intel${path}`, { headers })
    const data = await r.json()
    if (r.status === 402 || data?.paymentRequired) {
      return { content: [{ type: 'text', text: JSON.stringify({ paymentRequired: true, ...data, safeNextStep: 'Invoice x402 dibuat. Call arcox_x402_pay_invoice (tanpa confirmed) untuk preview. Setelah user setuju dan bayar, retry intel tool dengan paymentId yang sama.' }) }] }
    }
    if (data?.unlockedResult) {
      return { content: [{ type: 'text', text: JSON.stringify({ intelPresentation: data.intelPresentation, result: data.unlockedResult, x402Payment: data.x402Payment }) }] }
    }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
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
  intelTool('arcox_intel_get_token', 'Get token intelligence.', p => (p.address ? `/token/${encodeURIComponent(p.chain)}/${encodeURIComponent(p.address)}` : `/token/${encodeURIComponent(p.id)}`), {
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

  server.tool('arcox_x402_pay_invoice', 'Pay an ARCOX x402 invoice from the Agent Wallet (MSCA via session key). Call WITHOUT confirmed to get a preview; show it to user; then call with confirmed=true + previewId + confirmationText.', {
    invoiceId: z.string().describe('ARCOX x402 invoiceId from an Intel tool'),
    confirmed: z.boolean().optional().describe('Must be true to execute payment'),
    confirmationText: z.string().optional().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) {
      try {
        const preview = await previewX402Pay(userId, params.invoiceId)
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'preview', requiresUserConfirmation: true, amount: preview.amount, token: preview.token, recipient: preview.recipient, payer: preview.payer, invoiceId: params.invoiceId, instruction: preview.instruction, safeNextStep: 'Tampilkan preview ini ke user. Setelah user bilang yes/ya, panggil arcox_x402_pay_invoice dengan confirmed=true dan confirmationText.' }) }] }
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: e?.message || 'preview error' }) }] }
      }
    }
    if (String(params.confirmationText || '').trim().toLowerCase() !== 'yes' && String(params.confirmationText || '').trim().toLowerCase() !== 'ya') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'confirmation_required', reason: 'Konfirmasi eksplisit (ya/yes) wajib sebelum bayar x402.' }) }] }
    }
    try {
      const result = await executeX402Pay(userId, params.invoiceId)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', executed: false, error: e?.message || 'x402 payment error' }) }] }
    }
  })

  server.tool('arcox_x402_invoice_status', 'Check status of an ARCO x402 invoice (pending → paid).', {
    invoiceId: z.string().describe('ARCO x402 invoice ID or paymentId'),
  }, async (params) => {
    try {
      const invoice = await getX402Invoice(params.invoiceId)
      if (!invoice) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_found' }) }] }
      return { content: [{ type: 'text', text: JSON.stringify({ status: invoice.status, invoice }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: e?.message || 'status error' }) }] }
    }
  })

  return server
}

// ── Streamable HTTP MCP handler ──
export async function mcpHttpHandler(req, res) {
  // Validate bearer token
  const token = extractBearer(req)
  if (!token) {
    res.setHeader('WWW-Authenticate', `Bearer realm="ARCOX MCP", resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`)
    return res.status(401).json({ error: 'invalid_token', error_description: 'Bearer token required' })
  }
  const auth = validateAccessToken(token)
  if (!auth) {
    res.setHeader('WWW-Authenticate', `Bearer realm="ARCOX MCP", error="invalid_token", resource_metadata="${SERVER_URL}/.well-known/oauth-protected-resource"`)
    return res.status(401).json({ error: 'invalid_token', error_description: 'Token expired or invalid' })
  }

  // Track MCP session for connection status — derive the REAL agent name from
  // the registered OAuth client (Claude vs ChatGPT) instead of hardcoding it, so
  // the Plugin page can show which agent is actually connected.
  const { registerMcpSession, listMcpSessions } = await import('./vaultStore.mjs')
  const agentName = resolveAgentName(auth.clientId)
  registerMcpSession(auth.userId, auth.clientId, agentName)
  mcpSessionsRef = listMcpSessions

  // Handle MCP initialize and tool calls via Streamable HTTP
  const sessionId = req.headers['mcp-session-id'] || randomUUID()
  
  let session = sessions.get(sessionId)
  if (!session) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId })
    const server = createMcpServer(auth.userId)
    await server.connect(transport)
    session = { transport, server }
    sessions.set(sessionId, session)
    
    // Cleanup after 30 min idle
    setTimeout(() => {
      sessions.delete(sessionId)
      try { server.close() } catch {}
    }, 1800000)
  }

  await session.transport.handleRequest(req, res, req.body)
}
