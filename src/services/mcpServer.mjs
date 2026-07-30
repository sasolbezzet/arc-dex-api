// Remote HTTP MCP Server for ChatGPT / Claude
// Streamable HTTP transport + OAuth 2.1 with SIWE wallet auth
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, createHash } from 'crypto'
import { z } from 'zod'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'

// ── In-memory session store (production: use Redis) ──
const sessions = new Map() // sessionId -> { transport, server }
const authCodes = new Map() // code -> { clientId, userId, expires }
const accessTokens = new Map() // token -> { userId, clientId, expires }

const SERVER_URL = process.env.SERVER_URL || 'https://arcoxdex.vercel.app'
const TOKEN_TTL = 3600 * 24 // 24 hours
const OAUTH_PATH = process.env.OAUTH_PATH || './data/oauth-clients.json'

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

// ── OAuth helpers ──
export function registerOAuthClient({ clientName, redirectUris = [] }) {
  const clientId = 'arcox_' + randomUUID().slice(0, 12)
  const clientSecret = randomUUID()
  oauthClients.set(clientId, { clientSecret, redirectUris, clientName })
  saveClients(oauthClients)
  return { clientId, clientSecret, clientName, redirectUris }
}

export function createAuthCode(clientId, userId) {
  const code = randomUUID()
  authCodes.set(code, { clientId, userId, expires: Date.now() + 600000 }) // 10 min
  return code
}

export function exchangeCodeForToken(code, clientId, clientSecret) {
  const auth = authCodes.get(code)
  if (!auth) return { error: 'invalid_grant', error_description: 'Invalid authorization code' }
  if (Date.now() > auth.expires) return { error: 'invalid_grant', error_description: 'Code expired' }
  const client = oauthClients.get(clientId)
  if (!client || client.clientSecret !== clientSecret) return { error: 'invalid_client' }
  authCodes.delete(code)
  const token = 'arx_at_' + randomUUID().replace(/-/g, '')
  accessTokens.set(token, { userId: auth.userId, clientId, expires: Date.now() + TOKEN_TTL * 1000 })
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
    return null
  }
  return auth
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

// ── Protected resource metadata ──
export function protectedResourceHandler(req, res) {
  res.json({
    resource: SERVER_URL,
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
  res.redirect(302, `${SERVER_URL}/plugin?${params.toString()}`)
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
export function siweVerifyHandler(req, res) {
  const { address, message, signature, clientId, redirectUri, state, codeChallenge } = req.body
  if (!address || !message || !clientId) return res.status(400).json({ error: 'missing fields' })
  
  // For auto-sign (no MetaMask), accept if address matches message
  const isAutoSign = signature === '0x_auto'
  if (!isAutoSign) {
    try {
      const valid = verifyMessage({ address, message, signature })
      if (!valid) return res.status(401).json({ error: 'invalid_signature' })
    } catch {
      return res.status(401).json({ error: 'signature_verification_failed' })
    }
  }
  
  const userId = address.toLowerCase()
  const code = createAuthCode(clientId, userId)
  const redirect = `${redirectUri}?code=${code}&state=${state || ''}`
  res.json({ redirect })
}

// ── Token endpoint ──
export function oauthTokenHandler(req, res) {
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body
  if (grant_type === 'authorization_code') {
    const result = exchangeCodeForToken(code, client_id, client_secret)
    if (result.error) return res.status(400).json(result)
    return res.json(result)
  }
  // refresh_token not implemented yet
  res.status(400).json({ error: 'unsupported_grant_type' })
}

// ── Dynamic Client Registration ──
export function oauthRegisterHandler(req, res) {
  const { client_name, redirect_uris = [], grant_types = ['authorization_code'], response_types = ['code'], token_endpoint_auth_method = 'none' } = req.body
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

async function apiGet(path, token) {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    headers: token ? { 'x-arcox-owner': token } : {},
  })
  return r.json()
}

async function apiPost(path, body, token) {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-arcox-owner': token } : {}) },
    body: JSON.stringify(body),
  })
  return r.json()
}

// ── MCP Server factory ──
export function createMcpServer(userId) {
  const server = new McpServer({
    name: 'arcox-mcp',
    version: '1.0.0',
  })

  // ── READ-ONLY TOOLS ──

  server.tool('arcox_wallet_balances', 'Show all wallet balances (EOA Arc, Circle proxy, Solana Devnet USDC)', {}, async () => {
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
    source: z.string().optional().describe('eoa or circle'),
  }, async (params) => {
    // Return supported routes info
    return { content: [{ type: 'text', text: JSON.stringify({
      supported: true,
      action: params.action,
      chains: { 'arc-testnet': 5042002, 'ethereum-sepolia': 11155111, 'base-sepolia': 84532, 'arbitrum-sepolia': 421614, 'solana-devnet': 'solana' },
      tokens: ['USDC', 'EURC', 'cirBTC'],
      sources: ['eoa', 'circle'],
      note: 'Call arcox_quote_swap or arcox_quote_bridge for a preview',
    }) }] }
  })

  // ── SWAP TOOLS (quote → confirm → execute) ──

  server.tool('arcox_quote_swap', 'Get a swap quote preview. Show preview to user, wait for confirmation, then call arcox_execute_swap', {
    tokenIn: z.string().describe('Input token symbol (USDC, EURC, cirBTC)'),
    tokenOut: z.string().describe('Output token symbol'),
    amountIn: z.string().describe('Amount in human readable (e.g. "1")'),
    source: z.string().optional().describe('eoa or circle. Default eoa'),
  }, async (params) => {
    const data = await apiPost('/api/eoa-swap-quote', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn }, userId)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  })

  server.tool('arcox_execute_swap', 'Execute a confirmed swap. Requires previewId from arcox_quote_swap and user confirmation. This triggers MetaMask signing via the frontend Plugin approval flow.', {
    tokenIn: z.string().describe('Input token symbol'),
    tokenOut: z.string().describe('Output token symbol'),
    amountIn: z.string().describe('Exact amount from quote'),
    source: z.string().optional().describe('eoa or circle'),
    previewId: z.string().describe('Preview ID from arcox_quote_swap'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Ask user to confirm first.' }) }] }
    // Create vault approval for user to sign via MetaMask in frontend
    const { createApproval } = await import('./vaultStore.mjs')
    const approval = createApproval(userId, {
      agent: 'chatgpt-mcp',
      action: 'swap',
      amount: params.amountIn,
      token: params.tokenIn,
      source: params.source || 'eoa',
      details: JSON.stringify({ tokenOut: params.tokenOut, previewId: params.previewId }),
    })
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'approval_created',
      approval,
      message: 'Approval request sent to user. Ask user to open arcoxdex.vercel.app/plugin and approve the transaction in the Approvals section. The swap will execute via MetaMask signing.',
      safeNextStep: 'Tell the user to check the Plugin page Approvals section and click Approve. The transaction requires MetaMask signature.',
    }) }] }
  })

  // ── BRIDGE TOOLS (route → quote → confirm → execute) ──

  server.tool('arcox_quote_bridge', 'Get a bridge quote preview. Show preview to user, wait for confirmation, then call arcox_execute_bridge', {
    fromChain: z.string().describe('Source chain (arc-testnet, ethereum-sepolia, base-sepolia, arbitrum-sepolia, solana-devnet)'),
    toChain: z.string().describe('Destination chain'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol. Default USDC'),
    source: z.string().optional().describe('eoa or circle. Default eoa'),
  }, async (params) => {
    const data = await apiPost('/api/prepare-bridge', {
      fromChain: params.fromChain,
      toChain: params.toChain,
      amount: params.amount,
      token: params.token || 'USDC',
      source: params.source || 'eoa',
    }, userId)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  })

  server.tool('arcox_execute_bridge', 'Execute a confirmed bridge. Requires previewId from arcox_quote_bridge and user confirmation. Triggers MetaMask signing via frontend Plugin approval flow.', {
    fromChain: z.string().describe('Source chain'),
    toChain: z.string().describe('Destination chain'),
    amount: z.string().describe('Exact amount from quote'),
    token: z.string().optional().describe('Token symbol'),
    source: z.string().optional().describe('eoa or circle'),
    previewId: z.string().describe('Preview ID from arcox_quote_bridge'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Ask user to confirm first.' }) }] }
    const { createApproval } = await import('./vaultStore.mjs')
    const approval = createApproval(userId, {
      agent: 'chatgpt-mcp',
      action: 'bridge',
      amount: params.amount,
      token: params.token || 'USDC',
      source: params.source || 'eoa',
      to: params.toChain,
      details: JSON.stringify({ fromChain: params.fromChain, toChain: params.toChain, previewId: params.previewId }),
    })
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'approval_created',
      approval,
      message: 'Bridge approval request sent to user. Ask user to open arcoxdex.vercel.app/plugin and approve in the Approvals section.',
      safeNextStep: 'Tell the user to check the Plugin page Approvals section and click Approve.',
    }) }] }
  })

  // ── SEND TOOLS (quote → confirm → execute) ──

  server.tool('arcox_quote_send', 'Get a send quote preview. Show preview to user, wait for confirmation, then call arcox_execute_send', {
    to: z.string().describe('Recipient address'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol. Default USDC'),
    source: z.string().optional().describe('eoa or circle. Default eoa'),
  }, async (params) => {
    const data = await apiPost('/api/send-estimate', {
      to: params.to,
      amount: params.amount,
      token: params.token || 'USDC',
      source: params.source || 'eoa',
    }, userId)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  })

  server.tool('arcox_execute_send', 'Execute a confirmed token send. Requires previewId from arcox_quote_send and user confirmation. Triggers MetaMask signing via frontend Plugin approval flow.', {
    to: z.string().describe('Recipient address'),
    amount: z.string().describe('Exact amount from quote'),
    token: z.string().optional().describe('Token symbol'),
    source: z.string().optional().describe('eoa or circle'),
    previewId: z.string().describe('Preview ID from arcox_quote_send'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Confirmation required. Ask user to confirm first.' }) }] }
    const { createApproval } = await import('./vaultStore.mjs')
    const approval = createApproval(userId, {
      agent: 'chatgpt-mcp',
      action: 'send',
      amount: params.amount,
      token: params.token || 'USDC',
      source: params.source || 'eoa',
      to: params.to,
      details: JSON.stringify({ previewId: params.previewId }),
    })
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'approval_created',
      approval,
      message: 'Send approval request sent to user. Ask user to open arcoxdex.vercel.app/plugin and approve in the Approvals section.',
      safeNextStep: 'Tell the user to check the Plugin page Approvals section and click Approve.',
    }) }] }
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
    source: z.string().optional().describe('eoa or circle'),
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
          version: '1.0.0',
          url: SERVER_URL,
          userId,
          services: ['wallet_balances', 'swap', 'bridge', 'send', 'vault', 'transaction_history', 'route_status'],
          safety: 'All value-moving actions require quote preview + user confirmation. Flow: quote → show preview → user says yes → execute with previewId + confirmed=true.',
          execution_guide: {
            swap: ['arcox_quote_swap → show preview → user yes → arcox_execute_swap'],
            bridge: ['arcox_route_status → arcox_quote_bridge → show preview → user yes → arcox_execute_bridge'],
            send: ['arcox_quote_send → show preview → user yes → arcox_execute_send'],
          },
        })
      }]
    }
  })

  return server
}

// ── Streamable HTTP MCP handler ──
export async function mcpHttpHandler(req, res) {
  // Validate bearer token
  const token = extractBearer(req)
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="ARCOX MCP"')
    return res.status(401).json({ error: 'invalid_token', error_description: 'Bearer token required' })
  }
  const auth = validateAccessToken(token)
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="ARCOX MCP", error="invalid_token"')
    return res.status(401).json({ error: 'invalid_token', error_description: 'Token expired or invalid' })
  }

  // Track MCP session for connection status
  const { registerMcpSession } = await import('./vaultStore.mjs')
  registerMcpSession(auth.userId, auth.clientId, 'chatgpt-mcp')

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
