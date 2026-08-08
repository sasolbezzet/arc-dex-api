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
import { createPublicClient, decodeEventLog, defineChain, encodeFunctionData, formatUnits, getAddress, http, parseUnits, verifyMessage } from 'viem'
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

// The MCP userId is the SIWE-verified EOA used only as the tenant/auth identity.
// On-chain reads, quotes, and execution must use the explicitly mapped Agent
// Wallet MSCA returned by the active session key. Never use userId as payer.
export async function resolveActiveMsca(userId) {
  try {
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const info = await getSessionKeyInfo(userId)
    if (!info?.active || !info.walletAddress) return null
    return info
  } catch {
    return null
  }
}

function mscaRequiredResult() {
  return {
    preview: false,
    rejected: true,
    reason: 'no_session',
    message: 'Agent Wallet MSCA/session key belum aktif. Hubungkan atau aktifkan Agent Wallet di Plugin page terlebih dahulu.',
  }
}

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

// CCTP bridge support for the MCP Agent Wallet. The source path is limited to
// Arc Testnet and reuses the verified ArcoxRouter flow used by the frontend and
// local ARCOX MCP. The router sees the MSCA as msg.sender when called inside a
// UserOperation, so the user's EOA is never a payer or signer.
const BRIDGE_CCTP = {
  Arc_Testnet: {
    domain: 26,
    usdc: '0x3600000000000000000000000000000000000000',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    // The same verified ArcoxRouter used by the frontend/local ARCOX MCP.
    router: process.env.ARCOX_FEE_ROUTER_ADDRESS || '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
  },
  Ethereum_Sepolia: { domain: 0, explorer: 'https://sepolia.etherscan.io/tx/' },
  Base_Sepolia: { domain: 6, explorer: 'https://sepolia.basescan.org/tx/' },
  Arbitrum_Sepolia: { domain: 3, explorer: 'https://sepolia.arbiscan.io/tx/' },
  HyperEVM_Testnet: { domain: 19, explorer: 'https://app.hyperliquid-testnet.xyz/explorer/tx/' },
}
// The route is explicit opt-in so a deployment cannot start moving funds just
// because code was updated. Enable it only after the router and destination
// mint relayer have been configured and a small testnet transfer is approved.
const ENABLE_MSCA_CCTP_BRIDGE = process.env.ENABLE_MSCA_CCTP_BRIDGE === 'true'
const ENABLE_SERVER_SIGNED_MINT = process.env.ENABLE_SERVER_SIGNED_MINT === 'true'
const BRIDGE_ZERO_BYTES32 = `0x${'0'.repeat(64)}`
const BRIDGE_MAX_FEE = BigInt(process.env.CCTP_MAX_FEE_BASE_UNITS || '10')
const BRIDGE_MIN_FINALITY_THRESHOLD = Number(process.env.CCTP_MIN_FINALITY_THRESHOLD || '1000')
const BRIDGE_APPROVE_ABI = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}]
const BRIDGE_EVENT_ABI = [{
  type: 'event', name: 'BridgeWithFee', anonymous: false,
  inputs: [
    { name: 'payer', type: 'address', indexed: true },
    { name: 'destinationDomain', type: 'uint32', indexed: true },
    { name: 'mintRecipient', type: 'bytes32', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
  ],
}]
const BRIDGE_ROUTER_ABI = [
  {
    type: 'function', name: 'quoteFee', stateMutability: 'view',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'fee', type: 'uint256' }, { name: 'netAmount', type: 'uint256' }],
  },
  {
    type: 'function', name: 'bridgeUsdcWithFee', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' }, { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' }, { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' }, { name: 'minFinalityThreshold', type: 'uint32' },
    ], outputs: [{ name: 'fee', type: 'uint256' }, { name: 'netAmount', type: 'uint256' }],
  },
]
const ARC_BRIDGE_CHAIN = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network'] } },
})

function bridgeConfig(fromChain, toChain) {
  const source = BRIDGE_CCTP[chainKey(fromChain)]
  const destination = BRIDGE_CCTP[chainKey(toChain)]
  if (!source || !destination || source.domain === destination.domain) return null
  if (!source.router) return null
  return { fromKey: chainKey(fromChain), toKey: chainKey(toChain), source, destination }
}

async function getRouterFeeQuote(route, amount) {
  const client = createPublicClient({ chain: ARC_BRIDGE_CHAIN, transport: http(ARC_BRIDGE_CHAIN.rpcUrls.default.http[0]) })
  const result = await client.readContract({
    address: getAddress(route.source.router),
    abi: BRIDGE_ROUTER_ABI,
    functionName: 'quoteFee',
    args: [amount],
  })
  const fee = BigInt(result?.[0] ?? 0)
  const netAmount = BigInt(result?.[1] ?? 0)
  if (fee < 0n || netAmount <= 0n || netAmount > amount) throw new Error('ArcoxRouter returned an invalid bridge fee quote')
  return { fee, netAmount }
}

// Pure calldata builder shared by execution and regression tests. The router
// pulls the gross amount from msg.sender (the MSCA), sends its platform fee to
// treasury, and burns the remaining netAmount through standard CCTP V2.
export function buildMscaRouterBridgeCalls({ route, amount, mintRecipient, maxFee = BRIDGE_MAX_FEE, minFinalityThreshold = BRIDGE_MIN_FINALITY_THRESHOLD }) {
  if (!route?.source?.router || !route?.source?.usdc || route?.destination?.domain === undefined) throw new Error('Invalid ArcoxRouter bridge route')
  const grossAmount = BigInt(amount)
  if (grossAmount <= 0n) throw new Error('Bridge amount must be positive')
  const recipient = getAddress(mintRecipient)
  const recipientBytes32 = `0x${recipient.slice(2).toLowerCase().padStart(64, '0')}`
  return [
    {
      to: getAddress(route.source.usdc), value: 0n,
      data: encodeFunctionData({ abi: BRIDGE_APPROVE_ABI, functionName: 'approve', args: [getAddress(route.source.router), grossAmount] }),
    },
    {
      to: getAddress(route.source.router), value: 0n,
      data: encodeFunctionData({
        abi: BRIDGE_ROUTER_ABI,
        functionName: 'bridgeUsdcWithFee',
        args: [grossAmount, route.destination.domain, recipientBytes32, BRIDGE_ZERO_BYTES32, BigInt(maxFee), Number(minFinalityThreshold)],
      }),
    },
  ]
}

async function verifyBridgeBurn({ burnTxHash, route, walletAddress, amount }) {
  const client = createPublicClient({ chain: ARC_BRIDGE_CHAIN, transport: http(ARC_BRIDGE_CHAIN.rpcUrls.default.http[0]) })
  const receipt = await client.getTransactionReceipt({ hash: burnTxHash })
  const expectedPayer = getAddress(walletAddress).toLowerCase()
  const expectedAmount = amount === undefined || amount === null ? null : BigInt(amount)
  for (const log of receipt.logs) {
    if (String(log.address).toLowerCase() !== String(route.source.router).toLowerCase()) continue
    try {
      const decoded = decodeEventLog({ abi: BRIDGE_EVENT_ABI, data: log.data, topics: log.topics })
      const args = decoded.args || {}
      const payer = getAddress(args.payer).toLowerCase()
      const recipient = String(args.mintRecipient).toLowerCase()
      const expectedRecipient = `0x${expectedPayer.slice(2).padStart(64, '0')}`
      if (payer !== expectedPayer || Number(args.destinationDomain) !== Number(route.destination.domain) || recipient !== expectedRecipient || (expectedAmount !== null && BigInt(args.amount) !== expectedAmount)) continue
      return { ok: true, receipt, args }
    } catch { /* inspect the next router log */ }
  }
  return { ok: false, reason: 'bridge_burn_proof_mismatch' }
}

function decodeCctpMessageHeader(message) {
  const raw = String(message || '').replace(/^0x/i, '')
  // Circle MessageV2: version/source/destination (uint32), nonce (uint64),
  // sender/recipient/destinationCaller (bytes32), then finality fields.
  if (raw.length < 256) return null
  return {
    version: Number(BigInt(`0x${raw.slice(0, 8)}`)),
    sourceDomain: Number(BigInt(`0x${raw.slice(8, 16)}`)),
    destinationDomain: Number(BigInt(`0x${raw.slice(16, 24)}`)),
    recipient: `0x${raw.slice(104, 168).slice(24)}`.toLowerCase(),
  }
}

async function getCctpBridgeStatus({ burnTxHash, sourceDomain, destinationDomain, walletAddress }) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return { status: 'pending', burnTxHash, verified: false }
    const data = await response.json()
    const message = data?.messages?.[0]
    if (!message) return { status: 'pending', burnTxHash, verified: false }
    const header = decodeCctpMessageHeader(message.message)
    if (!header || header.sourceDomain !== Number(sourceDomain) || header.destinationDomain !== Number(destinationDomain)) {
      return { status: 'rejected', burnTxHash, verified: false, reason: 'cctp_message_route_unverified' }
    }
    const expectedRecipient = String(walletAddress).toLowerCase()
    if (header.recipient !== expectedRecipient) {
      return { status: 'rejected', burnTxHash, verified: false, reason: 'cctp_message_recipient_unverified', messageHeader: header }
    }
    const hasAttestation = Boolean(message.attestation && message.message)
    return {
      status: hasAttestation ? 'attestation_ready' : message.status === 'complete' ? 'attestation_ready' : 'pending',
      burnTxHash,
      verified: hasAttestation,
      walletAddress,
      message: message.message || null,
      attestation: message.attestation || null,
      messageStatus: message.status || 'pending',
      sourceDomain,
      destinationDomain,
      messageHeader: header,
    }
  } catch {
    return { status: 'pending', burnTxHash, verified: false }
  }
}

async function mintDestinationViaBackend({ burnTxHash, fromChain, toChain, walletAddress, amount }) {
  const result = await apiPost('/api/mint-direct', {
    burnTxHash,
    fromChain,
    toChain,
    toAddress: walletAddress,
    amount,
  }, walletAddress)
  if (result?.success !== true || !result.txHash) {
    return { success: false, error: result?.error || 'Destination receiveMessage belum tersedia' }
  }
  return { success: true, txHash: result.txHash, explorerUrl: result.explorerUrl || null }
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

function destinationMintDisabledReason() {
  if (!ENABLE_SERVER_SIGNED_MINT) return 'destination_mint_relayer_not_configured'
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(process.env.OWNER_PRIVATE_KEY || ''))) return 'destination_mint_signer_not_configured'
  if (!String(process.env.AUTH_SECRET || '')) return 'destination_mint_auth_not_configured'
  return null
}

function bridgeConfigDisabledReason(route) {
  if (!ENABLE_MSCA_CCTP_BRIDGE) return 'msca_bridge_disabled_until_router_validation'
  if (!route?.source?.router) return 'bridge_router_not_configured'
  return destinationMintDisabledReason()
}

function validConfirmationText(value) {
  const text = String(value || '').trim().toLowerCase()
  return text === 'yes' || text === 'ya'
}

function inspectExecutionQuote(userId, action, previewId, params) {
  const quote = executionQuotes.get(String(previewId || ''))
  if (!quote || quote.userId !== userId || quote.action !== action || Date.now() > quote.expires) return { ok: false, reason: 'invalid_or_expired_quote' }
  const fields = ['to', 'amount', 'token', 'tokenIn', 'tokenOut', 'amountIn', 'fromChain', 'toChain', 'walletAddress']
  for (const field of fields) {
    if (quote.params[field] !== undefined && String(quote.params[field]) !== String(params[field])) return { ok: false, reason: 'quote_parameters_mismatch' }
  }
  return { ok: true, quote }
}

function consumeExecutionQuote(userId, action, previewId, params) {
  const result = inspectExecutionQuote(userId, action, previewId, params)
  if (result.ok) executionQuotes.delete(result.quote.previewId)
  return result
}

// ── x402 via MSCA (session key) ──
// Arc Memo must be called directly by an EOA. An ERC-4337 MSCA therefore pays
// x402 with a plain USDC transfer from the MSCA. The invoice is bound to the
// exact MSCA payer and reconciled from the resulting Transfer event.
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
  if (!allowedAdapter) return { calls: null, reason: 'adapter_not_allowlisted' }
  if (!prepared?.adapterContract || !Array.isArray(prepared.legs) || prepared.legs.length === 0) return { calls: null, reason: 'prepared_route_incomplete' }
  if (String(prepared.adapterContract).toLowerCase() !== allowedAdapter) return { calls: null, reason: 'adapter_mismatch' }
  if (expected.tokenIn && String(prepared.tokenIn || '').toUpperCase() !== String(expected.tokenIn).toUpperCase()) return { calls: null, reason: 'quote_token_in_mismatch' }
  if (expected.tokenOut && String(prepared.tokenOut || '').toUpperCase() !== String(expected.tokenOut).toUpperCase()) return { calls: null, reason: 'quote_token_out_mismatch' }
  const calls = []
  for (const leg of prepared.legs) {
    if (!leg?.executionParams || !leg.signature || !leg.tokenInAddress || !leg.amountBaseUnits) return { calls: null, reason: 'prepared_leg_incomplete' }
    const executionParams = normalizePreparedExecution(leg.executionParams)
    if (!executionParams) return { calls: null, reason: 'prepared_execution_params_invalid' }
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
  return { calls, reason: null }
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
  const payerMatchesInvoice = String(invoice.ownerWallet || '').toLowerCase() === String(info.walletAddress || '').toLowerCase()
  // Do not present a payment preview that can never be settled by this MSCA.
  // An invoice without an exact owner binding is not safe for an agent quote.
  if (!payerMatchesInvoice) {
    return {
      status: 'rejected',
      requiresUserConfirmation: false,
      reason: 'x402_payer_mismatch',
      payer: info.walletAddress,
      invoiceOwner: invoice.ownerWallet || null,
      message: 'Invoice x402 tidak terikat ke Agent Wallet MSCA yang aktif.',
    }
  }
  return {      status: 'preview',
      requiresUserConfirmation: true,
      invoice,
      payer: info.walletAddress,
      payerMatchesInvoice: true,

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
    const msca = await resolveActiveMsca(userId)
    if (!msca) return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    const data = await apiGet(`/api/balance/${encodeURIComponent(msca.walletAddress)}`, msca.walletAddress)
    return { content: [{ type: 'text', text: JSON.stringify({ ...data, walletAddress: msca.walletAddress, walletType: 'MSCA' }) }] }
  })

  server.tool('arcox_transaction_history', 'Check transaction history and auto-mint worker status', {}, async () => {
    const msca = await resolveActiveMsca(userId)
    if (!msca) return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    const data = await apiGet(`/api/tx-history?address=${encodeURIComponent(msca.walletAddress)}`, msca.walletAddress)
    return { content: [{ type: 'text', text: JSON.stringify({ ...data, walletAddress: msca.walletAddress, walletType: 'MSCA' }) }] }
  })

  server.tool('arcox_route_status', 'Check if a swap/bridge/send route is supported', {
    action: z.string().describe('swap, bridge, or send'),
    fromChain: z.string().optional().describe('Source chain'),
    toChain: z.string().optional().describe('Destination chain'),
    token: z.string().optional().describe('Token symbol (USDC, EURC, cirBTC)'),
    tokenIn: z.string().optional().describe('Swap input token'),
    tokenOut: z.string().optional().describe('Swap output token'),
    source: z.string().optional().describe('session (MSCA)'),
  }, async (params) => {
    const action = String(params.action || '').toLowerCase()
    const source = params.source || 'session'
    const tokens = [params.token, params.tokenIn, params.tokenOut]
      .filter(Boolean)
      .map(token => String(token).toUpperCase())
    const hasUnsupportedSwapToken = action === 'swap' && tokens.some(token => token === 'CIRBTC' || token === 'USYC')
    const knownAction = ['swap', 'send', 'bridge'].includes(action)
    const bridgeIsSupported = action === 'bridge' && ENABLE_MSCA_CCTP_BRIDGE && ENABLE_SERVER_SIGNED_MINT && String(params.token || 'USDC').toUpperCase() === 'USDC' && Boolean(bridgeConfig(params.fromChain, params.toChain))
    const session = await resolveActiveMsca(userId)
    const mscaSupported = Boolean(session) && source === 'session' && knownAction && (action === 'bridge' ? bridgeIsSupported : !hasUnsupportedSwapToken)
    const route = action === 'bridge' ? bridgeConfig(params.fromChain, params.toChain) : null
    const disabledReason = action === 'bridge' ? bridgeConfigDisabledReason(route) : null
    const reason = !session
      ? 'no_session'
      : source !== 'session'
        ? 'msca_only'
        : !knownAction
          ? 'unknown_action'
          : disabledReason
            ? disabledReason
            : action === 'bridge' && !bridgeIsSupported
              ? 'bridge_route_not_supported_for_msca'
              : hasUnsupportedSwapToken
              ? 'swap_route_not_supported_for_msca'
              : null
    return { content: [{ type: 'text', text: JSON.stringify({
      supported: mscaSupported,
      executionSupported: mscaSupported,
      action: params.action,
      source,
      walletAddress: session?.walletAddress || null,
      walletType: session ? 'MSCA' : null,
      chains: { 'arc-testnet': 5042002, 'ethereum-sepolia': 11155111, 'base-sepolia': 84532, 'arbitrum-sepolia': 421614, 'solana-devnet': 'solana' },
      tokens: ['USDC', 'EURC', 'cirBTC'],
      sources: ['session'],
      reason,
      note: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote tetap wajib sebelum eksekusi.',
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
    const session = await resolveActiveMsca(userId)
    if (!session) {
      return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    }
    const quoteData = await apiPost('/api/eoa-swap-quote', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, metamaskAddress: session.walletAddress }, session.walletAddress)
    if (quoteData?.available !== true) {
      return { content: [{ type: 'text', text: JSON.stringify({ ...quoteData, source: 'session', walletAddress: session.walletAddress, walletType: 'MSCA' }) }] }
    }
    // Prepare immutable calldata at preview time. Execution must use this exact
    // payload, not re-quote later with potentially different routing/slippage.
    const prepared = await apiPost('/api/eoa-swap-prepare', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, metamaskAddress: session.walletAddress }, session.walletAddress)
    if (prepared?.success === false || prepared?.available === false || typeof prepared !== 'object' || !prepared) {
      return { content: [{ type: 'text', text: JSON.stringify({ ...prepared, source: 'session', walletAddress: session.walletAddress, walletType: 'MSCA' }) }] }
    }
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
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Use confirmed=true and confirmationText exactly yes or ya.' }) }] }
    const source = params.source || 'session'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Parameter source harus "session".' }) }] }
    }
    const activeSession = await resolveActiveMsca(userId)
    if (!activeSession) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, ...mscaRequiredResult() }) }] }
    const quoteCheck = consumeExecutionQuote(userId, 'swap', params.previewId, {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      walletAddress: activeSession.walletAddress,
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
        const preparedResult = buildPreparedSwapCalls(preparedPayload, { tokenIn: params.tokenIn, tokenOut: params.tokenOut })
      if (!preparedResult.calls) {
        const message = preparedResult.reason === 'adapter_not_allowlisted'
          ? 'Server belum mengonfigurasi ARCOX_SWAP_ADAPTER untuk eksekusi MSCA.'
          : preparedResult.reason === 'prepared_leg_incomplete'
            ? 'Circle tidak mengembalikan executionParams/signature lengkap untuk route ini. Coba pasangan stablecoin yang didukung.'
            : preparedResult.reason === 'adapter_mismatch'
              ? 'Adapter swap dari quote tidak cocok dengan adapter yang diizinkan server.'
              : 'Quote swap ini belum menghasilkan calldata MSCA yang aman untuk dieksekusi.'
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: preparedResult.reason || 'swap_calldata_unavailable', message }) }] }
      }
      const { swapViaSession } = await import('./sessionKeyService.mjs')
      const result = await swapViaSession(userId, { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, preparedCalls: preparedResult.calls, chainKey: 'arc-testnet' })
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
      // CCTP bridge via Agent Wallet (MSCA). The source burn is a UserOperation;
    // Circle attestation plus the configured destination relayer completes mint to the same MSCA.
    const token = params.token || 'USDC'
    const src = params.source || 'session'
    if (src !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote bridge hanya untuk source=session.' }) }] }
    }
    const info = await resolveActiveMsca(userId)
    if (!info) return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    const route = bridgeConfig(params.fromChain, params.toChain)
    const disabledReason = bridgeConfigDisabledReason(route)
    if (disabledReason) {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: disabledReason, message: disabledReason === 'destination_mint_relayer_not_configured' ? 'Destination mint relayer belum dikonfigurasi.' : 'Bridge MSCA belum diaktifkan.' }) }] }
    }
    if (!route || route.fromKey !== 'Arc_Testnet' || token.toUpperCase() !== 'USDC') {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'bridge_route_not_supported_for_msca', message: 'MSCA bridge saat ini mendukung USDC dari Arc Testnet ke chain EVM CCTP yang didukung.' }) }] }
    }
    try {
      const amount = parseUnits(String(params.amount).trim(), 6)
      if (amount <= 0n) throw new Error('Amount bridge tidak valid')
      const fee = await getRouterFeeQuote(route, amount)
      const quote = createExecutionQuote(userId, 'bridge', {
        fromChain: route.fromKey,
        toChain: route.toKey,
        amount: params.amount,
        token: 'USDC',
        walletAddress: info.walletAddress,
        platformFeeBaseUnits: fee.fee.toString(),
        netBurnBaseUnits: fee.netAmount.toString(),
        router: route.source.router,
        maxFeeBaseUnits: BRIDGE_MAX_FEE.toString(),
        minFinalityThreshold: BRIDGE_MIN_FINALITY_THRESHOLD,
      })
      return { content: [{ type: 'text', text: JSON.stringify({
        preview: true,
        route: `${params.fromChain} → ${params.toChain}`,
        amountIn: params.amount,
        token: 'USDC',
        source: 'session',
        walletAddress: info.walletAddress,
        walletType: 'MSCA',
        destinationWallet: info.walletAddress,
        platformFee: formatUnits(fee.fee, 6),
        estimatedReceive: formatUnits(fee.netAmount, 6),
        router: route.source.router,
        note: 'MSCA → MSCA melalui ArcoxRouter.bridgeUsdcWithFee → CCTP depositForBurn. Router menarik gross USDC dari MSCA; destination recipient tetap MSCA. Tidak ada fallback ke EOA/Circle proxy.',
        previewId: quote.previewId,
        expiresAt: new Date(quote.expires).toISOString(),
        execution: 'approve USDC → ArcoxRouter.bridgeUsdcWithFee → CCTP attestation → receiveMessage destination',
        safeNextStep: 'Tampilkan preview ini ke user. Setelah user setuju, panggil arcox_execute_bridge dengan confirmed=true.',
      }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ preview: false, rejected: true, reason: 'bridge_quote_unavailable', message: e?.message || 'ArcoxRouter quote tidak tersedia' }) }] }
    }
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
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Use confirmed=true and confirmationText exactly yes or ya.' }) }] }
    const source = params.source || 'session'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Circle proxy dan EOA tidak diizinkan untuk agent remote.' }) }] }
    }
    const info = await resolveActiveMsca(userId)
    if (!info) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, ...mscaRequiredResult() }) }] }
    const route = bridgeConfig(params.fromChain, params.toChain)
    const disabledReason = bridgeConfigDisabledReason(route)
    if (disabledReason) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: disabledReason, message: disabledReason === 'destination_mint_relayer_not_configured' ? 'Destination mint relayer belum dikonfigurasi. Tidak ada UserOperation yang dikirim.' : 'Bridge MSCA belum diaktifkan. Tidak ada UserOperation yang dikirim.' }) }] }
    }
    if (!route || route.fromKey !== 'Arc_Testnet' || String(params.token || 'USDC').toUpperCase() !== 'USDC') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'bridge_route_not_supported_for_msca', message: 'MSCA bridge saat ini mendukung USDC dari Arc Testnet ke chain EVM CCTP yang didukung.' }) }] }
    }
    const gate = await canAutoExecute(userId, source, params.amount)
    if (!gate.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: gate.reason, message: gate.message || 'Session key MSCA tidak dapat mengeksekusi bridge.' }) }] }
    try {
      const amount = parseUnits(String(params.amount).trim(), 6)
      if (amount <= 0n) throw new Error('Amount bridge tidak valid')
      const fee = await getRouterFeeQuote(route, amount)
      const quoteCheck = inspectExecutionQuote(userId, 'bridge', params.previewId, {
        fromChain: route.fromKey,
        toChain: route.toKey,
        amount: params.amount,
        token: 'USDC',
        walletAddress: info.walletAddress,
      })
      if (!quoteCheck.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
      const quotedFee = quoteCheck.quote.params.platformFeeBaseUnits
      const quotedNet = quoteCheck.quote.params.netBurnBaseUnits
      if (quoteCheck.quote.params.router !== route.source.router || quoteCheck.quote.params.maxFeeBaseUnits !== BRIDGE_MAX_FEE.toString() || Number(quoteCheck.quote.params.minFinalityThreshold) !== BRIDGE_MIN_FINALITY_THRESHOLD || quotedFee !== fee.fee.toString() || quotedNet !== fee.netAmount.toString()) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'quote_fee_changed', message: 'Router fee berubah setelah preview. Buat quote bridge baru.' }) }] }
      }
      executionQuotes.delete(quoteCheck.quote.previewId)
      const calls = buildMscaRouterBridgeCalls({ route, amount, mintRecipient: info.walletAddress })
      const { executeViaSession } = await import('./sessionKeyService.mjs')
      const result = await executeViaSession(userId, calls, { paymaster: true, chainKey: 'arc-testnet', requireTransactionHash: true })
      if (result.status !== 'success') return { content: [{ type: 'text', text: JSON.stringify({ status: 'session_failed', executed: false, error: result.reason || 'Bridge UserOperation gagal', userOpHash: result.userOpHash }) }] }
      const burnProof = await verifyBridgeBurn({ burnTxHash: result.txHash, route, walletAddress: info.walletAddress, amount })
      if (!burnProof.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'burn_submitted', executed: true, verified: false, burnTxHash: result.txHash, userOpHash: result.userOpHash, reason: burnProof.reason, message: 'Source UserOperation berhasil tetapi bukti event router belum terverifikasi. Jangan ulangi burn; periksa transaksi ini secara read-only.' }) }] }
      const bridgeStatus = await getCctpBridgeStatus({ burnTxHash: result.txHash, sourceDomain: route.source.domain, destinationDomain: route.destination.domain, walletAddress: info.walletAddress })
      const mint = bridgeStatus.verified
        ? await mintDestinationViaBackend({ burnTxHash: result.txHash, fromChain: route.fromKey, toChain: route.toKey, walletAddress: info.walletAddress, amount: params.amount }).catch(error => ({ success: false, error: error?.message || 'Destination mint request failed' }))
        : { success: false, error: 'Attestation belum ready' }
      let auditPending = false
      try {
        await recordAutoExec(userId, {
          agent: resolveAgentForUser(userId), action: 'bridge', amount: params.amount, token: 'USDC',
          source: 'session', details: JSON.stringify({ fromChain: route.fromKey, toChain: route.toKey, previewId: params.previewId, destinationMint: mint.success }),
          txHash: result.txHash, explorerUrl: result.explorerUrl,
        })
      } catch (auditError) {
        auditPending = true
        console.error('[mcp-bridge] audit record failed after burn:', auditError?.message || auditError)
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: mint.success ? 'executed' : 'settlement_pending',
        executed: true,
        auditPending,
        walletAddress: info.walletAddress,
        walletType: 'MSCA',
        fromChain: route.fromKey,
        toChain: route.toKey,
        amount: params.amount,
        token: 'USDC',
        burnTxHash: result.txHash,
        userOpHash: result.userOpHash,
        messageStatus: bridgeStatus.messageStatus || null,
        explorerUrl: result.explorerUrl,
        mintTxHash: mint.txHash || null,
        destinationExplorerUrl: mint.explorerUrl || null,
        mintError: mint.success ? null : mint.error,
        fee: { platformFeeBaseUnits: fee.fee.toString(), netBurnBaseUnits: fee.netAmount.toString(), totalDebitBaseUnits: amount.toString(), cctpMaxFeeBaseUnits: BRIDGE_MAX_FEE.toString() },
        message: mint.success ? 'Bridge MSCA berhasil sampai destination.' : 'Burn MSCA berhasil; destination mint masih pending. Jalankan arcox_bridge_status lalu retry setelah attestation siap.',
      }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'bridge_error', executed: false, error: e?.message || 'MSCA bridge gagal' }) }] }
    }
  })

  server.tool('arcox_bridge_status', 'Check attestation and destination mint status for an MSCA bridge burn transaction.', {
    burnTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('Source-chain burn transaction hash'),
    fromChain: z.string().describe('Source chain, currently arc-testnet'),
    toChain: z.string().describe('Destination chain used by the original quote'),
  }, async (params) => {
    if (!ENABLE_MSCA_CCTP_BRIDGE) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'disabled', verified: false, reason: 'msca_bridge_disabled_until_router_validation', message: 'Bridge MSCA status belum diaktifkan karena ArcoxRouter dan destination mint relayer belum tervalidasi. Tidak ada transaksi yang dikirim.' }) }] }
    }
    const info = await resolveActiveMsca(userId)
    if (!info) return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    const route = bridgeConfig(params.fromChain, params.toChain || 'ethereum-sepolia')
    if (!route || route.fromKey !== 'Arc_Testnet') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', reason: 'bridge_route_not_supported_for_msca', message: 'Status bridge MSCA hanya tersedia untuk burn dari Arc Testnet.' }) }] }
    }
    try {
      const burnProof = await verifyBridgeBurn({ burnTxHash: params.burnTxHash, route, walletAddress: info.walletAddress })
      if (!burnProof.ok) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', verified: false, reason: burnProof.reason }) }] }
      }
    } catch {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', verified: false, reason: 'bridge_burn_not_found' }) }] }
    }
    const status = await getCctpBridgeStatus({ burnTxHash: params.burnTxHash, sourceDomain: route.source.domain, destinationDomain: route.destination.domain, walletAddress: info.walletAddress })
    if (status.status === 'rejected') return { content: [{ type: 'text', text: JSON.stringify(status) }] }
    return { content: [{ type: 'text', text: JSON.stringify({
      ...status,
      walletAddress: info.walletAddress,
      walletType: 'MSCA',
      source: route.fromKey,
      note: 'Status ini membaca Iris/Circle attestation dan tidak mengirim transaksi baru.',
    }) }] }
  })

  server.tool('arcox_retry_bridge_mint', 'Retry destination receiveMessage for a confirmed MSCA bridge burn. This never burns again; it only polls attestation and mints the already-bound MSCA recipient.', {
    burnTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('Previously confirmed Arc router bridge transaction hash'),
    fromChain: z.string().describe('Original source chain, currently arc-testnet'),
    toChain: z.string().describe('Original destination chain'),
    confirmed: z.boolean().describe('Must be true to retry destination mint'),
    confirmationText: z.string().describe('Must be exactly yes or ya'),
  }, async (params) => {
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'preview_required', executed: false, message: 'Retry mint memerlukan confirmed=true dan confirmationText exactly yes atau ya.' }) }] }
    }
    const info = await resolveActiveMsca(userId)
    if (!info) return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    const route = bridgeConfig(params.fromChain, params.toChain)
    const disabledReason = bridgeConfigDisabledReason(route)
    if (disabledReason) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: disabledReason }) }] }
    if (!route || route.fromKey !== 'Arc_Testnet') return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'bridge_route_not_supported_for_msca' }) }] }
    try {
      const proof = await verifyBridgeBurn({ burnTxHash: params.burnTxHash, route, walletAddress: info.walletAddress })
      if (!proof.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: proof.reason, message: 'Burn ini tidak terbukti berasal dari ArcoxRouter untuk MSCA aktif.' }) }] }
      const status = await getCctpBridgeStatus({ burnTxHash: params.burnTxHash, sourceDomain: route.source.domain, destinationDomain: route.destination.domain, walletAddress: info.walletAddress })
      if (!status.verified) return { content: [{ type: 'text', text: JSON.stringify({ status: 'settlement_pending', executed: false, burnTxHash: params.burnTxHash, messageStatus: status.messageStatus || 'pending', message: 'Attestation belum tersedia. Tidak ada transaksi destination yang dikirim.' }) }] }
      const mint = await mintDestinationViaBackend({ burnTxHash: params.burnTxHash, fromChain: route.fromKey, toChain: route.toKey, walletAddress: info.walletAddress, amount: undefined })
      return { content: [{ type: 'text', text: JSON.stringify({ status: mint.success ? 'minted' : 'mint_failed', executed: mint.success, burnTxHash: params.burnTxHash, walletAddress: info.walletAddress, walletType: 'MSCA', mintTxHash: mint.txHash || null, destinationExplorerUrl: mint.explorerUrl || null, error: mint.success ? null : mint.error, message: mint.success ? 'Destination mint berhasil ke MSCA.' : 'Destination mint gagal; cek error dan ulangi retry setelah memastikan relayer siap.' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'retry_error', executed: false, burnTxHash: params.burnTxHash, error: e?.message || 'Retry mint gagal' }) }] }
    }
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
    const info = await resolveActiveMsca(userId)
    if (!info) return { content: [{ type: 'text', text: JSON.stringify(mscaRequiredResult()) }] }
    // MSCA send quote is bound to the active wallet. A later MSCA switch makes
    // the preview unusable instead of silently sending from another wallet.
    const q = createExecutionQuote(userId, 'send', { to: params.to, amount: params.amount, token, walletAddress: info.walletAddress })
    return { content: [{ type: 'text', text: JSON.stringify({
      preview: true,
      action: 'send',
      to: params.to,
      amount: params.amount,
      token,
      source: 'session',
      walletAddress: info.walletAddress,
      walletType: 'MSCA',
      payer: info.walletAddress,
      note: 'Send via Agent Wallet (MSCA/session key): gas dibayar paymaster, 30bps platform fee berlaku.',
      previewId: q.previewId,
      expiresAt: new Date(q.expires).toISOString(),
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
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Use confirmed=true and confirmationText exactly yes or ya.' }) }] }
    const source = params.source || 'session'
    const token = params.token || 'USDC'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Parameter source harus "session".' }) }] }
    }
    const activeSession = await resolveActiveMsca(userId)
    if (!activeSession) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, ...mscaRequiredResult() }) }] }
    const quoteCheck = consumeExecutionQuote(userId, 'send', params.previewId, { to: params.to, amount: params.amount, token, walletAddress: activeSession.walletAddress })
    if (!quoteCheck.ok) return { content: [{ type: 'text', text: JSON.stringify({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
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
          bridge_execution_enabled: ENABLE_MSCA_CCTP_BRIDGE,
          execution_guide: {
            swap: ['arcox_quote_swap → show preview → user ya → arcox_execute_swap (source=session)'],
            bridge: ENABLE_MSCA_CCTP_BRIDGE
              ? ['arcox_quote_bridge → show preview → user ya → arcox_execute_bridge → jika pending, arcox_bridge_status. Source Arc Testnet USDC, destination EVM CCTP yang didukung.']
              : ['arcox_route_status(action=bridge) → bridge MSCA masih disabled sampai ArcoxRouter, destination relayer, dan CCTP route tervalidasi. Tidak ada dana yang dipindahkan.'],
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
        if (preview.status !== 'preview') {
          return { content: [{ type: 'text', text: JSON.stringify({ ...preview, invoiceId: params.invoiceId }) }] }
        }
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
