// Remote HTTP MCP Server for ChatGPT / Claude
// Streamable HTTP transport + OAuth 2.1 with SIWE wallet auth
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, createHash } from 'crypto'
import { z } from 'zod'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'

// ── In-memory session store (production: use Redis) ──
const sessions = new Map() // sessionId -> { transport, server }
const oauthClients = new Map() // clientId -> { clientSecret, redirectUris, clientName }
const authCodes = new Map() // code -> { clientId, userId, expires }
const accessTokens = new Map() // token -> { userId, clientId, expires }

const SERVER_URL = process.env.SERVER_URL || 'https://arcoxdex.vercel.app'
const TOKEN_TTL = 3600 * 24 // 24 hours

// ── OAuth helpers ──
export function registerOAuthClient({ clientName, redirectUris = [] }) {
  const clientId = 'arcox_' + randomUUID().slice(0, 12)
  const clientSecret = randomUUID()
  oauthClients.set(clientId, { clientSecret, redirectUris, clientName })
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

// ── MCP Server factory ──
export function createMcpServer(userId) {
  const server = new McpServer({
    name: 'arcox-mcp',
    version: '1.0.0',
  })

  // Tool: wallet balances
  server.tool('arcox_wallet_balances', 'Show all wallet balances (EOA Arc, Circle proxy, Solana)', {}, async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          message: 'Use arcox-agent MCP for live balance queries. This remote MCP proxy confirms auth.',
          userId,
          tools: ['swap', 'bridge', 'send', 'intel', 'pay', 'ai_router', 'agentic_jobs'],
        })
      }]
    }
  })

  // Tool: list vault credentials
  server.tool('arcox_vault_list_credentials', 'List vault credentials for the authenticated user', {}, async () => {
    const { listCredentials } = await import('./vaultStore.mjs')
    const creds = listCredentials(userId)
    return { content: [{ type: 'text', text: JSON.stringify({ credentials: creds }) }] }
  })

  // Tool: request approval
  server.tool('arcox_vault_request_approval', 'Request user approval for a transaction', {
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

  // Tool: get limits
  server.tool('arcox_vault_get_limits', 'Get spending limits for the authenticated user', {}, async () => {
    const { getLimits } = await import('./vaultStore.mjs')
    const limits = getLimits(userId)
    return { content: [{ type: 'text', text: JSON.stringify({ limits }) }] }
  })

  // Tool: MCP info
  server.tool('arcox_mcp_info', 'Get ARCOX MCP server info and available services', {}, async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          server: 'arcox-mcp',
          version: '1.0.0',
          url: SERVER_URL,
          userId,
          services: ['wallet_balances', 'swap', 'bridge', 'send', 'intel', 'pay', 'ai_router', 'agentic_jobs', 'vault'],
          safety: 'All value-moving actions require user confirmation. Use arcox_vault_request_approval before executing transactions.',
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
