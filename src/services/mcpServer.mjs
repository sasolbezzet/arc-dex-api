// Remote HTTP MCP Server for ChatGPT / Claude
// Streamable HTTP transport + OAuth 2.1 with SIWE wallet auth
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, createHash } from 'crypto'
import { z } from 'zod'
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname } from 'path'

// ── In-memory session store (production: use Redis) ──
const sessions = new Map() // sessionId -> { transport, server }
const executionQuotes = new Map() // previewId -> { userId, action, params, expires }
const authCodes = new Map() // code -> { clientId, userId, redirectUri, codeChallenge, state, expires }
const oauthRequests = new Map() // requestId -> original authorization request
const siweChallenges = new Map() // nonce -> exact SIWE challenge binding
const accessTokens = new Map() // token -> { userId, clientId, expires }
// destination chain + CCTP nonce -> { userId, userOpHash, chainKey }
// A pending destination UserOperation must remain discoverable until its
// receipt is known; a plain Set would lose the hash on timeout/restart.
const destinationMintLocks = new Map()

// MCP responses may include decoded CCTP uint256 fields represented as BigInt.
// Always serialize them as decimal strings so direct handler execution and
// production HTTP requests behave identically (server.mjs may define a global
// BigInt serializer, but mcpServer must not depend on that side effect).
function jsonText(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
}

const SERVER_URL = process.env.SERVER_URL || 'https://arcoxdex.vercel.app'
const MCP_RESOURCE_URL = `${SERVER_URL}/mcp`
const TOKEN_TTL = 3600 * 24 // 24 hours
// Keep the Streamable HTTP transport alive for the same practical lifetime as
// the OAuth token. The previous fixed 30-minute timer deleted an otherwise
// valid MCP session while Claude was idle; its next tools/call then reached a
// missing transport and surfaced as the opaque SDK execution error.
export const MCP_SESSION_IDLE_TTL_MS = Number(process.env.MCP_SESSION_IDLE_TTL_MS || 24 * 60 * 60 * 1000)

export function shouldExpireMcpSession(session, now = Date.now()) {
  const lastActivity = Number(session?.lastActivity || 0)
  return lastActivity > 0 && now - lastActivity >= MCP_SESSION_IDLE_TTL_MS
}

function validResourceIndicator(resource) {
  return !resource || String(resource) === MCP_RESOURCE_URL
}
const OAUTH_PATH = process.env.OAUTH_PATH || './data/oauth-clients.json'
const OAUTH_TOKENS_PATH = process.env.OAUTH_TOKENS_PATH || './data/oauth-tokens.json'
const OAUTH_STATE_PATH = process.env.OAUTH_STATE_PATH || './data/oauth-state.json'
const OAUTH_STATE_LOCK = `${OAUTH_STATE_PATH}.lock`
const CANONICAL_SERVER_HOST = (() => {
  try { return new URL(SERVER_URL).host }
  catch { return 'arcoxdex.vercel.app' }
})()

// OAuth authorization requests and SIWE challenges must survive a backend
// restart and must be visible when Vercel/reverse-proxy routing changes the
// worker handling the next request. They contain only short-lived protocol
// state; access tokens remain in their existing store.
function loadOAuthState() {
  const state = readJsonFile(OAUTH_STATE_PATH, { requests: {}, challenges: {} })
  return {
    requests: state?.requests && typeof state.requests === 'object' ? state.requests : {},
    challenges: state?.challenges && typeof state.challenges === 'object' ? state.challenges : {},
    codes: state?.codes && typeof state.codes === 'object' ? state.codes : {},
  }
}
function refreshOAuthState() {
  const state = loadOAuthState()
  // Disk is authoritative. Removing absent entries is important after expiry
  // or when another worker has already consumed/cleaned the state.
  authCodes.clear()
  oauthRequests.clear()
  siweChallenges.clear()
  for (const [key, value] of Object.entries(state.codes)) authCodes.set(key, value)
  for (const [key, value] of Object.entries(state.requests)) oauthRequests.set(key, value)
  for (const [key, value] of Object.entries(state.challenges)) siweChallenges.set(key, value)
  return state
}
function refreshOAuthClients() {
  const clients = loadClients()
  oauthClients.clear()
  for (const [key, value] of clients) oauthClients.set(key, value)
  return clients
}
function saveOAuthState() {
  atomicWriteJsonFile(OAUTH_STATE_PATH, {
    codes: Object.fromEntries(authCodes),
    requests: Object.fromEntries(oauthRequests),
    challenges: Object.fromEntries(siweChallenges),
  })
}
function withOAuthStateLock(fn) {
  const deadline = Date.now() + 15000
  const staleAfter = 10000
  const ownerToken = `${process.pid}:${randomUUID()}`
  const ownerPath = `${OAUTH_STATE_LOCK}/owner`
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  mkdirSync(dirname(OAUTH_STATE_LOCK), { recursive: true })
  while (true) {
    try {
      mkdirSync(OAUTH_STATE_LOCK)
      writeFileSync(ownerPath, JSON.stringify({ token: ownerToken, acquiredAt: Date.now() }), { mode: 0o600 })
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
        if (Date.now() - Number(owner?.acquiredAt || 0) > staleAfter) rmSync(OAUTH_STATE_LOCK, { recursive: true, force: true })
      } catch {
        try {
          if (Date.now() - statSync(OAUTH_STATE_LOCK).mtimeMs > staleAfter) rmSync(OAUTH_STATE_LOCK, { recursive: true, force: true })
        } catch { /* another worker may be acquiring or recovering the lock */ }
      }
      if (Date.now() >= deadline) throw new Error('OAuth state lock timeout')
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  try {
    refreshOAuthState()
    return fn()
  } finally {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'))
      if (owner?.token === ownerToken) rmSync(OAUTH_STATE_LOCK, { recursive: true, force: true })
    } catch { /* stale recovery or another worker owns the lock */ }
  }
}

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
refreshOAuthState()

function loadTokens() {
  const d = readJsonFile(OAUTH_TOKENS_PATH, { tokens: {} })
  return new Map(Object.entries(d.tokens || {}))
}
function saveTokens() {
  atomicWriteJsonFile(OAUTH_TOKENS_PATH, { tokens: Object.fromEntries(accessTokens) })
}
function refreshAccessTokens() {
  accessTokens.clear()
  for (const [token, auth] of loadTokens()) {
    if (auth?.expires > Date.now()) accessTokens.set(token, auth)
  }
}
refreshAccessTokens()

// ── OAuth helpers ──
export function registerOAuthClient({ clientName, redirectUris = [] }) {
  return withOAuthStateLock(() => {
    refreshOAuthClients()
    const clientId = 'arcox_' + randomUUID().slice(0, 12)
    const clientSecret = randomUUID()
    oauthClients.set(clientId, { clientSecret, redirectUris, clientName })
    saveClients(oauthClients)
    return { clientId, clientSecret, clientName, redirectUris }
  })
}

function createAuthCodeUnsafe(clientId, userId, { redirectUri, codeChallenge, state, requestId, challengeNonce, resource, mscaWalletAddress } = {}) {
  const code = randomUUID()
  authCodes.set(code, { clientId, userId, redirectUri, codeChallenge, state: state || '', requestId: requestId || null, challengeNonce: challengeNonce || null, resource: resource || MCP_RESOURCE_URL, mscaWalletAddress: mscaWalletAddress || '', expires: Date.now() + 600000 }) // 10 min
  return code
}

export function createAuthCode(clientId, userId, options = {}) {
  return withOAuthStateLock(() => {
    const code = createAuthCodeUnsafe(clientId, userId, options)
    saveOAuthState()
    return code
  })
}

// A repeated SIWE verification can happen when a wallet returns successfully
// but the browser loses the first HTTP response. Reuse the still-valid grant
// instead of issuing competing codes and leaving the MCP client waiting on a
// stale callback. The signature itself is verified by the caller before this
// helper is used.
export function findExistingAuthCode(clientId, userId, { redirectUri, codeChallenge, state, resource, mscaWalletAddress } = {}) {
  const now = Date.now()
  for (const [code, auth] of authCodes) {
    if (now > auth.expires) {
      authCodes.delete(code)
      continue
    }
    if (auth.clientId === clientId && auth.userId === userId && auth.redirectUri === redirectUri && auth.codeChallenge === codeChallenge && (auth.state || '') === (state || '') && (auth.resource || MCP_RESOURCE_URL) === (resource || MCP_RESOURCE_URL) && (auth.mscaWalletAddress || '') === (mscaWalletAddress || '')) {
      return code
    }
  }
  return null
}

export function exchangeCodeForToken(code, clientId, clientSecret, redirectUri, codeVerifier, resource) {
  return withOAuthStateLock(() => {
    refreshOAuthClients()
    const auth = authCodes.get(code)
    if (!auth) return { error: 'invalid_grant', error_description: 'Invalid authorization code' }
    if (Date.now() > auth.expires) return { error: 'invalid_grant', error_description: 'Code expired' }
    if (auth.clientId !== clientId) return { error: 'invalid_grant', error_description: 'client_id mismatch' }
    if (!redirectUri || auth.redirectUri !== redirectUri) return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' }
    if (resource && !validResourceIndicator(resource)) return { error: 'invalid_target', error_description: 'resource must identify the ARCOX MCP endpoint' }
    if (resource && resource !== (auth.resource || MCP_RESOURCE_URL)) return { error: 'invalid_target', error_description: 'resource does not match the authorization code' }
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
    if (auth.challengeNonce) {
      const challenge = siweChallenges.get(auth.challengeNonce)
      if (challenge) challenge.consumed = true
    }
    // Persist single-use consumption before returning so another worker cannot
    // redeem the same code or replay its SIWE challenge.
    saveOAuthState()
    // Merge the latest shared token file while holding the OAuth lock before
    // adding this token; otherwise a worker with a stale cache could erase a
    // token issued concurrently by another worker.
    refreshAccessTokens()
    const token = 'arx_at_' + randomUUID().replace(/-/g, '')
    accessTokens.set(token, { userId: auth.userId, clientId, resource: auth.resource || MCP_RESOURCE_URL, mscaWalletAddress: auth.mscaWalletAddress || '', expires: Date.now() + TOKEN_TTL * 1000 })
    saveTokens()
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL,
      scope: 'mcp:tools',
    }
  })
}

export function validateAccessToken(token) {
  // Tokens are persisted because the next MCP request may land on another
  // worker than the one that completed `/token`. Refresh the local cache on
  // every validation; the file store is authoritative for this short-lived
  // OAuth state.
  refreshAccessTokens()
  const auth = accessTokens.get(token)
  if (!auth) return null
  return auth
}

// Periodic sweep of expired auth codes, authorization requests, SIWE challenges,
// and access tokens so these maps cannot grow unbounded and contribute to
// gradual memory pressure / OOM kills.
const _authSweep = setInterval(() => {
  const now = Date.now()
  try {
    withOAuthStateLock(() => {
      for (const [code, v] of authCodes) if (now > v.expires) authCodes.delete(code)
      for (const [requestId, v] of oauthRequests) if (now > v.expires) oauthRequests.delete(requestId)
      for (const [nonce, v] of siweChallenges) if (now > v.expires) siweChallenges.delete(nonce)
      saveOAuthState()
      // Token cleanup shares the OAuth lock, so a sweep cannot overwrite a
      // token issued concurrently by another worker.
      refreshAccessTokens()
      let changed = false
      for (const [token, auth] of accessTokens) {
        if (now > auth.expires) { accessTokens.delete(token); changed = true }
      }
      if (changed) saveTokens()
    })
  } catch { /* retry on the next sweep */ }
}, 10 * 60 * 1000)
if (_authSweep.unref) _authSweep.unref()

// Map an OAuth clientId to a normalized agent name (contains 'claude' or
// 'chatgpt' so the frontend StatusDot matching works). Falls back to the
// registered client name, then to a generic label.
export function resolveAgentName(clientId) {
  refreshOAuthClients()
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
    resource_indicators_supported: true,
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
  refreshOAuthClients()
  const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method, resource } = req.query
  if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' })
  const client = oauthClients.get(client_id)
  if (!client) return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' })
  if (!redirect_uri || !client.redirectUris.includes(redirect_uri)) return res.status(400).json({ error: 'invalid_redirect_uri' })
  if (!state) return res.status(400).json({ error: 'invalid_request', error_description: 'state required' })
  if (!code_challenge || code_challenge_method !== 'S256') return res.status(400).json({ error: 'invalid_request', error_description: 'S256 PKCE required' })
  if (!validResourceIndicator(resource)) return res.status(400).json({ error: 'invalid_target', error_description: 'resource must identify the ARCOX MCP endpoint' })

  // Keep the original request server-side.
  // The browser may display these
  // values, but it must not be able to change the redirect, state, or PKCE
  // binding before SIWE verification completes.
  const requestId = randomUUID()
  try {
    withOAuthStateLock(() => {
      refreshOAuthClients()
      oauthRequests.set(requestId, {
        clientId: client_id,
        redirectUri: redirect_uri,
        state,
        codeChallenge: code_challenge,
        resource: resource || MCP_RESOURCE_URL,
        expires: Date.now() + 600000,
      })
      saveOAuthState()
    })
  } catch (error) {
    return res.status(503).json({ error: 'oauth_state_unavailable', message: error?.message || 'OAuth state store unavailable' })
  }

  // Redirect to frontend Plugin page with OAuth params
  // Frontend handles SIWE login + approval, then redirects back to ChatGPT
  const params = new URLSearchParams({
    auth: 'mcp',
    request_id: requestId,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    ...(resource ? { resource } : {}),
  })
  res.redirect(302, `${SERVER_URL}/arc-dex/plugin?${params.toString()}`)
}

// ── SIWE message generation ──
export function siweMessageHandler(req, res) {
  refreshOAuthClients()
  const { address, client_id, request_id } = req.query
  if (!address) return res.status(400).json({ error: 'address required' })
  let result
  try {
    result = withOAuthStateLock(() => {
      refreshOAuthClients()
      const client = oauthClients.get(client_id)
      const request = oauthRequests.get(request_id)
      if (!client || !request || request.clientId !== client_id || Date.now() > request.expires) return { error: 'invalid_authorization_request' }
      const nonce = randomUUID().slice(0, 8)
      const message = `${CANONICAL_SERVER_HOST} wants you to sign in with your Ethereum account:\n${address}\n\nAuthorize ARCOX MCP Server\n\nURI: ${SERVER_URL}\nVersion: 1\nChain ID: 5042002\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`
      siweChallenges.set(nonce, {
        address: String(address).toLowerCase(),
        clientId: client_id,
        requestId: request_id,
        message,
        expires: Date.now() + 300000,
      })
      saveOAuthState()
      return { message, nonce }
    })
  } catch (error) {
    return res.status(503).json({ error: 'oauth_state_unavailable', message: error?.message || 'OAuth state store unavailable' })
  }
  if (result.error) return res.status(400).json(result)
  res.json(result)
}

// ── SIWE verify + issue auth code ──
import { createPublicClient, decodeEventLog, defineChain, encodeFunctionData, fallback, formatUnits, getAddress, http, parseUnits, verifyMessage } from 'viem'

// Bind the verified SIWE identity to an already-active passkey session only
// when the browser proves control of that exact MSCA with its vault token.
// This keeps MCP MSCA-only while allowing Claude/ChatGPT's EOA identity to
// resolve the Agent Wallet after the user explicitly approves OAuth.
export async function bindMcpIdentityToActiveSession({ userId, mscaWalletAddress, mscaSessionToken } = {}) {
  if (!mscaWalletAddress && !mscaSessionToken) return { ok: true, skipped: true }
  if (!userId || !mscaWalletAddress || !mscaSessionToken) {
    return { ok: false, error: 'Both active MSCA address and passkey session token are required for identity binding' }
  }
  try {
    const { validateSession, getSessionKeyInfo } = await import('./vaultStore.mjs')
    const authenticatedMsca = validateSession(mscaSessionToken)
    if (!authenticatedMsca || getAddress(authenticatedMsca) !== getAddress(mscaWalletAddress)) {
      return { ok: false, error: 'Passkey session token does not authenticate the selected MSCA' }
    }
    const session = await getSessionKeyInfo(mscaWalletAddress)
    if (!session?.active || getAddress(session.walletAddress || '') !== getAddress(mscaWalletAddress)) {
      return { ok: false, error: 'Selected MSCA does not have an active session key' }
    }
    const { bindSessionAlias } = await import('./sessionKeyService.mjs')
    // The passkey-backed session token above proves control of this exact
    // active MSCA. Permit this OAuth flow to replace a stale EOA alias so a
    // newly selected Agent Wallet can connect without a manual cleanup step.
    // The ordinary session setup path keeps the strict no-rebind default.
    return { ok: true, bound: bindSessionAlias(userId, userId, mscaWalletAddress, { allowRebind: true }) }
  } catch (error) {
    return { ok: false, error: error?.message || 'MCP identity binding failed' }
  }
}

export async function siweVerifyHandler(req, res) {
  const { address, message, signature, clientId, redirectUri, state, codeChallenge, requestId, resource, mscaWalletAddress, mscaSessionToken } = req.body || {}
  if (!address || !message || !clientId || !requestId) return res.status(400).json({ error: 'missing_fields' })
  if (!redirectUri || !codeChallenge) return res.status(400).json({ error: 'missing_pkce_or_redirect_uri' })
  if (!validResourceIndicator(resource)) return res.status(400).json({ error: 'invalid_target', error_description: 'resource must identify the ARCOX MCP endpoint' })

  let initial
  try {
    initial = withOAuthStateLock(() => {
      refreshOAuthClients()
      const client = oauthClients.get(clientId)
      const request = oauthRequests.get(requestId)
      if (!client || !request || request.clientId !== clientId || Date.now() > request.expires) return { error: 'invalid_authorization_request' }
      if (request.redirectUri !== redirectUri || request.state !== (state || '') || request.codeChallenge !== codeChallenge || !client.redirectUris.includes(redirectUri) || (resource && request.resource !== resource)) return { error: 'authorization_request_mismatch' }
      const nonceMatch = String(message).match(/\nNonce: ([^\n]+)\n/)
      const challenge = nonceMatch ? siweChallenges.get(nonceMatch[1]) : null
      if (!challenge || Date.now() > challenge.expires || challenge.consumed || challenge.requestId !== requestId || challenge.clientId !== clientId || challenge.address !== String(address).toLowerCase() || challenge.message !== message) return { error: 'invalid_or_expired_siwe_challenge' }
      return { nonce: nonceMatch[1] }
    })
  } catch (error) {
    return res.status(503).json({ error: 'oauth_state_unavailable', message: error?.message || 'OAuth state store unavailable' })
  }
  if (initial.error) return res.status(400).json(initial)

  try {
    const valid = await verifyMessage({ address, message, signature })
    if (!valid) return res.status(401).json({ error: 'invalid_signature' })
  } catch {
    return res.status(401).json({ error: 'signature_verification_failed' })
  }

  const binding = await bindMcpIdentityToActiveSession({
    userId: String(address).toLowerCase(),
    mscaWalletAddress,
    mscaSessionToken,
  })
  if (!binding.ok) return res.status(403).json({ error: 'session_identity_binding_failed', error_description: binding.error })

  let grant
  try {
    grant = withOAuthStateLock(() => {
      refreshOAuthClients()
      const client = oauthClients.get(clientId)
      const request = oauthRequests.get(requestId)
      const challenge = siweChallenges.get(initial.nonce)
      if (!client || !request || !challenge || request.clientId !== clientId || request.redirectUri !== redirectUri || request.state !== (state || '') || request.codeChallenge !== codeChallenge || !client.redirectUris.includes(redirectUri) || Date.now() > request.expires || Date.now() > challenge.expires || challenge.consumed || challenge.requestId !== requestId || challenge.clientId !== clientId || challenge.address !== String(address).toLowerCase() || challenge.message !== message) return { error: 'invalid_or_expired_siwe_challenge' }
      const userId = address.toLowerCase()
      const boundMscaWalletAddress = mscaWalletAddress || ''
      const existingCode = findExistingAuthCode(clientId, userId, { redirectUri, codeChallenge, state, resource: request.resource || resource || MCP_RESOURCE_URL, mscaWalletAddress: boundMscaWalletAddress })
      const code = existingCode || createAuthCodeUnsafe(clientId, userId, { redirectUri, codeChallenge, state, requestId, challengeNonce: initial.nonce, resource: request.resource || resource || MCP_RESOURCE_URL, mscaWalletAddress: boundMscaWalletAddress })
      challenge.completedCode = code
      challenge.signature = String(signature).toLowerCase()
      saveOAuthState()
      return { code }
    })
  } catch (error) {
    return res.status(503).json({ error: 'oauth_state_unavailable', message: error?.message || 'OAuth state store unavailable' })
  }
  if (grant.error) return res.status(400).json(grant)

  // Keep the challenge around until expiry so a lost HTTP response can be
  // retried with the same signed message and receive the same authorization
  // code. The code itself remains single-use at token exchange.
  const redirectUrl = new URL(redirectUri)
  redirectUrl.searchParams.set('code', grant.code)
  if (state) redirectUrl.searchParams.set('state', state)
  res.json({ redirect: redirectUrl.toString(), code: grant.code, state: state || '' })
}

// ── Token endpoint ──
export function oauthTokenHandler(req, res) {
  const { grant_type, code, client_id, client_secret, redirect_uri, code_verifier, resource } = req.body || {}
  if (grant_type === 'authorization_code') {

    let result
    try {
      result = exchangeCodeForToken(code, client_id, client_secret, redirect_uri, code_verifier, resource)
    } catch (error) {
      return res.status(503).json({ error: 'oauth_state_unavailable', message: error?.message || 'OAuth state store unavailable' })
    }
    if (result.error) return res.status(400).json(result)
    return res.json(result)
  }
  // refresh_token not implemented yet
  res.status(400).json({ error: 'unsupported_grant_type' })
}

// ── Dynamic Client Registration ──
export function oauthRegisterHandler(req, res) {
  const { client_name, redirect_uris = [], grant_types = ['authorization_code'], response_types = ['code'], token_endpoint_auth_method = 'none' } = req.body || {}
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || redirect_uris.some(uri => typeof uri !== 'string' || !uri)) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris must be a non-empty array of URI strings' })
  }
  let client
  try {
    client = registerOAuthClient({ clientName: client_name || 'mcp-client', redirectUris: redirect_uris })
  } catch (error) {
    return res.status(503).json({ error: 'oauth_state_unavailable', message: error?.message || 'OAuth state store unavailable' })
  }
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
import { markX402ServiceOutcome, publicInvoice } from '../middleware/x402Middleware.mjs'
import { fetchAllChainBalances } from './multiChainBalance.mjs'
import { CHAINS } from './chains.mjs'
import { arcRpcUrls, resolveArcRpc } from '../config/arcRpc.mjs'

// The MCP userId is the SIWE-verified EOA used only as the tenant/auth identity.
// On-chain reads, quotes, and execution must use the explicitly mapped Agent
// Wallet MSCA returned by the active session key. Never use userId as payer.
export async function resolveActiveMsca(userId, boundMscaWalletAddress = '') {
  try {
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const { hasExplicitSessionAlias } = await import('./sessionKeyService.mjs')
    // A passkey-proven MSCA binding is carried by the server-issued OAuth
    // token. Resolve that exact wallet directly so the first MCP request does
    // not depend on a separately persisted EOA alias being visible yet.
    const info = await getSessionKeyInfo(boundMscaWalletAddress || userId)
    if (!info?.active || !info.walletAddress) return null
    if (boundMscaWalletAddress) {
      if (String(info.walletAddress).toLowerCase() !== String(boundMscaWalletAddress).toLowerCase()) return null
      if (String(info.walletAddress).toLowerCase() === String(userId).toLowerCase()) return null
      return info
    }
    // MCP is MSCA-only. An authenticated identity must resolve through an
    // explicit owner -> MSCA alias; never treat an EOA or an unbound wallet
    // record as the agent wallet. However, a self-alias (owner == MSCA) is
    // valid when the wallet is deployed as a smart account on-chain.
    const isSelfAlias = String(info.walletAddress).toLowerCase() === String(userId).toLowerCase()
    if (isSelfAlias) {
      // Self-alias is allowed only if the address is a deployed contract (MSCA)
      const { createPublicClient, http, defineChain } = await import('viem')
      const arcRpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
      const client = createPublicClient({ chain: defineChain({ id: 5042002, name: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [arcRpc] } } }), transport: http(arcRpc) })
      const code = await client.getBytecode({ address: info.walletAddress }).catch(() => undefined)
      if (!code || code === '0x') return null
    } else if (!hasExplicitSessionAlias(userId, info.walletAddress)) {
      return null
    }
    return info
  } catch {
    return null
  }
}

function mscaRequiredResult() {
  return {
    schemaVersion: 1,
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
    body: jsonText(body),
  })
  const data = await r.json().catch(() => ({}))
  return { ...(data && typeof data === 'object' ? data : {}), _httpStatus: r.status }
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

function executionChainKey(slug) {
  if (!slug) return undefined
  const s = String(slug).toLowerCase().trim()
  const aliases = {
    arc: 'arc-testnet',
    arc_testnet: 'arc-testnet',
    'eth-sepolia': 'ethereum-sepolia',
    ethereum_sepolia: 'ethereum-sepolia',
    base_sepolia: 'base-sepolia',
    arbitrum_sepolia: 'arbitrum-sepolia',
  }
  return aliases[s] || s
}

// CCTP bridge support for the MCP Agent Wallet. Each router address is
// chain-specific and mirrors the frontend's proven ArcoxRouter route. The
// router sees the MSCA as msg.sender inside the UserOperation; the user's EOA
// remains only the MCP tenant/auth identity.
const BRIDGE_CCTP = {
  Arc_Testnet: {
    chainId: 5042002,
    domain: 26,
    usdc: '0x3600000000000000000000000000000000000000',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    // Frontend uses CCTP V2 fast finality for all EVM routes.
    requiredFinalityThreshold: 1000,
    rpcUrl: resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' }),
    explorer: 'https://testnet.arcscan.app/tx/',
    router: process.env.ARCOX_FEE_ROUTER_ADDRESS || '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
  },
  Ethereum_Sepolia: { chainId: 11155111, domain: 0, requiredFinalityThreshold: 1000, explorer: 'https://sepolia.etherscan.io/tx/' },
  Base_Sepolia: {
    chainId: 84532,
    domain: 6,
    explorer: 'https://sepolia.basescan.org/tx/',
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    requiredFinalityThreshold: 1000,
    // Frontend's verified Base Sepolia ArcoxRouter.
    router: process.env.ARCOX_BASE_FEE_ROUTER_ADDRESS || '0x9425cC5b3C8B9e0FCb35beBdE737B4365A614Acc',
  },
  Arbitrum_Sepolia: {
    chainId: 421614,
    domain: 3,
    requiredFinalityThreshold: 1000,
    explorer: 'https://sepolia.arbiscan.io/tx/',
    rpcUrl: process.env.ARB_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    requiredFinalityThreshold: 1000,
    // Frontend's verified Arbitrum Sepolia ArcoxRouter.
    router: process.env.ARCOX_ARBITRUM_FEE_ROUTER_ADDRESS || '0x5dCAA895dDc7350cF0f9eb69E69536a4548b0cA7',
  },
  HyperEVM_Testnet: { domain: 19, requiredFinalityThreshold: 1000, explorer: 'https://app.hyperliquid-testnet.xyz/explorer/tx/' },
}
// The route is explicit opt-in so a deployment cannot start moving funds just
// because code was updated. Enable it only after the router and destination
// mint relayer have been configured and a small testnet transfer is approved.
const ENABLE_MSCA_CCTP_BRIDGE = process.env.ENABLE_MSCA_CCTP_BRIDGE === 'true'
const BRIDGE_ZERO_BYTES32 = `0x${'0'.repeat(64)}`
const BRIDGE_MAX_FEE = BigInt(process.env.CCTP_MAX_FEE_BASE_UNITS || '10')
const configuredBridgeFinalityThreshold = Number(process.env.CCTP_MIN_FINALITY_THRESHOLD || '1000')
// Circle CCTP V2 defines only 1000 (Confirmed) and 2000 (Finalized). Keep an
// invalid deployment setting from producing unsupported calldata; normalize it
// to the conservative confirmed threshold for non-Arc destinations.
const BRIDGE_MIN_FINALITY_THRESHOLD = [1000, 2000].includes(configuredBridgeFinalityThreshold)
  ? configuredBridgeFinalityThreshold
  : 1000

// Bind finality to the verified route configuration so a malformed route
// cannot inherit behavior merely because its numeric domain happens to match.
function bridgeFinalityThreshold(route) {
  const required = Number(route?.destination?.requiredFinalityThreshold)
  if (![1000, 2000].includes(required)) throw new Error('CCTP route finality threshold is not configured')
  return required
}
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
  { type: 'function', name: 'usdc', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tokenMessenger', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'localDomain', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'supportedDestinationDomains', stateMutability: 'view', inputs: [{ name: 'domain', type: 'uint32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'localMessageTransmitter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
function bridgeConfig(fromChain, toChain) {
  const source = BRIDGE_CCTP[chainKey(fromChain)]
  const destination = BRIDGE_CCTP[chainKey(toChain)]
  if (!source || !destination || source.domain === destination.domain) return null
  if (!source.router) return null
  return { fromKey: chainKey(fromChain), toKey: chainKey(toChain), source, destination }
}

// Circle Gas Station sponsorship is explicit for inbound bridges. The source
// approval and burn UserOperations on Base/Arbitrum must both use the same
// paymaster-aware fee profile; otherwise Base falls through to the generic
// UserOperation path and may charge the MSCA's native balance instead.
export function resolveMscaBridgeFeeProfile(route) {
  if (route?.toKey === 'Arc_Testnet' && route?.fromKey === 'Base_Sepolia') return 'base-to-arc-source'
  if (route?.toKey === 'Arc_Testnet' && route?.fromKey === 'Arbitrum_Sepolia') return 'arbitrum-to-arc-source'
  if (route?.fromKey === 'Arc_Testnet' && route?.toKey === 'Arbitrum_Sepolia') return 'arbitrum-destination'
  if (route?.fromKey === 'Arc_Testnet') return 'arc-bridge'
  return undefined
}

function bridgeRpcUrls(chainConfig) {
  const key = String(chainConfig?.name || '').toLowerCase()
  const chainId = Number(chainConfig?.chainId)
  const configured = key === 'arc_testnet' || chainId === 5042002
    ? arcRpcUrls({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
    : key === 'base_sepolia' || chainId === 84532
      ? [process.env.BASE_SEPOLIA_RPC_URL, 'https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com']
      : key === 'arbitrum_sepolia' || chainId === 421614
        ? [process.env.ARB_SEPOLIA_RPC_URL, 'https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com']
        : [chainConfig?.rpcUrl]
  return [...new Set(configured.filter(Boolean))]
}

function bridgePublicClient(chainConfig) {
  const rpcUrls = bridgeRpcUrls(chainConfig)
  if (!rpcUrls.length) throw new Error(`RPC not configured for ${chainConfig?.name || 'bridge chain'}`)
  const drpcKey = process.env.DRPC_KEY || ''
  const chain = defineChain({
    id: chainConfig.chainId,
    name: chainConfig.name,
    nativeCurrency: { name: chainConfig.name === 'Arc_Testnet' ? 'USDC' : 'ETH', symbol: chainConfig.name === 'Arc_Testnet' ? 'USDC' : 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  })
  const transports = rpcUrls.map(url => http(url, {
    timeout: 12_000,
    retryCount: 1,
    ...(drpcKey && url.includes('drpc.org') ? { fetchOptions: { headers: { Authorization: `Bearer ${drpcKey}` } } } : {}),
  }))
  return createPublicClient({ chain, transport: fallback(transports, { retryCount: 2, rank: false }) })
}

// Expose the route capability as a pure predicate for regression tests and
// diagnostics. A configured CCTP destination alone is not enough: the source
// ArcoxRouter must also be deployed/configured, otherwise a burn cannot be
// safely initiated from the MSCA.
export function isMscaCctpRouteConfigured(fromChain, toChain) {
  const route = bridgeConfig(fromChain, toChain)
  return Boolean(route?.source?.router && route?.destination?.messageTransmitter)
}

// Keep the deployed-router checks pure so they can be regression-tested without
// a live RPC. This is deliberately stricter than merely checking that bytecode
// exists: a wrong router/token/domain can burn funds into an untrackable route.
export function compareRouterRouteConfiguration({ code, configuredUsdc, configuredMessenger, localDomain, supportedDestination, route } = {}) {
  const mismatches = []
  if (!code || code === '0x') mismatches.push('router_not_deployed')
  if (String(configuredUsdc || '').toLowerCase() !== String(route?.source?.usdc || '').toLowerCase()) mismatches.push('router_usdc_mismatch')
  if (String(configuredMessenger || '').toLowerCase() !== String(route?.source?.tokenMessenger || '').toLowerCase()) mismatches.push('router_token_messenger_mismatch')
  if (Number(localDomain) !== Number(route?.source?.domain)) mismatches.push('router_source_domain_mismatch')
  if (supportedDestination !== true) mismatches.push('router_destination_domain_not_enabled')
  return mismatches
}

async function validateRouterRoute(route) {
  const client = bridgePublicClient(route.source)
  const router = getAddress(route.source.router)
  const [code, configuredUsdc, configuredMessenger, localDomain, supportedDestination] = await Promise.all([
    client.getBytecode({ address: router }),
    client.readContract({ address: router, abi: BRIDGE_ROUTER_ABI, functionName: 'usdc' }),
    client.readContract({ address: router, abi: BRIDGE_ROUTER_ABI, functionName: 'tokenMessenger' }),
    client.readContract({ address: router, abi: BRIDGE_ROUTER_ABI, functionName: 'localDomain' }),
    client.readContract({ address: router, abi: BRIDGE_ROUTER_ABI, functionName: 'supportedDestinationDomains', args: [route.destination.domain] }),
  ])
  const mismatches = compareRouterRouteConfiguration({ code, configuredUsdc, configuredMessenger, localDomain, supportedDestination, route })
  if (mismatches.length) throw new Error(`ArcoxRouter CCTP route validation failed: ${mismatches.join(', ')}`)

  const destinationClient = bridgePublicClient(route.destination)
  const destinationMessenger = getAddress(route.destination.tokenMessenger)
  const destinationTransmitter = getAddress(route.destination.messageTransmitter)
  const [destinationMessengerCode, destinationTransmitterCode, configuredTransmitter] = await Promise.all([
    destinationClient.getBytecode({ address: destinationMessenger }),
    destinationClient.getBytecode({ address: destinationTransmitter }),
    destinationClient.readContract({ address: destinationMessenger, abi: BRIDGE_ROUTER_ABI, functionName: 'localMessageTransmitter' }),
  ])
  if (!destinationMessengerCode || destinationMessengerCode === '0x') throw new Error('CCTP destination TokenMessenger is not deployed')
  if (!destinationTransmitterCode || destinationTransmitterCode === '0x') throw new Error('CCTP destination MessageTransmitter is not deployed')
  if (String(configuredTransmitter).toLowerCase() !== destinationTransmitter.toLowerCase()) throw new Error('CCTP destination MessageTransmitter mismatch')
  return { router, usdc: getAddress(configuredUsdc), tokenMessenger: getAddress(configuredMessenger), localDomain: Number(localDomain), destinationDomain: route.destination.domain }
}

async function getRouterFeeQuote(route, amount) {
  const client = bridgePublicClient(route.source)
  await validateRouterRoute(route)
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
export function buildMscaRouterBridgeCalls({ route, amount, mintRecipient, maxFee = BRIDGE_MAX_FEE, minFinalityThreshold }) {
  if (!route?.source?.router || !route?.source?.usdc || route?.destination?.domain === undefined) throw new Error('Invalid ArcoxRouter bridge route')
  const grossAmount = BigInt(amount)
  const requiredFinalityThreshold = bridgeFinalityThreshold(route)
  if (minFinalityThreshold !== undefined && Number(minFinalityThreshold) !== requiredFinalityThreshold) {
    throw new Error('CCTP route finality threshold mismatch')
  }
  const finalityThreshold = requiredFinalityThreshold
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
        args: [grossAmount, route.destination.domain, recipientBytes32, BRIDGE_ZERO_BYTES32, BigInt(maxFee), finalityThreshold],
      }),
    },
  ]
}

async function verifyBridgeBurn({ burnTxHash, route, walletAddress, amount }) {
  const client = bridgePublicClient(route.source)
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

function hexUint(raw, start, end) {
  const value = raw.slice(start, end)
  return value ? BigInt(`0x${value}`) : 0n
}

function bytes32EvmAddress(value) {
  const word = String(value || '').toLowerCase()
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) return null
  return `0x${word.slice(24)}`
}

// CCTP V2 has two distinct recipient concepts:
//   - Message header recipient: destination TokenMessenger (a contract).
//   - Burn message-body mintRecipient: final beneficiary (our MSCA).
// Comparing the header recipient directly to the MSCA creates a false
// `cctp_message_recipient_unverified` rejection and hides a valid attestation.
export function decodeCctpMessage(message) {
  const raw = String(message || '').replace(/^0x/i, '').toLowerCase()
  // CCTP V2 header: uint32 version/source/destination, then bytes32 nonce,
  // bytes32 sender/recipient/destinationCaller, then uint32 finality fields.
  // Total header size is 148 bytes (296 hex chars).
  if (!/^[0-9a-f]*$/.test(raw) || raw.length < 296) return null
  const header = {
    version: Number(hexUint(raw, 0, 8)),
    sourceDomain: Number(hexUint(raw, 8, 16)),
    destinationDomain: Number(hexUint(raw, 16, 24)),
    nonce: `0x${raw.slice(24, 88)}`,
    sender: bytes32EvmAddress(raw.slice(88, 152)),
    recipient: bytes32EvmAddress(raw.slice(152, 216)),
    destinationCaller: bytes32EvmAddress(raw.slice(216, 280)),
    minFinalityThreshold: Number(hexUint(raw, 280, 288)),
    finalityThresholdExecuted: Number(hexUint(raw, 288, 296)),
  }
  const bodyRaw = raw.slice(296)
  let messageBody = null
  // CCTP V2 burn body: version, burnToken, mintRecipient, amount,
  // messageSender, maxFee, feeExecuted, expirationBlock, hookData.
  if (bodyRaw.length >= 456) {
    messageBody = {
      version: Number(hexUint(bodyRaw, 0, 8)),
      burnToken: bytes32EvmAddress(bodyRaw.slice(8, 72)),
      mintRecipient: bytes32EvmAddress(bodyRaw.slice(72, 136)),
      amount: hexUint(bodyRaw, 136, 200),
      messageSender: bytes32EvmAddress(bodyRaw.slice(200, 264)),
      maxFee: hexUint(bodyRaw, 264, 328),
      feeExecuted: hexUint(bodyRaw, 328, 392),
      expirationBlock: hexUint(bodyRaw, 392, 456),
      hookData: bodyRaw.slice(456) ? `0x${bodyRaw.slice(456)}` : null,
    }
  }
  return { ...header, messageBody }
}

export function decodeCctpMessageHeader(message) {
  return decodeCctpMessage(message)
}

export function selectCctpMessage(messages, sourceDomain, destinationDomain, binding = {}) {
  const candidates = (Array.isArray(messages) ? messages : []).map((message, index) => ({
    message,
    index,
    decoded: decodeCctpMessage(message?.message),
  }))
  const domainCandidates = candidates.filter(item => item.decoded && item.decoded.sourceDomain === Number(sourceDomain) && item.decoded.destinationDomain === Number(destinationDomain))
  const expectedSender = binding.route?.source?.tokenMessenger ? getAddress(binding.route.source.tokenMessenger).toLowerCase() : null
  const expectedRecipient = binding.route?.destination?.tokenMessenger ? getAddress(binding.route.destination.tokenMessenger).toLowerCase() : null
  const expectedMintRecipient = binding.walletAddress ? getAddress(binding.walletAddress).toLowerCase() : null
  // ArcoxRouter calls TokenMessengerV2.depositForBurn. CCTP BurnMessageV2
  // messageSender is the direct caller of depositForBurn: the source router,
  // not the TokenMessenger that receives the forwarded call.
  const expectedMessageSender = binding.route?.source?.router ? getAddress(binding.route.source.router).toLowerCase() : null
  const expectedBurnToken = binding.route?.source?.usdc ? getAddress(binding.route.source.usdc).toLowerCase() : null
  const expectedAmount = binding.expectedBurnAmount === undefined ? null : BigInt(binding.expectedBurnAmount)
  const selected = domainCandidates.find(item => {
    if (!binding.route && !binding.walletAddress && expectedAmount === null) return true
    const body = item.decoded.messageBody
    return item.decoded.sender === expectedSender
      && item.decoded.recipient === expectedRecipient
      && body?.mintRecipient === expectedMintRecipient
      && body?.messageSender === expectedMessageSender
      && body?.burnToken === expectedBurnToken
      && (expectedAmount === null || body?.amount === expectedAmount)
  })
  // Preserve the first domain-matching decoded message as diagnostics when no
  // candidate binds. This prevents a generic route_unverified response from
  // hiding the actual header/body that Iris returned for this burn hash.
  const diagnostic = selected?.decoded || domainCandidates[0]?.decoded || null
  return {
    selected: selected?.message || null,
    decoded: selected?.decoded || null,
    diagnostic,
    candidates: candidates.map(item => ({
      index: item.index,
      sourceDomain: item.decoded?.sourceDomain ?? null,
      destinationDomain: item.decoded?.destinationDomain ?? null,
      headerSender: item.decoded?.sender || null,
      headerRecipient: item.decoded?.recipient || null,
      mintRecipient: item.decoded?.messageBody?.mintRecipient || null,
      messageSender: item.decoded?.messageBody?.messageSender || null,
      burnToken: item.decoded?.messageBody?.burnToken || null,
      amount: item.decoded?.messageBody?.amount?.toString() || null,
      messageStatus: item.message?.status || null,
    })),
  }
}

// Iris may briefly expose a non-empty candidate list before the exact burn
// message is fully indexed. Treat only this binding result as transient while
// polling; domain/token/recipient mismatches remain fail-closed rejections.
export async function waitForCctpBridgeStatus(args, options = {}) {
  const attempts = options.attempts ?? (Number(args?.destinationDomain) === 26 ? 120 : 40)
  const delayMs = options.delayMs ?? (Number(args?.destinationDomain) === 26 ? 5000 : 3000)
  const autoMintAfterMs = options.autoMintAfterMs ?? 30_000
  const autoMintRetryMs = options.autoMintRetryMs ?? 60_000
  const now = options.now || (() => Date.now())
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const startedAt = now()
  let autoMintQueued = false
  let autoMintAttemptedAt = 0
  let lastStatus = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    lastStatus = await getCctpBridgeStatus(args)
    // Only an empty/not-yet-indexed Iris response is transient. A non-empty
    // response that fails exact route binding is terminal for this burn hash;
    // polling cannot repair a cryptographic route mismatch and must not make a
    // user wait while presenting an unsafe retry posture.
    const transientAttestation = lastStatus.status === 'pending'
      && ['cctp_message_pending', 'cctp_attestation_unavailable'].includes(lastStatus.reason)
    if (!transientAttestation) return { ...lastStatus, autoMintQueued }
    const elapsedMs = now() - startedAt
    if (!autoMintQueued && typeof options.onPending === 'function' && elapsedMs >= autoMintAfterMs && (autoMintAttemptedAt === 0 || now() - autoMintAttemptedAt >= autoMintRetryMs)) {
      autoMintAttemptedAt = now()
      try {        const queued = await options.onPending({ ...lastStatus, burnTxHash: args.burnTxHash, elapsedMs })
        autoMintQueued = queued !== false
      } catch {
        // Queue registration is best-effort. Manual status/retry remains
        // available, and a later retry is rate-limited by autoMintRetryMs.
      }
    }
    if (attempt + 1 < attempts) await sleep(delayMs)
  }
  return { ...(lastStatus || { status: 'pending', burnTxHash: args.burnTxHash, verified: false, reason: 'cctp_message_pending' }), autoMintQueued }
}

export async function getCctpBridgeStatus({ burnTxHash, sourceDomain, destinationDomain, walletAddress, route, expectedBurnAmount }) {
  const url = `https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}?transactionHash=${encodeURIComponent(burnTxHash)}`
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) return { status: 'pending', burnTxHash, verified: false, reason: 'cctp_message_pending' }
    const data = await response.json()
    const selection = selectCctpMessage(data?.messages, sourceDomain, destinationDomain, { route, walletAddress, expectedBurnAmount })
    const message = selection.selected
    const header = selection.decoded
    if (!message) {
      // Iris can return an empty message list while the source burn is still
      // being indexed. That is transient and must not be reported as a
      // permanent route mismatch. A non-empty list with no fully-bound match
      // remains fail-closed below as a real binding rejection.
      const pendingCandidate = Array.isArray(data?.messages) && data.messages.some(item => {
        const status = String(item?.status || '').toLowerCase()
        return !item?.message || ['pending', 'pending_confirmations', 'unknown', 'processing'].includes(status)
      })
      if (!Array.isArray(data?.messages) || data.messages.length === 0 || pendingCandidate) {
        return {
          status: 'pending', burnTxHash, verified: false, reason: 'cctp_message_pending',
          messageStatus: data?.messages?.find(item => item?.status)?.status || 'pending',
          messageHeader: header, messageCandidates: selection.candidates,
        }
      }
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_route_unverified',
        messageHeader: selection.diagnostic,
        messageCandidates: selection.candidates,
        expectedRoute: {
          sourceDomain: Number(sourceDomain),
          destinationDomain: Number(destinationDomain),
          headerSender: route?.source?.tokenMessenger ? getAddress(route.source.tokenMessenger).toLowerCase() : null,
          headerRecipient: route?.destination?.tokenMessenger ? getAddress(route.destination.tokenMessenger).toLowerCase() : null,
          mintRecipient: walletAddress ? getAddress(walletAddress).toLowerCase() : null,
          messageSender: route?.source?.router ? getAddress(route.source.router).toLowerCase() : null,
          burnToken: route?.source?.usdc ? getAddress(route.source.usdc).toLowerCase() : null,
          amount: expectedBurnAmount === undefined ? null : BigInt(expectedBurnAmount).toString(),
        },
      }
    }
    const expectedHeaderSender = route?.source?.tokenMessenger
      ? getAddress(route.source.tokenMessenger).toLowerCase()
      : null
    if (!expectedHeaderSender || header.sender !== expectedHeaderSender) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_sender_unverified',
        expectedSender: expectedHeaderSender,
        actualSender: header.sender,
        messageHeader: header,
      }
    }
    const expectedHeaderRecipient = route?.destination?.tokenMessenger
      ? getAddress(route.destination.tokenMessenger).toLowerCase()
      : null
    if (!expectedHeaderRecipient || header.recipient !== expectedHeaderRecipient) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_recipient_unverified',
        expectedRecipient: expectedHeaderRecipient,
        actualRecipient: header.recipient,
        messageHeader: header,
      }
    }
    const expectedFinality = bridgeFinalityThreshold(route)
    const supportedFinality = value => value === 1000 || value === 2000
    // CCTP may execute at a stronger finality than requested. Require a
    // supported threshold and at least the route's configured minimum rather
    // than requiring an exact equality for the executed value.
    if (!supportedFinality(header.minFinalityThreshold)
      || !supportedFinality(header.finalityThresholdExecuted)
      || header.finalityThresholdExecuted < expectedFinality) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_finality_unverified',
        expectedFinalityThreshold: expectedFinality,
        actualMinFinalityThreshold: header.minFinalityThreshold,
        actualFinalityThresholdExecuted: header.finalityThresholdExecuted,
        messageHeader: header,
      }
    }
    const body = header.messageBody
    const expectedMintRecipient = getAddress(walletAddress).toLowerCase()
    if (!body || body.mintRecipient !== expectedMintRecipient) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_mint_recipient_unverified',
        expectedMintRecipient,
        actualMintRecipient: body?.mintRecipient || null,
        messageHeader: header,
        messageBody: body,
      }
    }
    // CCTP BurnMessageV2.messageSender is the direct caller of
    // TokenMessengerV2.depositForBurn: our source ArcoxRouter.
    const expectedSender = route?.source?.router ? getAddress(route.source.router).toLowerCase() : null
    if (!body.messageSender || body.messageSender !== expectedSender) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_sender_unverified',
        expectedSender,
        actualSender: body?.messageSender || null,
        messageHeader: header,
        messageBody: body,
      }
    }
    const expectedBurnToken = route?.source?.usdc ? getAddress(route.source.usdc).toLowerCase() : null
    if (!body.burnToken || body.burnToken !== expectedBurnToken) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_token_unverified',
        expectedBurnToken,
        actualBurnToken: body?.burnToken || null,
        messageHeader: header,
        messageBody: body,
      }
    }
    if (expectedBurnAmount !== undefined && (!body.amount || body.amount !== BigInt(expectedBurnAmount))) {
      return {
        status: 'rejected', burnTxHash, verified: false,
        reason: 'cctp_message_amount_unverified',
        expectedBurnAmount: BigInt(expectedBurnAmount).toString(),
        actualBurnAmount: body?.amount?.toString() || null,
        messageHeader: header,
        messageBody: body,
      }
    }
    const hasAttestation = Boolean(message.attestation && message.message)
    if (!hasAttestation) {
      return {
        status: 'pending', burnTxHash, verified: false,
        reason: 'cctp_message_pending',
        walletAddress,
        message: message.message || null,
        attestation: message.attestation || null,
        messageStatus: message.status || 'pending',
        sourceDomain,
        destinationDomain,
        messageHeader: header,
        messageBody: body,
      }
    }
    const cctpFeeExecuted = body.feeExecuted ?? 0n
    const netMintAmount = body.amount >= cctpFeeExecuted ? body.amount - cctpFeeExecuted : null
    return {
      status: 'attestation_ready',
      burnTxHash,
      verified: hasAttestation,
      walletAddress,
      message: message.message || null,
      attestation: message.attestation || null,
      messageStatus: message.status || 'pending',
      sourceDomain,
      destinationDomain,
      cctpFeeExecuted: cctpFeeExecuted.toString(),
      netMintAmount: netMintAmount === null ? null : netMintAmount.toString(),
      messageHeader: header,
      messageBody: body,
    }
  } catch (error) {
    const messageText = String(error?.message || '')
    // Network/IRIS availability is transient; malformed or invalid CCTP data
    // must remain rejected and must never be presented as safe to retry.
    if (messageText.includes('cctp_message') || messageText.includes('decode') || messageText.includes('invalid')) {
      return { status: 'rejected', burnTxHash, verified: false, reason: 'cctp_message_decode_failed', error: messageText }
    }
    return { status: 'pending', burnTxHash, verified: false, reason: 'cctp_attestation_unavailable' }
  }
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ name: 'success', type: 'bool' }],
}]
const USED_NONCES_ABI = [{
  type: 'function', name: 'usedNonces', stateMutability: 'view',
  inputs: [{ name: 'nonce', type: 'bytes32' }],
  outputs: [{ name: '', type: 'uint256' }],
}]

// CCTP V2 nonce is the 32-byte field immediately after version/source/domain.
// Keep this separate from the decoded address fields so destination mint
// idempotency can be checked without submitting another UserOperation.
export function extractCctpMessageNonce(message) {
  const raw = String(message || '').replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]+$/.test(raw) || raw.length < 88) return null
  return `0x${raw.slice(24, 88)}`
}

export function destinationNonceDecision({ checked, processed } = {}) {
  if (processed === true) return 'minted'
  if (checked !== true) return 'unavailable'
  return 'not_minted'
}

// A hashless destination submission is ambiguous while the bundler may still
// be indexing it. Only the explicit retry tool may recover such an intent, and
// only after a short cooldown; normal status polling remains fail-closed.
export const HASHLESS_DESTINATION_RECOVERY_DELAY_MS = 60_000
export function hashlessDestinationRetryAllowed(approval, now = Date.now()) {
  const recordedAt = Number(approval?.updatedAt || approval?.createdAt || 0)
  return Number.isFinite(recordedAt)
    && recordedAt > 0
    && now - recordedAt >= HASHLESS_DESTINATION_RECOVERY_DELAY_MS
}

export async function destinationMintAlreadyProcessed({ status, route, client: injectedClient } = {}) {
  const nonce = extractCctpMessageNonce(status?.message)
  const rpcUrl = route?.destination?.rpcUrl
  const messageTransmitter = route?.destination?.messageTransmitter
  if (!nonce || !rpcUrl || !messageTransmitter) return { checked: false, processed: false, nonce, reason: 'destination_nonce_check_unavailable' }
  try {
    const destinationInfo = {
      Arc_Testnet: { id: 5042002 },
      Base_Sepolia: { id: 84532 },
      Arbitrum_Sepolia: { id: 421614 },
    }[route.toKey]
    if (!destinationInfo) return { checked: false, processed: false, nonce, reason: 'destination_nonce_check_unavailable' }
    const client = injectedClient || bridgePublicClient(route.destination)
    const processed = await client.readContract({
      address: getAddress(messageTransmitter),
      abi: USED_NONCES_ABI,
      functionName: 'usedNonces',
      args: [nonce],
    })
    return { checked: true, processed: Boolean(processed), nonce }
  } catch {
    // A failed read must never be treated as not minted. Do not submit a
    // destination UserOperation until idempotency can be proven.
    return { checked: false, processed: false, nonce, reason: 'destination_nonce_check_unavailable' }
  }
}

async function destinationMscaPreflight({ route, walletAddress, requireAuthorization = true }) {
  const destinationInfo = {
    Arc_Testnet: { id: 5042002, chainKey: 'arc-testnet' },
    Base_Sepolia: { id: 84532, chainKey: 'base-sepolia' },
    Arbitrum_Sepolia: { id: 421614, chainKey: 'arbitrum-sepolia' },
  }[route?.toKey]
  if (!destinationInfo) return { ok: false, reason: 'destination_msca_route_not_supported', message: 'Destination MSCA UserOperation belum mendukung chain tujuan ini.' }
  if (!route?.destination?.rpcUrl || !route.destination.messageTransmitter) return { ok: false, reason: 'destination_chain_not_configured' }
  const { createPublicClient } = await import('viem')
  const rpcUrls = [...new Set([
    route.destination.rpcUrl,
    ...(route.toKey === 'Arc_Testnet' ? arcRpcUrls({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' }) : []),
    ...(route.toKey === 'Base_Sepolia' ? [process.env.BASE_SEPOLIA_RPC_URL, 'https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'] : []),
    ...(route.toKey === 'Arbitrum_Sepolia' ? [process.env.ARB_SEPOLIA_RPC_URL, 'https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia-rpc.publicnode.com'] : []),
  ].filter(Boolean))]
  let code
  let sawSuccessfulRpcRead = false
  for (const rpcUrl of rpcUrls) {
    const retryClient = createPublicClient({
      chain: defineChain({ id: destinationInfo.id, name: route.toKey, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }),
      transport: http(rpcUrl),
    })
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        code = await retryClient.getBytecode({ address: getAddress(walletAddress) })
        sawSuccessfulRpcRead = true
        if (code && code !== '0x') break
      } catch {
        // Try the next attempt/provider; a single RPC miss is not proof that
        // the deterministic MSCA is absent.
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
    }
    if (code && code !== '0x') break
  }
  // A successful eth_getCode response is authoritative even when another
  // provider/attempt failed. Only classify the destination as unavailable when
  // every provider failed; a successful 0x response is a definitive
  // not-deployed result and must not be reported as an RPC outage.
  if (!sawSuccessfulRpcRead) {
    return { ok: false, reason: 'destination_rpc_unavailable', message: `RPC destination ${route.toKey} belum dapat memverifikasi deployment MSCA setelah retry/fallback. Tidak ada transaksi yang dikirim; coba status lagi.` }
  }
  if (!code || code === '0x') return { ok: false, reason: 'destination_msca_not_deployed', message: `MSCA ${walletAddress} belum terdeteksi deployed di ${route.toKey}; deploy MSCA via Plugin passkey sebelum bridge.` }
  if (requireAuthorization) {
    const { isSessionAuthorizedForChain } = await import('./sessionKeyService.mjs')
    if (!isSessionAuthorizedForChain(walletAddress, destinationInfo.chainKey)) {
      return { ok: false, reason: 'destination_msca_session_not_authorized', message: `Delegate session belum diotorisasi di ${route.toKey}. Jalankan setup destination chain via Plugin passkey.` }
    }
  }
  return { ok: true }
}

async function findPendingBridgeMint(userId, burnTxHash, toKey) {
  try {
    const vault = await import('./vaultStore.mjs')
    for (const approval of vault.listApprovals(userId) || []) {
      if (!['pending_confirmation', 'pending_signature'].includes(approval.status)) continue
      let details
      try { details = JSON.parse(approval.details || '{}') } catch { details = null }
      if (details?.burnTxHash !== burnTxHash || details?.toChain !== toKey) continue
      if (!details.destinationChainKey) continue
      return {
        approval,
        phase: details.settlementPhase || (details.destinationUserOpHash ? 'destination_submitted' : 'intent_created'),
        userOpHash: details.destinationUserOpHash || null,
        chainKey: details.destinationChainKey,
      }
    }
  } catch { /* status/retry remains fail-closed below */ }
  return null
}

// Classify the source phase using burn evidence only. An approval UserOperation
// is not a burn: it may have a hash even when the later router call was rejected
// before submission. This distinction is what lets a failed burn be treated as
// "never happened" without ever bypassing an accepted/ambiguous burn.
export function classifySourceBridgeBurn(details = {}, approval = {}) {
  const phase = String(details?.settlementPhase || '')
  const burnTxHash = details?.burnTxHash || null
  const burnUserOpHash = details?.sourceUserOpHash || null
  if (burnTxHash) return 'burn_confirmed'
  if (burnUserOpHash) {
    const reason = String(details?.reason || approval?.error || '').toLowerCase()
    const terminal = details?.safeToRetry === true && [
      'bundler_account_reputation_limit',
      'bundler_stake_requirement',
      'user_operation_precheck_failed',
      'transaction_reverted',
      'transaction_failed',
      'user_operation_failed',
    ].includes(reason)
    return terminal ? 'burn_failed' : 'burn_unresolved'
  }
  if (['source_submission_failed', 'source_approval_failed'].includes(phase)
    && details?.safeToRetry === true
    && ['bundler_account_reputation_limit', 'bundler_stake_requirement', 'user_operation_precheck_failed', 'transaction_reverted', 'transaction_failed', 'user_operation_failed'].includes(String(details?.reason || '').toLowerCase())) {
    return 'burn_failed'
  }
  if (['source_intent_created', 'source_approval_unknown', 'source_approval_submitted', 'source_approval_confirmed', 'source_submission_unknown', 'source_submitted', 'source_confirmed', 'source_submission_failed', 'source_approval_failed'].includes(phase)) return 'burn_unresolved'
  return 'none'
}

// A new quote must not bypass an unresolved source UserOperation by using a
// different previewId. Explicitly terminal burn failures are different: the
// bundler/receipt proved the router burn did not succeed, so no source funds
// moved and a fresh quote is safe. Any accepted hash, timeout, or hashless
// record without a proven terminal failure remains fail-closed.
export function hasUnresolvedSourceBridgeIntent(approvals, { fromChain, toChain, walletAddress } = {}) {
  const pendingPhases = new Set(['source_intent_created', 'source_approval_unknown', 'source_approval_submitted', 'source_approval_confirmed', 'source_submission_unknown', 'source_submitted', 'source_confirmed'])
  const expectedFrom = String(fromChain || '').toLowerCase()
  const expectedTo = String(toChain || '').toLowerCase()
  const expectedWallet = String(walletAddress || '').toLowerCase()
  const completedBurnHashes = new Set()
  for (const approval of Array.isArray(approvals) ? approvals : []) {
    if (approval?.action !== 'bridge') continue
    let details
    try { details = JSON.parse(approval.details || '{}') } catch { continue }
    if (details?.burnTxHash && (details?.mintTxHash || details?.destinationMintStatus === 'minted' || details?.settlementStatus === 'success' || approval?.status === 'success')) {
      completedBurnHashes.add(String(details.burnTxHash).toLowerCase())
    }
  }
  for (const approval of Array.isArray(approvals) ? approvals : []) {
    if (approval?.action !== 'bridge') continue
    let details
    try { details = JSON.parse(approval.details || '{}') } catch { continue }
    if (String(details?.fromChain || '').toLowerCase() !== expectedFrom || String(details?.toChain || '').toLowerCase() !== expectedTo) continue
    const storedWallet = String(details?.walletAddress || '').toLowerCase()
    // Missing wallet binding is not evidence that the intent belongs to a
    // different wallet. Fail closed and block the same user's route.
    if (expectedWallet && storedWallet && storedWallet !== expectedWallet) continue
    if (details?.burnTxHash && completedBurnHashes.has(String(details.burnTxHash).toLowerCase())) continue
    // A legacy Circle/frontend bridge record can contain a burn hash even after
    // destination mint already completed. It remains recoverable by the
    // explicit burn-hash retry tool, but it is not an unresolved source intent
    // and must not block a new quote forever.
    if (details?.mintTxHash || details?.destinationMintStatus === 'minted' || details?.settlementStatus === 'success' || approval?.status === 'success') continue

    const burnState = classifySourceBridgeBurn(details, approval)
    if (burnState === 'burn_failed' || burnState === 'none') continue
    if (burnState === 'burn_confirmed') return { approval, details }

    const unknownSubmission = details?.settlementPhase === 'source_submission_unknown'
      || (details?.settlementPhase === 'source_submission_failed' && burnState === 'burn_unresolved')
    if (!['pending_confirmation', 'pending_signature'].includes(approval?.status) && !unknownSubmission) continue
    if (!pendingPhases.has(details?.settlementPhase) && !unknownSubmission) continue
    return { approval, details }
  }
  return null
}

/**
 * An approval-only intent can become stale when Circle retains the approval
 * UserOperation in its pending index. It has not called the router and cannot
 * create a CCTP burn, so it is safe to supersede before starting a new quote,
 * even if the current session/delegate is unchanged.
 *
 * Never classify a record with a source burn hash (or a burn tx hash) this way:
 * an accepted/ambiguous burn remains blocked regardless of previewId.
 */
export function isStaleApprovalOnlySourceIntent(candidate, { sessionDelegateAddress, sessionCreatedAt } = {}) {
  const approval = candidate?.approval || candidate
  const rawDetails = candidate?.details ?? approval?.details
  const details = typeof rawDetails === 'string'
    ? (() => { try { return JSON.parse(rawDetails || '{}') } catch { return {} } })()
    : (rawDetails || {})
  if (!approval || approval.action !== 'bridge') return false
  const phase = String(details.settlementPhase || '')
  if (!['source_approval_unknown', 'source_approval_submitted', 'source_approval_confirmed'].includes(phase)) return false
  if (details.sourceUserOpHash || details.burnTxHash || approval.txHash) return false

  // Approval only moves no USDC to the router. Even when its UserOperation is
  // still pending under the current session, it is safe to supersede the local
  // bridge intent and create a fresh quote: the source burn is the only
  // irreversible step, and this record has no burn hash. A still-pending
  // approval may later confirm, but it can only grant allowance; it cannot mint
  // or burn by itself.
  if (!details.sourceUserOpHash && !details.burnTxHash && !approval.txHash) return true
  const currentDelegate = String(sessionDelegateAddress || '').toLowerCase()
  const storedDelegate = String(details.sessionDelegateAddress || '').toLowerCase()
  const currentCreated = Number(sessionCreatedAt)
  const storedCreated = Number(details.sessionCreatedAt)
  const approvalCreated = Number(approval.createdAt)
  const delegateChanged = Boolean(currentDelegate && storedDelegate && currentDelegate !== storedDelegate)
  const sessionChanged = Number.isFinite(currentCreated) && currentCreated > 0 && (
    (Number.isFinite(storedCreated) && storedCreated > 0 && storedCreated < currentCreated)
      || (!storedCreated && Number.isFinite(approvalCreated) && approvalCreated > 0 && approvalCreated < currentCreated)
  )
  return delegateChanged || sessionChanged
}

async function supersedeStaleSourceApproval(userId, candidate, session) {
  if (!candidate?.approval?.id) return
  try {
    const vault = await import('./vaultStore.mjs')
    const details = candidate.details || {}
    vault.updateApprovalStatus(userId, candidate.approval.id, 'error', {
      error: 'source_approval_superseded_after_session_change',
      details: jsonText({
        ...details,
        settlementPhase: 'source_approval_superseded',
        settlementStatus: 'error',
        supersededAt: new Date().toISOString(),
        supersededBySessionDelegate: session?.delegateAddress || null,
        safeToRetry: true,
      }),
    })
  } catch {
    // The old record has no burn. A persistence failure must not prevent a
    // fresh quote, but it also must not alter the burn safety guard below.
  }
}

async function findPendingSourceIntent(userId, { fromChain, toChain, previewId, walletAddress } = {}) {
  try {
    const vault = await import('./vaultStore.mjs')
    for (const approval of vault.listApprovals(userId) || []) {
      if (!['pending_confirmation', 'pending_signature'].includes(approval.status)) continue
      let details
      try { details = JSON.parse(approval.details || '{}') } catch { details = null }
      if (!['source_intent_created', 'source_approval_unknown', 'source_approval_submitted', 'source_approval_confirmed', 'source_submission_unknown', 'source_submitted', 'source_confirmed'].includes(details?.settlementPhase)) continue
      if (details?.fromChain !== fromChain || details?.toChain !== toChain || details?.previewId !== previewId) continue
      if (walletAddress && details?.walletAddress && String(details.walletAddress).toLowerCase() !== String(walletAddress).toLowerCase()) continue
      return { approval, details }
    }
  } catch { /* source intent recovery remains fail-closed */ }
  return null
}

// Frontend-parity source lifecycle: approve and burn are separate UserOps.
// Prefer the burn hash once it exists; otherwise poll the approval hash.
export function sourceBridgePendingOperation(details = {}) {
  if (details.sourceUserOpHash) return { kind: 'burn', hash: details.sourceUserOpHash, phase: 'source_submitted' }
  if (details.sourceApprovalUserOpHash) return { kind: 'approval', hash: details.sourceApprovalUserOpHash, phase: 'source_approval_submitted' }
  return null
}

async function findPendingBridgeIntent(userId, burnTxHash, toKey) {
  try {
    const vault = await import('./vaultStore.mjs')
    for (const approval of vault.listApprovals(userId) || []) {
      if (!['pending_confirmation', 'pending_signature'].includes(approval.status)) continue
      let details
      try { details = JSON.parse(approval.details || '{}') } catch { details = null }
      if (details?.burnTxHash === burnTxHash && details?.toChain === toKey && details?.destinationChainKey && !details.destinationUserOpHash) {
        return { approval, details, phase: details.settlementPhase || 'intent_created' }
      }
    }
  } catch { /* fail closed in the mint path */ }
  return null
}

async function recordBridgePending(userId, {
  agent, amount, fromChain, toChain, previewId, burnTxHash, sourceApprovalUserOpHash, sourceUserOpHash,
  sourceChainKey, sourceExplorerUrl, walletAddress, sessionDelegateAddress, sessionCreatedAt,
  destinationUserOpHash, destinationChainKey, settlementPhase, error,
} = {}) {
  const vault = await import('./vaultStore.mjs')
  const approval = vault.createApproval(userId, {
    agent: agent || 'mcp-agent', action: 'bridge', amount, token: 'USDC', source: 'session',
    details: jsonText({
      fromChain, toChain, previewId, amount: String(amount ?? ''), burnTxHash: burnTxHash || null,
      sourceApprovalUserOpHash: sourceApprovalUserOpHash || null,
      sourceUserOpHash: sourceUserOpHash || null,
      sourceChainKey: sourceChainKey || null,
      walletAddress: walletAddress || null,
      sessionDelegateAddress: sessionDelegateAddress || null,
      sessionCreatedAt: sessionCreatedAt || null,
      destinationUserOpHash: destinationUserOpHash || null,
      destinationChainKey: destinationChainKey || null,
      settlementStatus: 'pending_confirmation',
      settlementPhase: settlementPhase || (destinationUserOpHash ? 'destination_submitted' : 'source_submitted'),
    }),
    forcePending: true,
  })
  vault.updateApprovalStatus(userId, approval.id, 'pending_confirmation', {
    txHash: burnTxHash,
    explorerUrl: sourceExplorerUrl,
    userOpHash: destinationUserOpHash || sourceUserOpHash || sourceApprovalUserOpHash,
    error,
  })
  return approval.id
}

async function updateBridgePending(userId, approvalId, details, status = 'pending_confirmation', extra = {}) {
  if (!approvalId) return
  try {
    const vault = await import('./vaultStore.mjs')
    vault.updateApprovalStatus(userId, approvalId, status, { ...extra, details: jsonText(details) })
  } catch { /* audit persistence must not change transaction safety */ }
}

async function markBridgePendingResolved(userId, pending, status, extra = {}) {
  if (!pending?.approval?.id) return
  try {
    const vault = await import('./vaultStore.mjs')
    vault.updateApprovalStatus(userId, pending.approval.id, status, extra)
  } catch { /* audit persistence must not change transaction safety */ }
}

async function resumePendingBridgeApproval(userId, approval, details, info) {
  const route = bridgeConfig(details?.fromChain, details?.toChain)
  if (!route || !info?.walletAddress) return { status: 'error', reason: 'bridge_route_not_supported_for_msca' }
  const burnTxHash = details?.burnTxHash
  if (!burnTxHash) return { status: 'pending_confirmation', reason: 'source_user_operation_pending' }
  const amountText = String(details.amount || approval.amount || '').trim()
  const amount = amountText && amountText !== '0' ? parseUnits(amountText, 6) : undefined
  let proof
  try {
    proof = await verifyBridgeBurn({ burnTxHash, route, walletAddress: info.walletAddress, amount })
  } catch {
    return { status: 'pending_confirmation', reason: 'source_burn_receipt_unavailable', burnTxHash }
  }
  if (!proof.ok) return { status: 'error', reason: proof.reason, burnTxHash }
  const bridgeStatus = await getCctpBridgeStatus({
    burnTxHash,
    sourceDomain: route.source.domain,
    destinationDomain: route.destination.domain,
    walletAddress: info.walletAddress,
    route,
    expectedBurnAmount: BigInt(proof.args.amount) - BigInt(proof.args.fee),
  })
  if (bridgeStatus.status === 'rejected') return { status: 'error', reason: bridgeStatus.reason, burnTxHash }
  if (!bridgeStatus.verified) return { status: 'pending_confirmation', reason: bridgeStatus.reason || 'cctp_message_pending', burnTxHash, messageStatus: bridgeStatus.messageStatus }
  const mint = await mintDestinationViaMsca({ status: bridgeStatus, route, walletAddress: info.walletAddress, userId, approvalId: approval.id })
  if (mint.success) {
    return {
      status: 'success',
      burnTxHash,
      destinationTxHash: mint.txHash || null,
      destinationUserOpHash: mint.userOpHash || null,
      destinationExplorerUrl: mint.explorerUrl || null,
      idempotent: Boolean(mint.idempotent),
    }
  }
  return {
    status: 'pending_confirmation',
    reason: mint.error || 'destination_mint_pending',
    burnTxHash,
    destinationUserOpHash: mint.userOpHash || null,
    destinationChainKey: executionChainKey(route.toKey),
    destinationExplorerUrl: mint.explorerUrl || null,
  }
}

async function mintDestinationViaMsca({ status, route, walletAddress, userId, approvalId: existingApprovalId = null, allowHashlessRecovery = false }) {
  if (!status?.verified || !status.message || !status.attestation) return { success: false, error: 'Attestation belum ready' }
  const destinationKey = {
    Arc_Testnet: 'arc-testnet',
    Base_Sepolia: 'base-sepolia',
    Arbitrum_Sepolia: 'arbitrum-sepolia',
  }[route.toKey]
  if (!destinationKey) return { success: false, error: 'destination_msca_route_not_supported' }
  const alreadyProcessed = await destinationMintAlreadyProcessed({ status, route })
  const nonceDecision = destinationNonceDecision(alreadyProcessed)
  if (nonceDecision === 'unavailable') {
    // A failed nonce read is not evidence that receiveMessage was never sent.
    // Keep the operation fail-closed until the destination RPC can prove the
    // message is unused; no duplicate mint is safe while idempotency is unknown.
    return { success: false, error: alreadyProcessed.reason || 'destination_nonce_check_unavailable', approvalId: existingApprovalId || null, safeToRetry: false }
  }
  if (nonceDecision === 'minted') {
    return {
      success: true,
      idempotent: true,
      txHash: null,
      userOpHash: null,
      explorerUrl: null,
      approvalId: existingApprovalId || null,
      message: 'CCTP message sudah diproses di destination; tidak mengirim UserOperation ulang.',
    }
  }
  const lockKey = `${route.toKey}:${alreadyProcessed.nonce}`
  const existingLock = destinationMintLocks.get(lockKey)
  if (existingLock) {
    if (!existingLock.userOpHash) {
      if (!allowHashlessRecovery) {
        return { success: false, error: 'destination_mint_in_flight', approvalId: existingLock.approvalId || existingApprovalId || null, safeToRetry: false }
      }
      // The explicit recovery path will re-check the destination nonce and the
      // persisted approval cooldown below before submitting a new UserOperation.
      destinationMintLocks.delete(lockKey)
    } else {
      const { getUserOpStatus } = await import('./sessionKeyService.mjs')
      const live = await getUserOpStatus(existingLock.userId || userId, existingLock.userOpHash, existingLock.chainKey)
      if (live.status === 'success') {
        destinationMintLocks.delete(lockKey)
        return { success: true, txHash: live.txHash, userOpHash: existingLock.userOpHash, explorerUrl: live.explorerUrl }
      }
      if (live.status === 'pending_confirmation') {
        return { success: false, error: 'destination_mint_in_flight', userOpHash: existingLock.userOpHash, safeToRetry: false }
      }
      if (live.status !== 'error' || !live.receipt || !['reverted', '0x0', 0, false].includes(live.receipt?.receipt?.status)) {
        return { success: false, error: live.reason || 'destination_mint_status_unavailable', userOpHash: existingLock.userOpHash, safeToRetry: false }
      }
      // Only an explicitly reverted transaction releases the lock for a retry.
      destinationMintLocks.delete(lockKey)
    }
  }
  const persisted = await findPendingBridgeMint(userId, status.burnTxHash, route.toKey)
  if (persisted) {
    if (!persisted.userOpHash) {
      const approvalId = persisted.approval?.id || existingApprovalId || null
      if (!allowHashlessRecovery || !hashlessDestinationRetryAllowed(persisted.approval)) {
        destinationMintLocks.set(lockKey, { userId, userOpHash: null, chainKey: persisted.chainKey, approvalId })
        return { success: false, error: 'destination_submission_unknown', approvalId, safeToRetry: false }
      }
      // This is an explicit, delayed recovery of a previously hashless
      // destination submission. The nonce was already checked above and the
      // source burn is fixed; never create a new source intent or burn.
      destinationMintLocks.delete(lockKey)
    } else {
      const { getUserOpStatus } = await import('./sessionKeyService.mjs')
      const live = await getUserOpStatus(userId, persisted.userOpHash, persisted.chainKey)
      if (live.status === 'success') {
        await markBridgePendingResolved(userId, persisted, 'success', { txHash: live.txHash, explorerUrl: live.explorerUrl, userOpHash: persisted.userOpHash })
        return { success: true, txHash: live.txHash, userOpHash: persisted.userOpHash, explorerUrl: live.explorerUrl, idempotent: true }
      }
      if (live.status === 'pending_confirmation') {
        destinationMintLocks.set(lockKey, { userId, userOpHash: persisted.userOpHash, chainKey: persisted.chainKey })
        return { success: false, error: 'destination_mint_in_flight', userOpHash: persisted.userOpHash, safeToRetry: false }
      }
      if (live.status !== 'error' || !live.receipt || !['reverted', '0x0', 0, false].includes(live.receipt?.receipt?.status)) {
        destinationMintLocks.set(lockKey, { userId, userOpHash: persisted.userOpHash, chainKey: persisted.chainKey })
        return { success: false, error: live.reason || 'destination_mint_status_unavailable', userOpHash: persisted.userOpHash, safeToRetry: false }
      }
      await markBridgePendingResolved(userId, persisted, 'error', { userOpHash: persisted.userOpHash, error: live.reason || 'destination UserOperation failed' })
    }
  }
  const pendingIntent = await findPendingBridgeIntent(userId, status.burnTxHash, route.toKey)
  let approvalId = existingApprovalId || pendingIntent?.approval?.id || null
  if (!allowHashlessRecovery && (pendingIntent?.phase === 'destination_submitted' || pendingIntent?.phase === 'submission_unknown')) {
    destinationMintLocks.set(lockKey, { userId, userOpHash: null, chainKey: destinationKey, approvalId })
    return { success: false, error: 'destination_mint_in_flight', approvalId, safeToRetry: false }
  }
  destinationMintLocks.set(lockKey, { userId, userOpHash: null, chainKey: destinationKey, approvalId })
  try {
    const preflight = await destinationMscaPreflight({ route, walletAddress })
    if (!preflight.ok) {
      destinationMintLocks.delete(lockKey)
      return { success: false, error: preflight.message || preflight.reason, safeToRetry: false }
    }
    try {
      approvalId = approvalId || await recordBridgePending(userId, {
        agent: 'mcp-agent',
        amount: status.messageBody?.amount ? formatUnits(status.messageBody.amount, 6) : '0',
        fromChain: route.fromKey,
        toChain: route.toKey,
        burnTxHash: status.burnTxHash,
        destinationChainKey: destinationKey,
        settlementPhase: 'intent_created',
      })
    } catch (error) {
      destinationMintLocks.delete(lockKey)
      return { success: false, error: 'destination_intent_persist_failed', approvalId: existingApprovalId || null, safeToRetry: false }
    }
    destinationMintLocks.set(lockKey, { userId, userOpHash: null, chainKey: destinationKey, approvalId })
    await updateBridgePending(userId, approvalId, {
      fromChain: route.fromKey,
      toChain: route.toKey,
      burnTxHash: status.burnTxHash,
      destinationChainKey: destinationKey,
      settlementStatus: 'pending_confirmation',
      settlementPhase: 'submission_unknown',
    }, 'pending_confirmation', { txHash: status.burnTxHash })
    const { executeViaSession } = await import('./sessionKeyService.mjs')
    const result = await executeViaSession(walletAddress, [{
      to: route.destination.messageTransmitter,
      value: 0n,
      data: encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [status.message, status.attestation] }),
    }], { paymaster: true, chainKey: destinationKey, feeProfile: destinationKey === 'arbitrum-sepolia' ? 'arbitrum-destination' : destinationKey === 'arc-testnet' ? 'arc-destination' : 'base-destination', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true })
    if (result.status === 'pending_confirmation') {
      const details = {
        fromChain: route.fromKey,
        toChain: route.toKey,
        burnTxHash: status.burnTxHash,
        destinationChainKey: destinationKey,
        destinationUserOpHash: result.userOpHash || null,
        settlementStatus: 'pending_confirmation',
        settlementPhase: 'destination_submitted',
      }
      await updateBridgePending(userId, approvalId, details, 'pending_confirmation', {
        txHash: status.burnTxHash,
        userOpHash: result.userOpHash,
        error: result.reason,
      })
      destinationMintLocks.set(lockKey, { userId, userOpHash: result.userOpHash || null, chainKey: destinationKey, approvalId })
      return { success: false, error: result.reason || 'destination_mint_pending', approvalId, userOpHash: result.userOpHash, safeToRetry: false }
    }
    if (result.status !== 'success') {
      if (result.safeToRetry === true && result.userOpAccepted === 'no') {
        await updateBridgePending(userId, approvalId, {
          fromChain: route.fromKey,
          toChain: route.toKey,
          burnTxHash: status.burnTxHash,
          destinationChainKey: destinationKey,
          settlementPhase: 'destination_submission_failed',
          settlementStatus: 'error',
          destinationUserOpHash: null,
          reason: result.reason || 'user_operation_precheck_failed',
          userOpAccepted: 'no',
          safeToRetry: true,
        }, 'error', { txHash: status.burnTxHash, error: result.error || result.reason })
        destinationMintLocks.delete(lockKey)
        return { success: false, error: result.reason || 'destination_user_operation_precheck_failed', detail: result.error || null, approvalId, safeToRetry: true }
      }
      if (!(result.status === 'error' && result.receipt && ['reverted', '0x0', 0, false].includes(result.receipt?.receipt?.status))) {
        const details = {
          fromChain: route.fromKey,
          toChain: route.toKey,
          burnTxHash: status.burnTxHash,
          destinationChainKey: destinationKey,
          destinationUserOpHash: result.userOpHash || null,
          settlementStatus: 'pending_confirmation',
        }
        await updateBridgePending(userId, approvalId, details, 'pending_confirmation', { txHash: status.burnTxHash, userOpHash: result.userOpHash, error: result.reason })
        destinationMintLocks.set(lockKey, { userId, userOpHash: result.userOpHash || null, chainKey: destinationKey, approvalId, error: result.reason || 'destination_mint_status_unavailable' })
        return { success: false, error: result.reason || 'destination_mint_status_unavailable', approvalId, userOpHash: result.userOpHash, safeToRetry: false }
      }
      await updateBridgePending(userId, approvalId, {
        fromChain: route.fromKey,
        toChain: route.toKey,
        burnTxHash: status.burnTxHash,
        destinationChainKey: destinationKey,
        settlementStatus: 'error',
      }, 'error', { txHash: status.burnTxHash, userOpHash: result.userOpHash, error: result.reason })
      destinationMintLocks.delete(lockKey)
      return { success: false, error: result.reason || 'Destination MSCA UserOperation failed', approvalId, userOpHash: result.userOpHash, safeToRetry: true }
    }
    await updateBridgePending(userId, approvalId, {
      fromChain: route.fromKey,
      toChain: route.toKey,
      burnTxHash: status.burnTxHash,
      destinationChainKey: destinationKey,
      destinationUserOpHash: result.userOpHash || null,
      settlementStatus: 'success',
    }, 'success', { txHash: result.txHash, userOpHash: result.userOpHash })
    destinationMintLocks.delete(lockKey)
    return { success: true, approvalId, txHash: result.txHash, userOpHash: result.userOpHash, explorerUrl: `${route.destination.explorer}${result.txHash}` }
  } catch (error) {
    // The transport may fail after the bundler accepted the UserOperation. Keep
    // its hash and original error so the next retry polls the exact operation
    // instead of submitting a duplicate receiveMessage call blindly.
    const message = String(error?.message || error)
    const submittedUserOpHash = error?.userOpHash || null
    const submittedExplorerUrl = error?.explorerUrl || null
    const currentLock = destinationMintLocks.get(lockKey)
    const lockApprovalId = currentLock?.approvalId || approvalId || null
    if (lockApprovalId) {
      await updateBridgePending(userId, lockApprovalId, {
        fromChain: route.fromKey,
        toChain: route.toKey,
        burnTxHash: status.burnTxHash,
        destinationChainKey: destinationKey,
        settlementPhase: submittedUserOpHash ? 'destination_submitted' : 'submission_unknown',
        settlementStatus: 'pending_confirmation',
        destinationUserOpHash: submittedUserOpHash,
      }, 'pending_confirmation', { error: message, userOpHash: submittedUserOpHash, explorerUrl: submittedExplorerUrl })
    }
    destinationMintLocks.set(lockKey, { userId, userOpHash: submittedUserOpHash, chainKey: destinationKey, approvalId: lockApprovalId, error: message })
    return {
      success: false,
      error: submittedUserOpHash ? 'destination_mint_receipt_unavailable' : 'destination_mint_status_unavailable',
      detail: message.slice(0, 500),
      approvalId: lockApprovalId,
      userOpHash: submittedUserOpHash,
      explorerUrl: submittedExplorerUrl,
      safeToRetry: false,
    }

  }
}

// Decide whether an agent-initiated action can auto-execute server-side.
// MCP server is MSCA-ONLY: only session-key (MSCA) auto-executes. Circle proxy
// wallet and EOA are explicitly NOT available to remote ChatGPT/Claude, per
// security policy (remote agents must only use the locked passkey MSCA).
async function canAutoExecute(userId, source, amount, chainKey) {
  if (source !== 'session') {
    return { ok: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Circle proxy dan EOA tidak diizinkan untuk agent remote.' }
  }
  try {
    const { canExecuteViaSession } = await import('./sessionKeyService.mjs')
    const gate = canExecuteViaSession(userId, amount, chainKey)
    return gate
  } catch { return { ok: false, reason: 'session_error' } }
}

// Record an auto-executed action into the vault as an approved entry (for the
// Plugin history + audit trail), with the on-chain txHash.
async function recordAutoExec(userId, { agent, action, amount, token, source, to, details, txHash, explorerUrl }) {
  const vault = await import('./vaultStore.mjs')
  const approval = vault.createApproval(userId, { agent, action, amount, token, source, to, details, forcePending: true })
  vault.approveRequest(userId, approval.id, { txHash, explorerUrl })
  return vault.updateApprovalStatus(userId, approval.id, 'success', { txHash, explorerUrl }) || approval
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
  // Destination settlement is executed by the same MSCA UserOperation.
  // Server-signed mint and OWNER_PRIVATE_KEY are intentionally not required.
  return null
}

function bridgeConfigDisabledReason(route) {
  if (!ENABLE_MSCA_CCTP_BRIDGE) return 'msca_bridge_disabled_until_router_validation'
  if (!route?.source?.router) return 'bridge_router_not_configured'
  if (!route?.source?.usdc || !route?.source?.rpcUrl) return 'source_chain_not_configured'
  if (!route.destination?.rpcUrl || !route.destination?.messageTransmitter) return 'destination_chain_not_configured'
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
export function createMcpServer(userId, context = {}) {
  const requestAgent = context.agent || resolveAgentForUser(userId)
  const boundMscaWalletAddress = context.boundMscaWalletAddress || ''
  const server = new McpServer({
    name: 'arcox-mcp',
    version: '1.0.0',
  })

  // Every MCP tool must return a machine-readable response, even when an
  // upstream RPC/API or runtime dependency fails. Without this boundary the
  // SDK turns a thrown handler error into the opaque "Error occurred during
  // tool execution" shown by Claude/ChatGPT.
  const registerTool = (name, description, schema, handler) => server['tool'](name, description, schema, async (params) => {
    try {
      return await handler(params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Unknown tool error')
      console.error(`[mcp:${name}]`, message)
      return {
        isError: true,
        content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'error', tool: name, error: message, retryable: true }) }],
      }
    }
  })

  // ── READ-ONLY TOOLS ──

  registerTool('arcox_wallet_balances', 'Show Agent Wallet (MSCA) balances on Arc, Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia', {}, async () => {
    const msca = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    try {
      const chains = await fetchAllChainBalances(msca.walletAddress)
      return { content: [{ type: 'text', text: jsonText({
        walletAddress: msca.walletAddress,
        walletType: 'MSCA',
        chains,
        // Backward-compatible Arc summary for older Claude/GPT prompts. The
        // canonical multi-chain data lives under chains[chainKey].
        USDC: chains['arc-testnet']?.USDC ?? null,
        EURC: chains['arc-testnet']?.EURC ?? null,
        USYC: chains['arc-testnet']?.USYC ?? null,
        cirBTC: chains['arc-testnet']?.cirBTC ?? null,
        supportedChains: ['arc-testnet', 'ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia'],
        balancePolicy: {
          native: 'eth_getBalance dari MSCA; Arc native USDC memakai 18 decimals untuk gas',
          erc20: 'balanceOf(MSCA) memakai address kontrak resmi per chain; Arc ERC-20 USDC memakai 6 decimals',
        },
        note: 'Semua balance dibaca dari alamat MSCA yang sama melalui read-only RPC; tidak memakai EOA atau Circle proxy wallet. Setiap chain mengembalikan tokenContracts/contracts untuk audit address.',
      }) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: jsonText({
        walletAddress: msca.walletAddress,
        walletType: 'MSCA',
        status: 'partial',
        chains: {},
        error: error?.message || 'Multi-chain balance lookup failed',
      }) }] }
    }
  })

  registerTool('arcox_transaction_history', 'Check transaction history and auto-mint worker status', {}, async () => {
    const msca = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!msca) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    const data = await apiGet(`/api/tx-history?address=${encodeURIComponent(msca.walletAddress)}`, msca.walletAddress)
    return { content: [{ type: 'text', text: jsonText({ ...data, walletAddress: msca.walletAddress, walletType: 'MSCA' }) }] }
  })

  registerTool('arcox_route_status', 'Check if a swap/bridge/send route is supported', {
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
    const route = action === 'bridge' ? bridgeConfig(params.fromChain, params.toChain) : null
    const bridgeIsSupported = action === 'bridge' && ENABLE_MSCA_CCTP_BRIDGE && String(params.token || 'USDC').toUpperCase() === 'USDC' && Boolean(route?.source?.router && route?.destination?.messageTransmitter)
    const session = await resolveActiveMsca(userId, boundMscaWalletAddress)
    const disabledReason = action === 'bridge' ? bridgeConfigDisabledReason(route) : null
    let routerValidation = null
    if (bridgeIsSupported && !disabledReason) {
      routerValidation = await validateRouterRoute(route).then(() => ({ ok: true })).catch(error => ({ ok: false, reason: 'router_route_validation_failed', message: error?.message || 'ArcoxRouter route validation failed' }))
    }
    let destinationReadiness = null
    if (bridgeIsSupported && routerValidation?.ok === true && session && !disabledReason) {
      destinationReadiness = await destinationMscaPreflight({ route, walletAddress: session.walletAddress }).catch(error => ({ ok: false, reason: 'destination_msca_preflight_failed', message: error?.message || 'Destination MSCA preflight gagal' }))
    }
    const bridgeReady = bridgeIsSupported && !disabledReason && routerValidation?.ok === true && destinationReadiness?.ok === true
    const mscaSupported = Boolean(session) && source === 'session' && knownAction && (action === 'bridge' ? bridgeReady : !hasUnsupportedSwapToken)
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
              : action === 'bridge' && routerValidation?.ok !== true
                ? (routerValidation?.reason || 'router_route_validation_failed')
                : action === 'bridge' && !destinationReadiness?.ok
                ? (destinationReadiness?.reason || 'destination_msca_not_ready')
              : hasUnsupportedSwapToken
              ? 'swap_route_not_supported_for_msca'
              : null
    return { content: [{ type: 'text', text: jsonText({
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
      routerValidated: action === 'bridge' ? Boolean(routerValidation?.ok) : undefined,
      routerValidationError: action === 'bridge' && routerValidation?.ok === false ? routerValidation.message : undefined,
      destinationReady: action === 'bridge' ? Boolean(destinationReadiness?.ok) : undefined,
      note: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote tetap wajib sebelum eksekusi.',
    }) }] }
  })

  // ── SWAP TOOLS (quote → confirm → execute) ──

  registerTool('arcox_quote_swap', 'Get a swap quote preview. Show preview to user, wait for confirmation, then call arcox_execute_swap', {
    tokenIn: z.string().describe('Input token symbol (USDC, EURC, cirBTC)'),
    tokenOut: z.string().describe('Output token symbol'),
    amountIn: z.string().describe('Amount in human readable (e.g. "1")'),
    source: z.string().optional().describe('session (MSCA)'),
  }, async (params) => {
    const src = params.source || 'session'
    if (src !== 'session') {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, preview: false, rejected: true, action: 'swap', reason: 'msca_only', source: src, chain: 'arc-testnet', walletType: null, message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote swap hanya untuk source=session.' }) }] }
    }
    const session = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!session) {
      return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    }
    const quoteData = await apiPost('/api/eoa-swap-quote', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, metamaskAddress: session.walletAddress }, session.walletAddress)
    if (quoteData?.available !== true) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, preview: false, rejected: true, action: 'swap', chain: 'arc-testnet', ...quoteData, source: 'session', walletAddress: session.walletAddress, walletType: 'MSCA' }) }] }
    }
    // Prepare immutable calldata at preview time. Execution must use this exact
    // payload, not re-quote later with potentially different routing/slippage.
    const prepared = await apiPost('/api/eoa-swap-prepare', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, metamaskAddress: session.walletAddress }, session.walletAddress)
    if (prepared?.success === false || prepared?.available === false || typeof prepared !== 'object' || !prepared) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, preview: false, rejected: true, action: 'swap', chain: 'arc-testnet', ...prepared, source: 'session', walletAddress: session.walletAddress, walletType: 'MSCA' }) }] }
    }
    const quote = createExecutionQuote(userId, 'swap', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, walletAddress: session.walletAddress, quote: quoteData, prepared })
    return { content: [{ type: 'text', text: jsonText({
      ...quoteData,
      schemaVersion: 1,
      preview: true,
      action: 'swap',
      chain: 'arc-testnet',
      fromChain: 'arc-testnet',
      toChain: 'arc-testnet',
      previewId: quote.previewId,
      expiresAt: new Date(quote.expires).toISOString(),
      source: 'session',
      walletAddress: session.walletAddress,
      walletType: 'MSCA',
      prepared: { source: prepared.source, route: prepared.route, amountOut: prepared.amountOut },
    }) }] }
  })

  registerTool('arcox_execute_swap', 'Execute a confirmed swap via Agent Wallet (MSCA/session key). Requires previewId from arcox_quote_swap and user confirmation.', {
    tokenIn: z.string().describe('Input token symbol'),
    tokenOut: z.string().describe('Output token symbol'),
    amountIn: z.string().describe('Exact amount from quote'),
    source: z.string().optional().describe('session (MSCA)'),
    previewId: z.string().describe('Preview ID from arcox_quote_swap'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) return { content: [{ type: 'text', text: jsonText({ error: 'Confirmation required. Use confirmed=true and confirmationText exactly yes or ya.' }) }] }
    const source = params.source || 'session'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Parameter source harus "session".' }) }] }
    }
    const activeSession = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!activeSession) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, ...mscaRequiredResult() }) }] }
    const quoteCheck = consumeExecutionQuote(userId, 'swap', params.previewId, {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      walletAddress: activeSession.walletAddress,
    })
    if (!quoteCheck.ok) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
    const gate = await canAutoExecute(userId, source, params.amountIn)
    if (!gate.ok) {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: gate.reason, message: gate.reason === 'no_session' ? 'Session key MSCA belum diaktifkan. User harus setup Agent Wallet (MSCA) + session key di Plugin page.' : gate.message }) }] }
    }
    try {
      const preparedPayload = quoteCheck.quote.params.prepared
      if (!preparedPayload || preparedPayload.source !== 'stablecoin-service' || !preparedPayload.adapterContract) {
        return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: 'swap_route_not_supported_for_msca', message: 'Route ini belum aman untuk eksekusi MSCA.' }) }] }
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
        return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: preparedResult.reason || 'swap_calldata_unavailable', message }) }] }
      }
      const { swapViaSession } = await import('./sessionKeyService.mjs')
      const result = await swapViaSession(userId, { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountIn: params.amountIn, preparedCalls: preparedResult.calls, chainKey: 'arc-testnet' })
      if (result.status === 'success') {
        await recordAutoExec(userId, {
          agent: requestAgent, action: 'swap', amount: params.amountIn, token: params.tokenIn,
          source: 'session', details: jsonText({ tokenOut: params.tokenOut, previewId: params.previewId }),
          txHash: result.txHash, explorerUrl: result.explorerUrl,
        })
        return { content: [{ type: 'text', text: jsonText({ status: 'executed', executed: true, txHash: result.txHash, explorerUrl: result.explorerUrl, message: `Swap ${params.amountIn} ${params.tokenIn} → ${params.tokenOut} berhasil via MSCA (session key).` }) }] }
      }
      return { content: [{ type: 'text', text: jsonText({ status: 'session_failed', executed: false, error: result.reason || 'Session swap gagal' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'session_error', executed: false, error: e?.message || 'Session error' }) }] }
    }
  })

  // ── BRIDGE TOOLS (route → quote → confirm → execute) ──

  registerTool('arcox_quote_bridge', 'Get a bridge quote preview. Show preview to user, wait for confirmation, then call arcox_execute_bridge', {
    fromChain: z.string().describe('Source chain (arc-testnet, base-sepolia, arbitrum-sepolia)'),
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
      return { content: [{ type: 'text', text: jsonText({ preview: false, rejected: true, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote bridge hanya untuk source=session.' }) }] }
    }
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    const route = bridgeConfig(params.fromChain, params.toChain)
    if (!route || !route.source?.router || !route.destination?.messageTransmitter || token.toUpperCase() !== 'USDC') {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, preview: false, rejected: true, action: 'bridge', fromChain: executionChainKey(params.fromChain), toChain: executionChainKey(params.toChain), reason: 'bridge_route_not_supported_for_msca', message: 'MSCA bridge hanya mendukung route CCTP USDC yang memiliki router source dan MessageTransmitter destination.' }) }] }
    }
    const disabledReason = bridgeConfigDisabledReason(route)
    if (disabledReason) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, preview: false, rejected: true, action: 'bridge', fromChain: executionChainKey(params.fromChain), toChain: executionChainKey(params.toChain), chain: executionChainKey(params.fromChain), walletType: 'MSCA', reason: disabledReason, message: disabledReason === 'destination_chain_not_configured' ? 'Destination chain belum dikonfigurasi.' : 'Bridge MSCA belum diaktifkan.' }) }] }
    }
    const { listApprovals } = await import('./vaultStore.mjs')
    const unresolvedSource = hasUnresolvedSourceBridgeIntent(listApprovals(userId), {
      fromChain: route.fromKey,
      toChain: route.toKey,
      walletAddress: info.walletAddress,
    })
    if (unresolvedSource && isStaleApprovalOnlySourceIntent(unresolvedSource, {
      sessionDelegateAddress: info.delegateAddress,
      sessionCreatedAt: info.createdAt,
    })) {
      await supersedeStaleSourceApproval(userId, unresolvedSource, info)
    } else if (unresolvedSource) {
      return { content: [{ type: 'text', text: jsonText({
        schemaVersion: 1,
        preview: false,
        rejected: true,
        action: 'bridge',
        fromChain: executionChainKey(params.fromChain),
        toChain: executionChainKey(params.toChain),
        walletAddress: info.walletAddress,
        walletType: 'MSCA',
        reason: 'unresolved_source_intent',
        approvalId: unresolvedSource.approval?.id || null,
        message: 'Bridge intent sumber sebelumnya belum memiliki hasil UserOperation yang pasti. Rekonsiliasi status intent tersebut sebelum meminta quote baru; burn tidak diulang.',
      }) }] }
    }
    const destinationPreflight = await destinationMscaPreflight({ route, walletAddress: info.walletAddress })
    if (!destinationPreflight.ok) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, preview: false, rejected: true, action: 'bridge', fromChain: executionChainKey(params.fromChain), toChain: executionChainKey(params.toChain), chain: executionChainKey(params.fromChain), walletType: 'MSCA', reason: destinationPreflight.reason, message: destinationPreflight.message || 'Destination MSCA belum siap. Deploy MSCA terlebih dahulu; source burn belum dilakukan.' }) }] }
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
        minFinalityThreshold: bridgeFinalityThreshold(route),
      })
      return { content: [{ type: 'text', text: jsonText({
        schemaVersion: 1,
        preview: true,
        action: 'bridge',
        route: `${params.fromChain} → ${params.toChain}`,
        fromChain: executionChainKey(params.fromChain),
        toChain: executionChainKey(params.toChain),
        chain: executionChainKey(params.fromChain),
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
      return { content: [{ type: 'text', text: jsonText({ preview: false, rejected: true, reason: 'bridge_quote_unavailable', message: e?.message || 'ArcoxRouter quote tidak tersedia' }) }] }
    }
  })

  registerTool('arcox_execute_bridge', 'Execute a confirmed bridge via Agent Wallet (MSCA/session key). Requires previewId from arcox_quote_bridge and user confirmation.', {
    fromChain: z.string().describe('Source chain'),
    toChain: z.string().describe('Destination chain'),
    amount: z.string().describe('Exact amount from quote'),
    token: z.string().optional().describe('Token symbol'),
    source: z.string().optional().describe('session (MSCA)'),
    previewId: z.string().describe('Preview ID from arcox_quote_bridge'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) return { content: [{ type: 'text', text: jsonText({ error: 'Confirmation required. Use confirmed=true and confirmationText exactly yes or ya.' }) }] }
    const source = params.source || 'session'
    if (source !== 'session') {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Circle proxy dan EOA tidak diizinkan untuk agent remote.' }) }] }
    }
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!info) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, ...mscaRequiredResult() }) }] }
    const route = bridgeConfig(params.fromChain, params.toChain)
    if (!route || !route.source?.router || !route.destination?.messageTransmitter || String(params.token || 'USDC').toUpperCase() !== 'USDC') {
       return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'rejected', executed: false, action: 'bridge', fromChain: executionChainKey(params.fromChain), toChain: executionChainKey(params.toChain), reason: 'bridge_route_not_supported_for_msca', message: 'MSCA bridge hanya mendukung route CCTP USDC yang memiliki router source dan MessageTransmitter destination.' }) }] }
    }
    const disabledReason = bridgeConfigDisabledReason(route)
    if (disabledReason) {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: disabledReason, message: disabledReason === 'destination_chain_not_configured' ? 'Destination chain belum dikonfigurasi. Tidak ada UserOperation yang dikirim.' : 'Bridge MSCA belum diaktifkan. Tidak ada UserOperation yang dikirim.' }) }] }
    }
    const destinationPreflight = await destinationMscaPreflight({ route, walletAddress: info.walletAddress })
    if (!destinationPreflight.ok) {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: destinationPreflight.reason, message: destinationPreflight.message || 'Destination MSCA belum siap. Tidak ada source burn.' }) }] }
    }
    const gate = await canAutoExecute(userId, source, params.amount, executionChainKey(params.fromChain))

    if (!gate.ok) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: gate.reason, message: gate.message || 'Session key MSCA tidak dapat mengeksekusi bridge.' }) }] }
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
      if (!quoteCheck.ok) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
      const quotedFee = quoteCheck.quote.params.platformFeeBaseUnits
      const quotedNet = quoteCheck.quote.params.netBurnBaseUnits
      if (quoteCheck.quote.params.router !== route.source.router || quoteCheck.quote.params.maxFeeBaseUnits !== BRIDGE_MAX_FEE.toString() || Number(quoteCheck.quote.params.minFinalityThreshold) !== bridgeFinalityThreshold(route) || quotedFee !== fee.fee.toString() || quotedNet !== fee.netAmount.toString()) {
        return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: 'quote_fee_changed', message: 'Router fee berubah setelah preview. Buat quote bridge baru.' }) }] }
      }
      const calls = buildMscaRouterBridgeCalls({ route, amount, mintRecipient: info.walletAddress, minFinalityThreshold: bridgeFinalityThreshold(route) })
      const [approveCall, burnCall] = calls
      const existingSourceIntent = await findPendingSourceIntent(userId, {
        fromChain: route.fromKey,
        toChain: route.toKey,
        previewId: params.previewId,
        walletAddress: info.walletAddress,
      })
      let approvalId = null
      let sourceApprovalUserOpHash = existingSourceIntent?.details?.sourceApprovalUserOpHash || null
      let approvalConfirmed = false
      if (existingSourceIntent) {
        approvalId = existingSourceIntent.approval.id
        const details = existingSourceIntent.details || {}
        const storedBurnHash = details.sourceUserOpHash
        const storedApprovalHash = details.sourceApprovalUserOpHash
        const storedHash = storedBurnHash || storedApprovalHash
        if (storedHash) {
          const { getUserOpStatus } = await import('./sessionKeyService.mjs')
          const liveSource = await getUserOpStatus(userId, storedHash, executionChainKey(route.fromKey))
          if (liveSource.status === 'pending_confirmation') {
            return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, sourceSubmitted: Boolean(storedBurnHash), approvalSubmitted: Boolean(storedApprovalHash), approvalId, userOpHash: storedHash, sourceApprovalUserOpHash: storedApprovalHash || null, sourceUserOpHash: storedBurnHash || null, safeToRetry: false, reason: storedBurnHash ? 'source_user_operation_pending' : 'source_approval_pending', message: 'Source UserOperation masih pending. Jangan mengirim approval atau burn ulang.' }) }] }
          }
          if (liveSource.status === 'success' && liveSource.txHash) {
            if (storedBurnHash) {
              await updateBridgePending(userId, approvalId, { ...details, sourceUserOpHash: storedBurnHash, burnTxHash: liveSource.txHash, sourceChainKey: executionChainKey(route.fromKey), settlementPhase: 'source_confirmed', settlementStatus: 'source_confirmed' }, 'pending_confirmation', { txHash: liveSource.txHash, userOpHash: storedBurnHash, explorerUrl: liveSource.explorerUrl })
              return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: true, sourceSubmitted: true, approvalId, burnTxHash: liveSource.txHash, userOpHash: storedBurnHash, safeToRetry: false, reason: 'source_confirmed_needs_settlement', message: 'Source burn sudah terkonfirmasi. Lanjutkan status bridge; jangan burn ulang.' }) }] }
            }
            await updateBridgePending(userId, approvalId, { ...details, sourceApprovalUserOpHash: storedApprovalHash, sourceChainKey: executionChainKey(route.fromKey), settlementPhase: 'source_approval_confirmed', settlementStatus: 'pending_confirmation' }, 'pending_confirmation', { userOpHash: storedApprovalHash, explorerUrl: liveSource.explorerUrl })
            approvalConfirmed = true
          } else if (liveSource.status === 'error' && ['reverted', '0x0', 0, false].includes(liveSource.receipt?.receipt?.status)) {
            await updateBridgePending(userId, approvalId, { ...details, settlementPhase: storedBurnHash ? 'source_submission_failed' : 'source_approval_failed', settlementStatus: 'error', safeToRetry: true }, 'error', { userOpHash: storedHash, error: storedBurnHash ? 'Source burn UserOperation reverted.' : 'Source approval UserOperation reverted.' })
            executionQuotes.delete(params.previewId)
            return { content: [{ type: 'text', text: jsonText({ status: 'session_failed', executed: false, approvalId, reason: storedBurnHash ? 'source_user_operation_reverted' : 'source_approval_reverted', safeToRetry: true, message: 'Source UserOperation reverted. Buat quote baru sebelum mencoba lagi.' }) }] }
          } else {
            return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, sourceSubmitted: Boolean(storedBurnHash), approvalSubmitted: Boolean(storedApprovalHash), approvalId, userOpHash: storedHash, safeToRetry: false, reason: 'source_submission_unknown', message: 'Hasil source UserOperation belum diketahui. Jangan mengirim ulang; rekonsiliasi status terlebih dahulu.' }) }] }
          }
        } else if (details.settlementPhase !== 'source_approval_confirmed') {
          return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, sourceSubmitted: false, approvalSubmitted: false, approvalId, safeToRetry: false, reason: 'source_submission_unknown', message: 'Bridge intent sumber sudah tersimpan tetapi hasil UserOperation belum diketahui. Jangan mengirim ulang.' }) }] }
        } else {
          approvalConfirmed = true
        }
      }
      try {
        approvalId = approvalId || await recordBridgePending(userId, {
          agent: requestAgent,
          amount: params.amount,
          fromChain: route.fromKey,
          toChain: route.toKey,
          previewId: params.previewId,
          sourceChainKey: executionChainKey(route.fromKey),
          sourceExplorerUrl: route.source.explorer,
          walletAddress: info.walletAddress,
          sessionDelegateAddress: info.delegateAddress,
          sessionCreatedAt: info.createdAt,
          settlementPhase: 'source_intent_created',
        })
      } catch (intentError) {
        return { content: [{ type: 'text', text: jsonText({ status: 'bridge_error', executed: false, reason: 'source_intent_persist_failed', error: intentError?.message || 'Could not persist source bridge intent' }) }] }
      }

      const executionOptions = {
        paymaster: true,
        chainKey: executionChainKey(route.fromKey),
        feeProfile: resolveMscaBridgeFeeProfile(route),
        explorerBaseUrl: route.source.explorer,
        requireTransactionHash: true,
        requireSuccessfulTransactionReceipt: true,
      }
      const { executeViaSession } = await import('./sessionKeyService.mjs')

      // Final guarded flow mirrors the proven frontend sequence exactly:
      // approve → successful receipt → ArcoxRouter bridge call. The router
      // remains the only source burn path; direct TokenMessenger calls are not
      // accepted by this MCP flow.
      if (!approvalConfirmed) {
        let approvalResult
        try {
          approvalResult = await executeViaSession(userId, [approveCall], executionOptions)
        } catch (submissionError) {
          const submittedApprovalUserOpHash = submissionError?.userOpHash || null
          const submittedApprovalExplorerUrl = submissionError?.explorerUrl || null
          await updateBridgePending(userId, approvalId, {
            fromChain: route.fromKey, toChain: route.toKey, previewId: params.previewId,
            sourceApprovalUserOpHash: submittedApprovalUserOpHash,
            sourceChainKey: executionChainKey(route.fromKey),
            settlementPhase: submittedApprovalUserOpHash ? 'source_approval_submitted' : 'source_approval_unknown',
            settlementStatus: 'pending_confirmation',
            userOpAccepted: submittedApprovalUserOpHash ? 'yes' : 'unknown',
            safeToRetry: false,
          }, 'pending_confirmation', { error: submissionError?.message || 'Source approval UserOperation status unknown', userOpHash: submittedApprovalUserOpHash, explorerUrl: submittedApprovalExplorerUrl })
          return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, approvalSubmitted: Boolean(submittedApprovalUserOpHash), approvalId, sourceApprovalUserOpHash: submittedApprovalUserOpHash, userOpHash: submittedApprovalUserOpHash, userOpExplorerUrl: submittedApprovalExplorerUrl, safeToRetry: false, reason: submittedApprovalUserOpHash ? 'source_approval_pending' : 'source_approval_unknown', message: submittedApprovalUserOpHash ? 'Approval UserOperation sudah diterima bundler tetapi receipt belum tersedia. Jangan kirim approval ulang.' : 'Approval UserOperation sumber tidak pasti. Jangan kirim approval atau burn ulang; rekonsiliasi status terlebih dahulu.' }) }] }
        }
        const approvalSucceeded = approvalResult.status === 'success'
        const approvalPending = approvalResult.status === 'pending_confirmation'
        await updateBridgePending(userId, approvalId, {
          fromChain: route.fromKey, toChain: route.toKey, previewId: params.previewId,
          sourceApprovalUserOpHash: approvalResult.userOpHash || null,
          sourceChainKey: executionChainKey(route.fromKey),
          settlementPhase: approvalSucceeded ? 'source_approval_confirmed' : approvalPending ? 'source_approval_submitted' : 'source_approval_failed',
          settlementStatus: approvalSucceeded ? 'pending_confirmation' : approvalPending ? 'pending_confirmation' : 'error',
          reason: approvalResult.reason || null,
          userOpAccepted: approvalResult.userOpAccepted || (approvalResult.userOpHash ? 'yes' : approvalResult.status === 'error' ? 'unknown' : null),
          safeToRetry: approvalResult.safeToRetry === true,
        }, approvalSucceeded || approvalPending ? 'pending_confirmation' : 'error', {
          userOpHash: approvalResult.userOpHash,
          explorerUrl: approvalResult.explorerUrl,
          error: approvalResult.error || approvalResult.reason,
        })
        sourceApprovalUserOpHash = approvalResult.userOpHash || sourceApprovalUserOpHash
        if (approvalPending) {
          return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, approvalSubmitted: true, approvalId, sourceApprovalUserOpHash: approvalResult.userOpHash, userOpHash: approvalResult.userOpHash, userOpExplorerUrl: approvalResult.explorerUrl || null, reason: approvalResult.reason || 'source_approval_pending', safeToRetry: false, message: 'Approval MSCA sudah diterima bundler tetapi receipt belum tersedia. Tunggu approval selesai sebelum burn; lanjutkan dengan previewId yang sama setelah status success.' }) }] }
        }
        if (!approvalSucceeded) {
          executionQuotes.delete(params.previewId)
          return { content: [{ type: 'text', text: jsonText({ status: 'session_failed', executed: false, approvalId, approvalSubmitted: Boolean(approvalResult.userOpHash), sourceApprovalUserOpHash: approvalResult.userOpHash || null, error: approvalResult.reason || 'Source approval UserOperation gagal', safeToRetry: approvalResult.safeToRetry === true, userOpAccepted: approvalResult.userOpAccepted || (approvalResult.userOpHash ? 'yes' : 'unknown') }) }] }
        }
      }

      // The approval receipt is now successful. Submit only the burn call as a
      // second MSCA UserOperation, matching BridgePanel's approve -> wait ->
      // bridgeUsdcWithFee sequence exactly.
      let result
      try {
        result = await executeViaSession(userId, [burnCall], executionOptions)
      } catch (submissionError) {
        // executeViaSession may throw after Circle accepted the operation
        // (for example, receipt indexing failed). Preserve that hash as a
        // burn submission; only a known precheck result is safe to replace.
        const submittedBurnUserOpHash = submissionError?.userOpHash || null
        const submittedBurnExplorerUrl = submissionError?.explorerUrl || null
        await updateBridgePending(userId, approvalId, {
          fromChain: route.fromKey, toChain: route.toKey, previewId: params.previewId,
          sourceApprovalUserOpHash,
          sourceUserOpHash: submittedBurnUserOpHash,
          sourceChainKey: executionChainKey(route.fromKey),
          settlementPhase: submittedBurnUserOpHash ? 'source_submitted' : 'source_submission_unknown',
          settlementStatus: 'pending_confirmation',
          userOpAccepted: submittedBurnUserOpHash ? 'yes' : 'unknown',
          safeToRetry: false,
        }, 'pending_confirmation', { error: submissionError?.message || 'Source burn UserOperation submission status unknown', userOpHash: submittedBurnUserOpHash, explorerUrl: submittedBurnExplorerUrl })
        return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, approvalSubmitted: true, sourceSubmitted: Boolean(submittedBurnUserOpHash), approvalId, sourceApprovalUserOpHash, sourceUserOpHash: submittedBurnUserOpHash, userOpHash: submittedBurnUserOpHash, userOpExplorerUrl: submittedBurnExplorerUrl, safeToRetry: false, reason: submittedBurnUserOpHash ? 'source_user_operation_pending' : 'source_submission_unknown', message: submittedBurnUserOpHash ? 'Burn UserOperation sudah diterima bundler tetapi receipt belum tersedia. Jangan burn ulang; rekonsiliasi hash ini.' : 'Approval sudah selesai tetapi hasil burn UserOperation tidak pasti. Jangan kirim burn ulang; rekonsiliasi status terlebih dahulu.' }) }] }
      }
      const sourceSucceeded = result.status === 'success'
      const sourcePending = result.status === 'pending_confirmation'
      const sourceFailed = result.status === 'error'
      await updateBridgePending(userId, approvalId, {
        fromChain: route.fromKey, toChain: route.toKey, previewId: params.previewId,
        sourceApprovalUserOpHash,
        sourceUserOpHash: result.userOpHash || null,
        burnTxHash: sourceSucceeded ? result.txHash : null,
        sourceChainKey: executionChainKey(route.fromChain),
        settlementPhase: sourceSucceeded ? 'source_confirmed' : sourcePending ? 'source_submitted' : 'source_submission_failed',
        settlementStatus: sourceSucceeded ? 'source_confirmed' : sourcePending ? 'pending_confirmation' : 'error',
        reason: result.reason || null,
        userOpAccepted: result.userOpAccepted || (result.userOpHash ? 'yes' : sourceFailed ? 'unknown' : null),
        // A definitive burn precheck/revert means the router was never
        // successfully called. It is safe to make a fresh quote; only a
        // successful burnTxHash remains recoverable via destination mint.
        safeToRetry: result.safeToRetry === true || (sourceFailed && ['transaction_reverted', 'transaction_failed', 'user_operation_failed'].includes(String(result.reason || ''))),
      }, sourceFailed ? 'error' : 'pending_confirmation', { txHash: sourceSucceeded ? result.txHash : undefined, userOpHash: result.userOpHash, explorerUrl: result.explorerUrl, error: result.error })
      executionQuotes.delete(params.previewId)
      if (result.status === 'pending_confirmation') {
        return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, approvalSubmitted: true, sourceSubmitted: true, approvalId, sourceApprovalUserOpHash, userOpHash: result.userOpHash, userOpExplorerUrl: result.explorerUrl || null, reason: result.reason || 'user_operation_pending', safeToRetry: false, message: 'Approval berhasil dan burn UserOperation sudah diterima bundler tetapi receipt belum tersedia. Jangan ulangi burn.' }) }] }
      }
      if (result.status !== 'success') return { content: [{ type: 'text', text: jsonText({ status: 'session_failed', executed: false, approvalId, approvalSubmitted: true, sourceSubmitted: Boolean(result.userOpHash), error: result.reason || 'Bridge burn UserOperation gagal', userOpHash: result.userOpHash || null, safeToRetry: result.safeToRetry === true, userOpAccepted: result.userOpAccepted || (result.userOpHash ? 'yes' : 'unknown') }) }] }
      const burnProof = await verifyBridgeBurn({ burnTxHash: result.txHash, route, walletAddress: info.walletAddress, amount })
      if (!burnProof.ok) return { content: [{ type: 'text', text: jsonText({ status: 'burn_submitted', executed: true, verified: false, burnTxHash: result.txHash, userOpHash: result.userOpHash, reason: burnProof.reason, message: 'Source UserOperation berhasil tetapi bukti event router belum terverifikasi. Jangan ulangi burn; periksa transaksi ini secara read-only.' }) }] }
      const bridgeStatus = await waitForCctpBridgeStatus({
        burnTxHash: result.txHash,
        sourceDomain: route.source.domain,
        destinationDomain: route.destination.domain,
        walletAddress: info.walletAddress,
        route,
        expectedBurnAmount: burnProof.args ? BigInt(burnProof.args.amount) - BigInt(burnProof.args.fee) : undefined,
      }, {
        onPending: async () => {
          const queued = await apiPost('/api/auto-mint/register', {
            burnTxHash: result.txHash,
            fromChain: route.fromKey,
            toChain: route.toKey,
          }, info.walletAddress)
          if (queued?._httpStatus < 200 || queued?._httpStatus >= 300 || queued?.error) throw new Error(queued?.error || `auto-mint register HTTP ${queued?._httpStatus}`)
          return true
        },
      })
      if (bridgeStatus.status === 'rejected') {
        // The source burn is irreversible even when CCTP binding is rejected.
        // Preserve it in the vault as an error/audit record without marking it
        // approved or attempting any destination transaction.
        try {
          const vault = await import('./vaultStore.mjs')
          vault.updateApprovalStatus(userId, approvalId, 'error', {
            txHash: result.txHash,
            explorerUrl: result.explorerUrl,
            userOpHash: result.userOpHash,
            error: bridgeStatus.reason || 'CCTP binding rejected',
            details: jsonText({ settlementStatus: 'rejected', reason: bridgeStatus.reason }),
          })
        } catch (auditError) {
          console.error('[mcp-bridge] rejected burn audit record failed:', auditError?.message || auditError)
        }
        return { content: [{ type: 'text', text: jsonText({
          ...bridgeStatus,
          status: 'rejected',
          executed: true,
          verified: false,
          burnTxHash: result.txHash,
          userOpHash: result.userOpHash,
          walletAddress: info.walletAddress,
          walletType: 'MSCA',
          safeToRetry: false,
          message: 'Burn sudah terjadi, tetapi binding CCTP tidak cocok. Mint dan retry diblokir; jangan burn ulang.',
        }) }] }
      }
      let auditPending = false
      const mint = bridgeStatus.verified
        ? await mintDestinationViaMsca({ status: bridgeStatus, route, walletAddress: info.walletAddress, userId, approvalId }).catch(error => ({ success: false, error: error?.message || 'Destination MSCA mint request failed', detail: String(error?.message || error).slice(0, 500), userOpHash: error?.userOpHash || null, explorerUrl: error?.explorerUrl || null, approvalId, safeToRetry: false }))
        : { success: false, error: 'Attestation belum ready', approvalId, safeToRetry: false }
      approvalId = mint.approvalId || approvalId
      if (!mint.success && mint.userOpHash && mint.safeToRetry === false) {
        try {
          approvalId = mint.approvalId || approvalId || await recordBridgePending(userId, {
            agent: requestAgent,
            amount: params.amount,
            fromChain: route.fromKey,
            toChain: route.toKey,
            previewId: params.previewId,
            burnTxHash: result.txHash,
            sourceUserOpHash: result.userOpHash,
            sourceChainKey: executionChainKey(route.fromKey),
            sourceExplorerUrl: result.explorerUrl,
            destinationUserOpHash: mint.userOpHash,
            destinationChainKey: executionChainKey(route.toKey),
            settlementPhase: 'destination_pending',
            error: mint.error,
          })
        } catch (auditError) {
          auditPending = true
          console.error('[mcp-bridge] pending destination audit record failed:', auditError?.message || auditError)
        }
      } else if (mint.success) {
        try {
          await recordAutoExec(userId, {
            agent: requestAgent, action: 'bridge', amount: params.amount, token: 'USDC',
            source: 'session', details: jsonText({ fromChain: route.fromKey, toChain: route.toKey, previewId: params.previewId, burnTxHash: result.txHash, destinationMint: true }),
            txHash: result.txHash, explorerUrl: result.explorerUrl,
          })
        } catch (auditError) {
          auditPending = true
          console.error('[mcp-bridge] audit record failed after burn:', auditError?.message || auditError)
        }
      } else {
        try {
          await updateBridgePending(userId, approvalId, {
            fromChain: route.fromKey,
            toChain: route.toKey,
            previewId: params.previewId,
            burnTxHash: result.txHash,
            sourceUserOpHash: result.userOpHash,
            sourceChainKey: executionChainKey(route.fromKey),
            sourceExplorerUrl: result.explorerUrl,
            settlementPhase: 'destination_pending',
            settlementStatus: 'pending_confirmation',
          }, 'pending_confirmation', { txHash: result.txHash, userOpHash: result.userOpHash, error: mint.error })
        } catch (auditError) {
          auditPending = true
          console.error('[mcp-bridge] pending bridge audit record failed:', auditError?.message || auditError)
        }
      }
      return { content: [{ type: 'text', text: jsonText({
        status: mint.success ? 'executed' : 'settlement_pending',
        executed: true,
        autoMintQueued: Boolean(bridgeStatus.autoMintQueued),
        safeToRetry: mint.success ? false : (mint.safeToRetry ?? false),
        approvalId: (!mint.success && mint.userOpHash && mint.safeToRetry === false && !auditPending) ? approvalId : null,
        destinationMintStatus: mint.success ? 'minted' : (mint.error === 'destination_nonce_check_unavailable' ? 'unknown' : 'pending'),
        destinationMintIdempotent: Boolean(mint.idempotent),
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
        cctpFeeExecuted: bridgeStatus.cctpFeeExecuted || null,
        netMintAmount: bridgeStatus.netMintAmount || null,
        fee: { platformFeeBaseUnits: fee.fee.toString(), netBurnBaseUnits: fee.netAmount.toString(), totalDebitBaseUnits: amount.toString(), cctpMaxFeeBaseUnits: BRIDGE_MAX_FEE.toString() },
        message: mint.success
          ? (mint.idempotent ? 'Destination mint sudah selesai sebelumnya; tidak ada UserOperation ulang.' : 'Bridge MSCA berhasil sampai destination.')
          : (bridgeStatus.autoMintQueued
            ? 'Burn MSCA berhasil; attestation >30 detik sudah dimasukkan ke auto-mint worker. Manual arcox_bridge_status/arcox_retry_bridge_mint tetap tersedia setelah attestation siap.'
            : 'Burn MSCA berhasil; destination mint masih pending. Jalankan arcox_bridge_status lalu retry setelah attestation siap.'),
      }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'bridge_error', executed: false, error: e?.message || 'MSCA bridge gagal' }) }] }
    }
  })

  registerTool('arcox_bridge_status', 'Check attestation and destination mint status for an MSCA bridge burn transaction.', {
    burnTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('Source-chain burn transaction hash'),     fromChain: z.string().describe('Original source chain (arc-testnet or base-sepolia)'),
    toChain: z.string().describe('Destination chain used by the original quote'),
  }, async (params) => {
    if (!ENABLE_MSCA_CCTP_BRIDGE) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'disabled', verified: false, reason: 'msca_bridge_disabled_until_router_validation', message: 'Bridge MSCA status belum diaktifkan karena ArcoxRouter dan destination mint relayer belum tervalidasi. Tidak ada transaksi yang dikirim.' }) }] }
    }
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    const route = bridgeConfig(params.fromChain, params.toChain || 'ethereum-sepolia')
    if (!route || !route.source?.router || !route.destination?.messageTransmitter) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'rejected', reason: 'bridge_route_not_supported_for_msca', message: 'Status bridge MSCA hanya tersedia untuk route CCTP yang memiliki router source dan MessageTransmitter destination.' }) }] }
    }
    let burnProof
    try {
      burnProof = await verifyBridgeBurn({ burnTxHash: params.burnTxHash, route, walletAddress: info.walletAddress })
      if (!burnProof.ok) {
        return { content: [{ type: 'text', text: jsonText({ status: 'rejected', verified: false, reason: burnProof.reason }) }] }
      }
    } catch {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', verified: false, reason: 'bridge_burn_not_found' }) }] }
    }
    const status = await getCctpBridgeStatus({
      burnTxHash: params.burnTxHash,
      sourceDomain: route.source.domain,
      destinationDomain: route.destination.domain,
      walletAddress: info.walletAddress,
      route,
      expectedBurnAmount: BigInt(burnProof.args.amount) - BigInt(burnProof.args.fee),
    })
    if (status.status === 'rejected') return { content: [{ type: 'text', text: jsonText({
      ...status,
      safeToRetry: false,
      message: 'CCTP message tidak terikat ke route/MSCA yang aktif. Tidak ada transaksi baru yang dikirim.',
    }) }] }
    const destinationMint = status.verified
      ? await destinationMintAlreadyProcessed({ status, route })
      : { checked: false, processed: false }
    const nonceDecision = destinationNonceDecision(destinationMint)
    if (nonceDecision === 'unavailable') {
      return { content: [{ type: 'text', text: jsonText({
        ...status,
        status: 'settlement_pending',
        destinationMintStatus: 'unknown',
        reason: destinationMint.reason || 'destination_nonce_check_unavailable',
        safeToRetry: false,
        walletAddress: info.walletAddress,
        walletType: 'MSCA',
        source: route.fromKey,
        note: 'Nonce destination belum dapat diverifikasi. MCP tidak mengirim transaksi baru; retry ditahan sampai RPC membuktikan status nonce.',
      }) }] }
    }
    if (nonceDecision === 'minted') {
      return { content: [{ type: 'text', text: jsonText({
        ...status,
        status: 'minted',
        minted: true,
        destinationMintStatus: 'minted',
        mintTxHash: null,
        safeToRetry: false,
        walletAddress: info.walletAddress,
        walletType: 'MSCA',
        source: route.fromKey,
        note: 'CCTP message sudah diproses di destination. MCP tidak mengirim transaksi baru.',
      }) }] }
    }
    return { content: [{ type: 'text', text: jsonText({
      ...status,
      walletAddress: info.walletAddress,
      walletType: 'MSCA',
      source: route.fromKey,
      destinationMintStatus: status.verified ? 'not_minted' : 'pending',
      note: 'Status ini membaca Iris/Circle attestation dan destination nonce; tidak mengirim transaksi baru.',
    }) }] }
  })

  registerTool('arcox_retry_bridge_mint', 'Retry destination receiveMessage for a confirmed MSCA bridge burn. This never burns again; it only polls attestation and mints the already-bound MSCA recipient.', {
    burnTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('Previously confirmed Arc router bridge transaction hash'),     fromChain: z.string().describe('Original source chain (arc-testnet or base-sepolia)'),
    toChain: z.string().describe('Original destination chain'),
    confirmed: z.boolean().describe('Must be true to retry destination mint'),
    confirmationText: z.string().describe('Must be exactly yes or ya'),
  }, async (params) => {
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) {
      return { content: [{ type: 'text', text: jsonText({ status: 'preview_required', executed: false, message: 'Retry mint memerlukan confirmed=true dan confirmationText exactly yes atau ya.' }) }] }
    }
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    const route = bridgeConfig(params.fromChain, params.toChain)
    const disabledReason = bridgeConfigDisabledReason(route)
    if (disabledReason) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: disabledReason }) }] }
    if (!route || !route.source?.router || !route.destination?.messageTransmitter) return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'rejected', executed: false, reason: 'bridge_route_not_supported_for_msca' }) }] }
    try {
      const proof = await verifyBridgeBurn({ burnTxHash: params.burnTxHash, route, walletAddress: info.walletAddress })
      if (!proof.ok) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: proof.reason, message: 'Burn ini tidak terbukti berasal dari ArcoxRouter untuk MSCA aktif.' }) }] }
      const status = await getCctpBridgeStatus({
        burnTxHash: params.burnTxHash,
        sourceDomain: route.source.domain,
        destinationDomain: route.destination.domain,
        walletAddress: info.walletAddress,
        route,
        expectedBurnAmount: BigInt(proof.args.amount) - BigInt(proof.args.fee),
      })
      if (status.status === 'rejected') return { content: [{ type: 'text', text: jsonText({
        ...status,
        status: 'rejected',
        executed: false,
        safeToRetry: false,
        message: 'CCTP message tidak terikat ke route/MSCA yang aktif. Retry mint diblokir dan tidak ada transaksi destination yang dikirim.',
      }) }] }
      if (!status.verified) return { content: [{ type: 'text', text: jsonText({ status: 'settlement_pending', executed: false, burnTxHash: params.burnTxHash, messageStatus: status.messageStatus || 'pending', message: 'Attestation belum tersedia. Tidak ada transaksi destination yang dikirim.' }) }] }
      const pendingBridgeIntent = await findPendingBridgeMint(userId, params.burnTxHash, route.toKey)
      const destinationMint = await destinationMintAlreadyProcessed({ status, route })
      const nonceDecision = destinationNonceDecision(destinationMint)
      if (nonceDecision === 'unavailable') {
        return { content: [{ type: 'text', text: jsonText({
          status: 'settlement_pending', executed: false, burnTxHash: params.burnTxHash,
          walletAddress: info.walletAddress, walletType: 'MSCA',
          destinationMintStatus: 'unknown', reason: destinationMint.reason || 'destination_nonce_check_unavailable',
          safeToRetry: false, message: 'Nonce destination belum dapat diverifikasi. Tidak ada UserOperation baru yang dikirim; retry ditahan sampai RPC membuktikan status nonce.',
        }) }] }
      }
      if (nonceDecision === 'minted') {
        if (pendingBridgeIntent) {
          await markBridgePendingResolved(userId, pendingBridgeIntent, 'success', {
            ...(pendingBridgeIntent.approval?.txHash ? { txHash: pendingBridgeIntent.approval.txHash } : {}),
            ...(pendingBridgeIntent.approval?.explorerUrl ? { explorerUrl: pendingBridgeIntent.approval.explorerUrl } : {}),
            details: jsonText({ ...pendingBridgeIntent.details, settlementStatus: 'success', settlementPhase: 'destination_minted', destinationMintStatus: 'minted' }),
          })
        }
        return { content: [{ type: 'text', text: jsonText({
          status: 'minted', executed: false, idempotent: true, burnTxHash: params.burnTxHash,
          walletAddress: info.walletAddress, walletType: 'MSCA', mintTxHash: null,
          destinationUserOpHash: null, destinationExplorerUrl: null, safeToRetry: false,
          error: null, message: 'Destination mint sudah selesai sebelumnya. Tidak mengirim UserOperation ulang.',
        }) }] }
      }
      const mint = await mintDestinationViaMsca({ status, route, walletAddress: info.walletAddress, userId, approvalId: pendingBridgeIntent?.approval?.id || null, allowHashlessRecovery: true })
      if (mint.success && pendingBridgeIntent) {
        await markBridgePendingResolved(userId, pendingBridgeIntent, 'success', {
          ...(mint.txHash ? { txHash: mint.txHash } : {}),
          ...(mint.explorerUrl ? { explorerUrl: mint.explorerUrl } : {}),
          ...(mint.userOpHash ? { userOpHash: mint.userOpHash } : {}),
          details: jsonText({ ...pendingBridgeIntent.details, settlementStatus: 'success', settlementPhase: 'destination_minted', destinationMintStatus: 'minted', mintTxHash: mint.txHash || pendingBridgeIntent.details?.mintTxHash || null, destinationUserOpHash: mint.userOpHash || pendingBridgeIntent.details?.destinationUserOpHash || null }),
        })
      }
      return { content: [{ type: 'text', text: jsonText({        status: mint.success ? 'minted' : (mint.error === 'destination_mint_in_flight' || mint.error === 'destination_nonce_check_unavailable' ? 'settlement_pending' : 'mint_failed'), executed: mint.success && !mint.idempotent, idempotent: Boolean(mint.idempotent), burnTxHash: params.burnTxHash, walletAddress: info.walletAddress, walletType: 'MSCA', mintTxHash: mint.txHash || null, destinationUserOpHash: mint.userOpHash || null, destinationExplorerUrl: mint.explorerUrl || null, destinationMintStatus: mint.success ? 'minted' : 'pending', safeToRetry: mint.success ? false : (mint.safeToRetry ?? false), error: mint.success ? null : mint.error, message: mint.success ? (mint.idempotent ? 'Destination mint sudah selesai sebelumnya.' : 'Destination receiveMessage berhasil via MSCA UserOperation.') : (mint.error === 'destination_mint_in_flight' ? 'Destination mint UserOperation masih pending. Jangan retry sampai status UserOperation final.' : 'Destination mint belum aman untuk diulang; pastikan status UserOperation dan nonce destination sudah final.') }) }] }

    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'retry_error', executed: false, burnTxHash: params.burnTxHash, error: e?.message || 'Retry mint gagal' }) }] }
    }
  })

  // ── SEND TOOLS (quote → confirm → execute) ──

  registerTool('arcox_quote_send', 'Get a send quote preview. Show preview to user, wait for confirmation, then call arcox_execute_send', {
    to: z.string().describe('Recipient address'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol. Default USDC'),
    fromChain: z.string().describe('Source chain (for example arc-testnet or base-sepolia). Required.'),
    source: z.string().optional().describe('session'),
  }, async (params) => {
    const token = String(params.token || 'USDC').toUpperCase()
    const src = params.source || 'session'
    const fromChain = executionChainKey(params.fromChain)
    if (src !== 'session') {
      return { content: [{ type: 'text', text: jsonText({ preview: false, rejected: true, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Quote send hanya untuk source=session.' }) }] }
    }
    if (!CHAINS[fromChain]) {
      return { content: [{ type: 'text', text: jsonText({ preview: false, rejected: true, reason: 'unsupported_chain', fromChain: params.fromChain, supportedChains: Object.keys(CHAINS), message: 'fromChain wajib berupa chain yang didukung; tidak ada fallback ke Arc.' }) }] }
    }
    const chain = CHAINS[fromChain]
    if (!chain.tokens[token] && token !== chain.nativeCurrency.symbol) {
      return { content: [{ type: 'text', text: jsonText({ preview: false, rejected: true, reason: 'token_not_supported', fromChain, token, message: `Token ${token} tidak tersedia di ${fromChain}.` }) }] }
    }
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
    // MSCA send quote is bound to the active wallet and exact source chain. A
    // later MSCA or chain change makes the preview unusable instead of silently
    // sending from another wallet/network.
    const q = createExecutionQuote(userId, 'send', { to: params.to, amount: params.amount, token, fromChain, walletAddress: info.walletAddress })
    return { content: [{ type: 'text', text: jsonText({
      schemaVersion: 1,
      preview: true,
      action: 'send',
      to: params.to,
      amount: params.amount,
      token,
      fromChain,
      chain: fromChain,
      source: 'session',
      walletAddress: info.walletAddress,
      walletType: 'MSCA',
      payer: info.walletAddress,
      note: 'Send via Agent Wallet (MSCA/session key): chain wajib eksplisit dan session chain authorization harus aktif.',
      previewId: q.previewId,
      expiresAt: new Date(q.expires).toISOString(),
      safeNextStep: 'Tampilkan preview ini ke user. Setelah user setuju, panggil arcox_execute_send dengan fromChain, source=session, confirmed=true.',
    }) }] }
  })

  registerTool('arcox_execute_send', 'Execute a confirmed send via Agent Wallet (MSCA/session key). Requires previewId from arcox_quote_send and user confirmation.', {
    to: z.string().describe('Recipient address'),
    amount: z.string().describe('Exact amount from quote'),
    token: z.string().optional().describe('Token symbol'),
    fromChain: z.string().describe('Exact source chain from arcox_quote_send; required.'),
    source: z.string().optional().describe('session (MSCA)'),
    previewId: z.string().describe('Preview ID from arcox_quote_send'),
    confirmed: z.boolean().describe('Must be true to execute'),
    confirmationText: z.string().describe('User confirmation text (yes/ya)'),
  }, async (params) => {
    if (!params.confirmed || !validConfirmationText(params.confirmationText)) return { content: [{ type: 'text', text: jsonText({ error: 'Confirmation required. Use confirmed=true and confirmationText exactly yes or ya.' }) }] }
    const source = params.source || 'session'
    const token = String(params.token || 'USDC').toUpperCase()
    const fromChain = executionChainKey(params.fromChain)
    if (source !== 'session') {
      return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: 'msca_only', message: 'MCP server hanya memakai Agent Wallet (MSCA/session key). Parameter source harus "session".' }) }] }
    }
    if (!CHAINS[fromChain]) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'rejected', executed: false, action: 'send', chain: fromChain, walletType: 'MSCA', reason: 'unsupported_chain', fromChain: params.fromChain, supportedChains: Object.keys(CHAINS), message: 'fromChain wajib berupa chain yang didukung; tidak ada fallback ke Arc.' }) }] }
    }
    const activeSession = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!activeSession) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, ...mscaRequiredResult() }) }] }
    const gate = await canAutoExecute(userId, source, params.amount, fromChain)
    if (!gate.ok) {
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'rejected', executed: false, action: 'send', walletType: 'MSCA', reason: gate.reason, chain: fromChain, message: gate.reason === 'no_session' ? 'Session key MSCA belum diaktifkan. User harus setup Agent Wallet (MSCA) + session key di Plugin page.' : gate.message }) }] }
    }
    const quoteCheck = consumeExecutionQuote(userId, 'send', params.previewId, { to: params.to, amount: params.amount, token, fromChain, walletAddress: activeSession.walletAddress })
    if (!quoteCheck.ok) return { content: [{ type: 'text', text: jsonText({ status: 'rejected', executed: false, reason: quoteCheck.reason }) }] }
    try {
      const { sendViaSession } = await import('./sessionKeyService.mjs')
      const result = await sendViaSession(userId, params.to, params.amount, token, { chainKey: fromChain })
      if (result.status === 'success') {
        await recordAutoExec(userId, {
          agent: requestAgent, action: 'send', amount: params.amount, token,
          source: 'session', to: params.to, details: jsonText({ previewId: params.previewId, fromChain }),
          txHash: result.txHash, explorerUrl: result.explorerUrl,
        })
        return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'executed', executed: true, action: 'send', chain: fromChain, walletType: 'MSCA', txHash: result.txHash, explorerUrl: result.explorerUrl, message: `Kirim ${params.amount} ${token} ke ${params.to} berhasil via MSCA (session key).` }) }] }
      }
      return { content: [{ type: 'text', text: jsonText({ schemaVersion: 1, status: 'session_failed', executed: false, action: 'send', chain: fromChain, walletType: 'MSCA', error: result.reason || 'Session send gagal' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ status: 'session_error', executed: false, error: e?.message || 'Session error' }) }] }
    }
  })

  // ── VAULT TOOLS ──

  registerTool('arcox_vault_list_credentials', 'List vault credentials for the authenticated user', {}, async () => {
    const { listCredentials } = await import('./vaultStore.mjs')
    const creds = listCredentials(userId)
    return { content: [{ type: 'text', text: jsonText({ credentials: creds }) }] }
  })

  registerTool('arcox_vault_request_approval', 'Request user approval for a transaction. Agent calls this before executing value-moving actions', {
    action: z.string().describe('swap, bridge, send'),
    amount: z.string().describe('Amount in human readable'),
    token: z.string().optional().describe('Token symbol (USDC, EURC, etc)'),
    source: z.string().optional().describe('session (MSCA)'),
    to: z.string().optional().describe('Destination address'),
  }, async (params) => {
    const { createApproval } = await import('./vaultStore.mjs')
    const approval = createApproval(userId, { agent: requestAgent, ...params })
    return { content: [{ type: 'text', text: jsonText({ approval }) }] }
  })

  registerTool('arcox_vault_get_limits', 'Get spending limits for the authenticated user', {}, async () => {
    const { getLimits } = await import('./vaultStore.mjs')
    const limits = getLimits(userId)
    return { content: [{ type: 'text', text: jsonText({ limits }) }] }
  })

  // ── INFO TOOL ──

  registerTool('arcox_mcp_info', 'Get ARCOX MCP server info, available services, and execution guide', {}, async () => {
    return {
      content: [{
        type: 'text',
        text: jsonText({
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
              ? ['arcox_quote_bridge → show preview → user ya → arcox_execute_bridge → jika pending, arcox_bridge_status. Supported MSCA routes: Arc↔Base Sepolia and Arc↔Arbitrum Sepolia USDC via verified ArcoxRouter deployments.']
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
  registerTool('arcox_session_status', 'Check if Agent Session Key (MSCA) is active for the user. Returns wallet address, delegate address, and whether session signing is available.', {}, async () => {
    try {
      const { getSessionKeyInfo } = await import('./vaultStore.mjs')
      const sessionOwner = boundMscaWalletAddress || userId
      const info = await getSessionKeyInfo(sessionOwner)
      // Recording connection time here lets auto-detect choose the MSCA this user
      // most recently connected via Claude/agent — no hardcoded wallet. When OAuth
      // carries a passkey-proven MSCA, touch that exact wallet rather than the EOA.
      if (info && info.active) {
        try {
          const { touchSessionKey } = await import('./sessionKeyService.mjs')
          touchSessionKey(sessionOwner)
        } catch { /* non-fatal */ }
      }
      if (!info || !info.active) {
        return { content: [{ type: 'text', text: jsonText({ active: false, message: 'Session key belum diaktifkan. User harus setup di Plugin page (passkey required).' }) }] }
      }
      return { content: [{ type: 'text', text: jsonText({
        active: true,
        walletAddress: info.walletAddress,
        delegateAddress: info.delegateAddress,
        createdAt: info.createdAt,
        message: 'Session key aktif. Agent bisa execute tx langsung dengan source=session.',
      }) }] }
    } catch {
      // Never let a malformed/temporarily unavailable store become Claude's
      // opaque "Error occurred during tool execution". The tool contract stays
      // machine-readable and fail-closed; execution tools still require a
      // separately resolved active MSCA/session.
      return { content: [{ type: 'text', text: jsonText({
        active: false,
        statusReason: 'status_unavailable',
        message: 'Status session key sedang tidak tersedia. Hubungkan ulang Agent Wallet lalu coba lagi.',
      }) }] }
    }
  })

  // ── GET REQUEST (poll approval/tx status) ──
  registerTool('arcox_get_request', 'Poll the status of a previously submitted transaction request. Use after execute returns pending_* status. Returns current lifecycle status + txHash if available.', {
    approvalId: z.string().describe('Approval ID or request ID returned by execute tool'),
  }, async (params) => {
    const { listApprovals } = await import('./vaultStore.mjs')
    const approvals = listApprovals(userId)
    const a = approvals.find(x => x.id === params.approvalId)
    if (!a) return { content: [{ type: 'text', text: jsonText({ status: 'not_found', error: 'Approval/request ID not found' }) }] }

    let details = null
    try { details = JSON.parse(a.details || '{}') } catch { /* legacy details */ }
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
      sourceApprovalUserOpHash: details?.sourceApprovalUserOpHash || null,
      sourceUserOpHash: details?.sourceUserOpHash || null,
      sourceChainKey: details?.sourceChainKey || details?.fromChain || null,
      destinationUserOpHash: details?.destinationUserOpHash || null,
      destinationChainKey: details?.destinationChainKey || null,
      createdAt: a.createdAt,
      approvedAt: a.approvedAt || null,
      completedAt: a.completedAt || null,
      error: a.error || null,
    }

    // A hashless source submission cannot be queried by UserOperation hash.
    // Keep it explicitly retry-blocked and tell the agent what read-only
    // evidence is required; never turn an unknown result into a fresh burn.
    const hashlessUnknownSource = a.action === 'bridge'
      && details?.settlementPhase === 'source_submission_unknown'
      && !details?.sourceUserOpHash
      && ['pending_confirmation', 'pending_signature'].includes(a.status)
    const unknownPrecheckSource = a.action === 'bridge'
      && details?.settlementPhase === 'source_submission_failed'
      && details?.userOpAccepted === 'unknown'
      && details?.safeToRetry !== true
    if (hashlessUnknownSource || unknownPrecheckSource) {
      response.status = a.status
      response.safeToRetry = false
      response.userOpAccepted = 'unknown'
      response.reason = 'source_user_operation_reconciliation_required'
      response.reconciliationRequired = true
      response.message = 'UserOperation sumber tidak memiliki hash atau hasil acceptance yang pasti. Rekonsiliasi bundler/receipt secara read-only terlebih dahulu; burn tidak boleh diulang.'
      return { content: [{ type: 'text', text: jsonText(response) }] }
    }

    // Approval and burn are separate source UserOperations. A successful
    // approval is only an intermediate milestone; it must never be fed into
    // burn proof/attestation logic as if it were a burn transaction.
    const pendingSourceOperation = sourceBridgePendingOperation(details)
    const approvalOnlySource = a.action === 'bridge'
      && pendingSourceOperation?.kind === 'approval'
      && ['source_approval_unknown', 'source_approval_submitted', 'source_approval_confirmed'].includes(details?.settlementPhase)
    if (approvalOnlySource && a.userOpHash && ['pending_signature', 'pending_confirmation'].includes(a.status)) {
      try {
        const { getUserOpStatus } = await import('./sessionKeyService.mjs')
        const liveApproval = await getUserOpStatus(userId, pendingSourceOperation.hash, details.sourceChainKey || details.fromChain)
        if (liveApproval.status === 'success') {
          const nextDetails = { ...details, settlementPhase: 'source_approval_confirmed', settlementStatus: 'pending_confirmation' }
          const { updateApprovalStatus, listApprovals } = await import('./vaultStore.mjs')
          updateApprovalStatus(userId, a.id, 'pending_confirmation', { txHash: undefined, explorerUrl: liveApproval.explorerUrl, userOpHash: pendingSourceOperation.hash, details: jsonText(nextDetails) })
          const refreshed = listApprovals(userId).find(item => item.id === a.id)
          response.status = 'pending_confirmation'
          response.sourceApprovalUserOpHash = pendingSourceOperation.hash
          response.sourceUserOpHash = null
          response.userOpHash = pendingSourceOperation.hash
          response.txHash = null
          response.explorerUrl = refreshed?.explorerUrl || liveApproval.explorerUrl || null
          response.settlementPhase = 'source_approval_confirmed'
          response.safeToRetry = false
          response.message = 'Approval MSCA sudah terkonfirmasi. Belum ada burn; lanjutkan arcox_execute_bridge dengan previewId yang sama.'
          return { content: [{ type: 'text', text: jsonText(response) }] }
        }
        if (liveApproval.status === 'error' && liveApproval.receipt && ['reverted', '0x0', 0, false].includes(liveApproval.receipt?.receipt?.status)) {
          const { updateApprovalStatus } = await import('./vaultStore.mjs')
          updateApprovalStatus(userId, a.id, 'error', { userOpHash: pendingSourceOperation.hash, error: liveApproval.reason || 'Source approval UserOperation reverted', details: jsonText({ ...details, settlementPhase: 'source_approval_failed', settlementStatus: 'error', safeToRetry: true }) })
          response.status = 'error'
          response.safeToRetry = true
          response.reason = 'source_approval_reverted'
          response.message = 'Approval MSCA gagal. Belum ada burn; buat quote baru.'
          return { content: [{ type: 'text', text: jsonText(response) }] }
        }
        response.status = 'pending_confirmation'
        response.safeToRetry = false
        response.reason = 'source_approval_pending'
        response.message = 'Approval MSCA masih pending. Burn belum dikirim.'
        return { content: [{ type: 'text', text: jsonText(response) }] }
      } catch {
        response.status = 'pending_confirmation'
        response.safeToRetry = false
        response.reason = 'source_approval_status_unavailable'
        response.message = 'Status approval belum dapat diverifikasi; burn tetap ditahan.'
        return { content: [{ type: 'text', text: jsonText(response) }] }
      }
    }

    // Poll the exact UserOperation on the chain where it was submitted. For a
    // bridge source timeout, a successful source UserOp is only an intermediate
    // milestone: continue burn proof → attestation → destination mint instead
    // of incorrectly marking the approval complete.
    if (a.userOpHash && ['pending_signature', 'pending_confirmation'].includes(a.status)) {
      try {
        const { getUserOpStatus } = await import('./sessionKeyService.mjs')
        const trackedChainKey = details?.destinationUserOpHash
          ? details.destinationChainKey
          : (details?.sourceChainKey || details?.fromChain)
        const liveStatus = await getUserOpStatus(userId, a.userOpHash, trackedChainKey)
        const isBridge = a.action === 'bridge' && Boolean(details?.fromChain && details?.toChain)
        let nextStatus = liveStatus.status
        let nextExtra = { txHash: liveStatus.txHash, explorerUrl: liveStatus.explorerUrl, userOpHash: liveStatus.txHash ? a.userOpHash : undefined }
        let nextDetails = details

        if (isBridge && liveStatus.status === 'success') {
          const resumed = await resumePendingBridgeApproval(userId, a, {
            ...details,
            burnTxHash: details.burnTxHash || liveStatus.txHash,
          }, await (await import('./vaultStore.mjs')).getSessionKeyInfo(userId))
          if (resumed.status === 'success') {
            nextStatus = 'success'
            nextExtra = {
              txHash: resumed.destinationTxHash || liveStatus.txHash,
              explorerUrl: resumed.destinationExplorerUrl || liveStatus.explorerUrl,
              userOpHash: resumed.destinationUserOpHash || a.userOpHash,
            }
            nextDetails = { ...details, burnTxHash: resumed.burnTxHash || details.burnTxHash || liveStatus.txHash, settlementStatus: 'success', destinationUserOpHash: resumed.destinationUserOpHash || details.destinationUserOpHash || null, destinationChainKey: details.destinationChainKey || null }
          } else if (resumed.status === 'error') {
            nextStatus = 'error'
            nextExtra = { txHash: resumed.burnTxHash || liveStatus.txHash, explorerUrl: liveStatus.explorerUrl, userOpHash: a.userOpHash, error: resumed.reason }
            nextDetails = { ...details, burnTxHash: resumed.burnTxHash || details.burnTxHash || liveStatus.txHash, settlementStatus: 'error', reason: resumed.reason }
          } else {
            nextStatus = 'pending_confirmation'
            nextExtra = { txHash: resumed.burnTxHash || liveStatus.txHash, explorerUrl: liveStatus.explorerUrl, userOpHash: resumed.destinationUserOpHash || a.userOpHash, error: resumed.reason }
            nextDetails = { ...details, burnTxHash: resumed.burnTxHash || details.burnTxHash || liveStatus.txHash, settlementStatus: 'pending_confirmation', destinationUserOpHash: resumed.destinationUserOpHash || details.destinationUserOpHash || null, destinationChainKey: resumed.destinationChainKey || details.destinationChainKey || null }
          }
        } else if (liveStatus.status !== 'pending_confirmation') {
          nextStatus = liveStatus.status
        }

          const { updateApprovalStatus, listApprovals } = await import('./vaultStore.mjs')
        updateApprovalStatus(userId, a.id, nextStatus, { ...nextExtra, details: jsonText(nextDetails) })
        const refreshed = listApprovals(userId).find(item => item.id === a.id)
        response.status = nextStatus
        response.approvedAt = refreshed?.approvedAt || response.approvedAt
        response.completedAt = refreshed?.completedAt || response.completedAt
        response.txHash = refreshed?.txHash || nextExtra.txHash || response.txHash
        response.explorerUrl = refreshed?.explorerUrl || nextExtra.explorerUrl || response.explorerUrl
        response.userOpHash = refreshed?.userOpHash || nextExtra.userOpHash || response.userOpHash
        response.sourceApprovalUserOpHash = nextDetails.sourceApprovalUserOpHash || response.sourceApprovalUserOpHash
        response.sourceUserOpHash = nextDetails.sourceUserOpHash || response.sourceUserOpHash
        response.sourceChainKey = nextDetails.sourceChainKey || response.sourceChainKey
        response.destinationUserOpHash = nextDetails.destinationUserOpHash || response.destinationUserOpHash
        response.destinationChainKey = nextDetails.destinationChainKey || response.destinationChainKey
        response.error = refreshed?.error || nextExtra.error || response.error
      } catch { /* polling/recovery failed, return stored status */ }
    }

    return { content: [{ type: 'text', text: jsonText(response) }] }
  })

  // ── INTEL (x402-paid, read-only, via MSCA payment) ──
  // Endpoint ini return invoice (paymentRequired) saat belum dibayar. Setelah
  // arcox_x402_pay_invoice (MSCA), retry dengan paymentId → unlockedResult.

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
    const { getSessionKeyInfo } = await import('./vaultStore.mjs')
    const sessionInfo = await getSessionKeyInfo(userId)
    const headers = {
      ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken(userId)}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}),
      'X-Payment-Id': normalizedParams.paymentId || '',
    }
    const r = await fetch(`${BACKEND_URL}/api/intel${path}`, { headers })
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
        const preview = await previewX402Pay(userId, params.invoiceId)
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
      const result = await executeX402Pay(userId, params.invoiceId)
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
  })  // ── DOCS / CATALOG / GUIDE (read-only, self-contained) ──
  // Ported from the arcox-mcp runtime so plugin agents get the same service
  // catalog, docs search, UI map, action planning, and execution guide.

  const arcoxPages = [
    { id: 'swap', title: 'Swap', purpose: 'Swap retail tokens on Arc Testnet from Agent Wallet (MSCA).', userInputs: ['tokenIn', 'tokenOut', 'amountIn'], actions: ['arcox_quote_swap', 'arcox_execute_swap'] },
    { id: 'bridge', title: 'Bridge', purpose: 'Bridge USDC across Arc/Base/Arbitrum Sepolia via verified ArcoxRouter + CCTP.', userInputs: ['fromChain', 'toChain', 'token', 'amount'], actions: ['arcox_quote_bridge', 'arcox_execute_bridge', 'arcox_bridge_status', 'arcox_retry_bridge_mint'] },
    { id: 'send', title: 'Send', purpose: 'Send supported tokens to another address from the Agent Wallet.', userInputs: ['recipient', 'token', 'amount'], actions: ['arcox_quote_send', 'arcox_execute_send'] },
    { id: 'pay', title: 'ARCOX Pay', purpose: 'Create and pay USDC invoice/payment requests on Arc Testnet.', userInputs: ['amount', 'merchantAddress'], actions: ['arcox_create_payment_request', 'arcox_quote_payment_request', 'arcox_pay_payment_request', 'arcox_check_payment_status'] },
    { id: 'intel', title: 'Intel', purpose: 'Address/entity/token/tx intelligence through ARCOX API (x402 paid).', userInputs: ['address/entity/token/hash'], actions: ['arcox_intel_get_address', 'arcox_intel_get_tx', 'arcox_x402_pay_invoice'] },
    { id: 'ai_router', title: 'AI Router', purpose: 'Manage API keys, list models, call models, and inspect usage.', userInputs: ['prompt'], actions: ['get_ai_router_status', 'create_ai_api_key', 'list_ai_models', 'call_ai_model', 'get_usage_logs'] },
  ]
  const arcoxActions = [
    { id: 'swap', page: 'swap', intentExamples: ['swap 1 eurc to usdc', 'berapa dapat usdc dari 5 eurc'], requiredSlots: ['tokenIn', 'tokenOut', 'amountIn'], safeExecution: 'quote_then_confirm' },
    { id: 'bridge', page: 'bridge', intentExamples: ['bridge 1 usdc dari arc ke base', 'bridge dari arbitrum ke arc'], requiredSlots: ['fromChain', 'toChain', 'token', 'amount'], safeExecution: 'quote_then_confirm' },
    { id: 'send', page: 'send', intentExamples: ['send 5 usdc ke 0x...', 'kirim usdc dari agent wallet'], requiredSlots: ['recipient', 'token', 'amount'], safeExecution: 'quote_then_confirm' },
    { id: 'pay_invoice', page: 'pay', intentExamples: ['create payment request 10 usdc ke 0x...', 'bayar invoice arcox'], requiredSlots: ['amount', 'merchantAddress'], safeExecution: 'quote_then_confirm' },
    { id: 'intel', page: 'intel', intentExamples: ['analyze address 0x...', 'check token btc'], requiredSlots: ['address/entity/token/hash'], safeExecution: 'x402_paid_read' },
  ]
  const arcoxChainSupport = {
    Arc_Testnet: { bridge: true, router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7', circleWallet: true, aliases: ['arc', 'arc testnet'] },
    Ethereum_Sepolia: { bridge: true, router: '0x53aB114FeE64b177B8D6066056DfD03Ea38D0ef1', circleWallet: false, aliases: ['ethereum', 'eth sepolia'] },
    Base_Sepolia: { bridge: true, router: '0x9425cC5b3C8B9e0FCb35beBdE737B4365A614Acc', circleWallet: false, aliases: ['base', 'base sepolia'] },
    Arbitrum_Sepolia: { bridge: true, router: '0x5dCAA895dDc7350cF0f9eb69E69536a4548b0cA7', circleWallet: false, aliases: ['arbitrum', 'arb sepolia'] },
  }
  const arcoxRetailRules = [
    'Always quote before swap, bridge, send, or invoice payment.',
    'Never execute a value-moving action without explicit user confirmation (yes/ya).',
    'Bridge pending is normal after burn; poll arcox_bridge_status and retry mint with the burn tx.',
    'Agent may prepare plans, but user-owned funds require explicit confirmation.',
  ]
  const arcoxDocsCatalog = [
    { id: 'overview', title: 'ARCOX Overview', tags: ['dex', 'arc', 'wallet'], body: 'ARCOX DEX is a retail Arc Testnet app for swap, bridge, send, ARCOX Pay invoices, and agent workflows. Value-moving actions must quote before execution.' },
    { id: 'pay', title: 'ARCOX Pay', tags: ['pay', 'invoice', 'usdc'], body: 'ARCOX Pay creates public USDC invoice/payment links on Arc Testnet. Invoice payment requires preview and confirmation.' },
    { id: 'bridge-retry', title: 'Bridge Retry', tags: ['bridge', 'retry', 'cctp'], body: 'CCTP bridge has approve, burn, attestation, and mint stages. If burn succeeded but mint is pending, retry mint instead of repeating the burn.' },
    { id: 'mcp-safety', title: 'MCP Safety Rules', tags: ['mcp', 'agent', 'safety'], body: 'Agents must call quote tools first, show preview, receive explicit confirmation, then execute with previewId and confirmationText.' },
    { id: 'intel-x402', title: 'Intel x402', tags: ['intel', 'x402', 'arkham'], body: 'ARCOX Intel is x402 paid: unpaid requests return an invoice; pay via arcox_x402_pay_invoice then retry with paymentId.' },
  ]

  registerTool('arcox_search_docs', 'Search ARCOX product and MCP documentation. Use this before guessing an unfamiliar ARCOX flow.', {
    query: z.string().describe('Search query'),
  }, async (params) => {
    const words = String(params.query || '').toLowerCase().split(/\W+/).filter(Boolean)
    const results = arcoxDocsCatalog.map(doc => {
      const haystack = [doc.id, doc.title, ...(doc.tags || []), doc.body].join(' ').toLowerCase()
      const score = words.reduce((sum, w) => sum + (haystack.includes(w) ? 1 : 0), 0)
      return { id: doc.id, title: doc.title, tags: doc.tags, score, snippet: doc.body.slice(0, 220) }
    }).filter(item => item.score > 0 || !words.length).sort((a, b) => b.score - a.score)
    return { content: [{ type: 'text', text: jsonText({ query: params.query, results, safeNextStep: results.length ? 'Call arcox_read_doc with the selected id before acting on unfamiliar flows.' : 'No doc match found. Ask the user to clarify the desired ARCOX flow.' }) }] }
  })

  registerTool('arcox_read_doc', 'Read a structured ARCOX documentation page by id returned from arcox_search_docs.', {
    id: z.string().describe('Document id from arcox_search_docs'),
  }, async (params) => {
    const doc = arcoxDocsCatalog.find(item => item.id === String(params.id || '').toLowerCase())
    if (!doc) return { content: [{ type: 'text', text: jsonText({ error: `Unknown ARCOX doc id: ${params.id}` }) }] }
    return { content: [{ type: 'text', text: jsonText({ ...doc }) }] }
  })

  registerTool('arcox_service_catalog', 'Return a concise catalog of ARCOX MCP services, capabilities, safety rules, and example prompts.', {}, async () => {
    return { content: [{ type: 'text', text: jsonText({
      project: 'ARCOX DEX + ARCOX MCP',
      safety: 'All value-moving tools must quote/preview first and require user confirmation.',
      services: [
        { name: 'wallet_balances', description: 'Read Agent Wallet MSCA balances across chains.' },
        { name: 'swap', description: 'Quote and execute supported Arc swaps with preview-before-execute.' },
        { name: 'bridge', description: 'Quote and execute supported USDC CCTP bridge routes; attestation-ready destinations mint automatically or via arcox_retry_bridge_mint.' },
        { name: 'send', description: 'Quote and send supported Arc tokens from the Agent Wallet.' },
        { name: 'arcox_pay', description: 'Create/quote/pay/check ARCOX Pay invoice workflows.' },
        { name: 'intel_x402', description: 'ARCOX Intel via backend Arkham API with Arc Testnet USDC x402 payment.' },
        { name: 'ai_router', description: 'Check AI Router status, create/revoke API keys, list models, call models, and inspect usage.' },
        { name: 'agentic_jobs', description: 'List/create/complete Agentic Economy jobs through the AI Router API.' },
      ],
      examplePrompts: [
        'show all wallet balances', 'quote bridge 1 usdc from arc to base', 'check auto mint worker status for 0xBURN_TX',
        'send 1 eurc from agent wallet to 0x...', 'retry bridge 0xBURN_TX from arbitrum sepolia to arc', 'quote swap 1 eurc to usdc',
        'create payment request 10 usdc to 0x...', 'check x402 invoice arcox_x402_...', 'list ai router models', 'call ai router model with prompt ...',
      ],
    }) }] }
  })

  registerTool('arcox_catalog', 'Backward-compatible alias for arcox_service_catalog.', {}, async () => ({
    content: [{ type: 'text', text: jsonText({
      project: 'ARCOX DEX + ARCOX MCP',
      safety: 'All value-moving tools must quote/preview first and require user confirmation.',
      services: [
        { name: 'wallet_balances', description: 'Read Agent Wallet MSCA balances across chains.' },
        { name: 'swap', description: 'Quote and execute supported Arc swaps with preview-before-execute.' },
        { name: 'bridge', description: 'Quote and execute supported USDC CCTP bridge routes; attestation-ready destinations mint automatically or via arcox_retry_bridge_mint.' },
        { name: 'send', description: 'Quote and send supported Arc tokens from the Agent Wallet.' },
        { name: 'arcox_pay', description: 'Create/quote/pay/check ARCOX Pay invoice workflows.' },
        { name: 'intel_x402', description: 'ARCOX Intel via backend Arkham API with Arc Testnet USDC x402 payment.' },
        { name: 'ai_router', description: 'Check AI Router status, create/revoke API keys, list models, call models, and inspect usage.' },
        { name: 'agentic_jobs', description: 'List/create Agentic Economy jobs through the AI Router API.' },
      ],
      examplePrompts: [
        'show all wallet balances', 'quote bridge 1 usdc from arc to base', 'check auto mint worker status for 0xBURN_TX',
        'send 1 eurc from agent wallet to 0x...', 'retry bridge 0xBURN_TX from arbitrum sepolia to arc', 'quote swap 1 eurc to usdc',
        'create payment request 10 usdc to 0x...', 'check x402 invoice arcox_x402_...', 'list ai router models', 'call ai router model with prompt ...',
      ],
    }) }],
  }))

  registerTool('arcox_execution_guide', 'Return exact step-by-step tool routes for every ARCOX MCP flow so agents do not guess tool order.', {
    intent: z.string().optional().describe('Optional filter: swap, bridge, send, pay, intel, retry'),
  }, async (params) => {
    const guide = {
      rule: 'Never guess tool order. For every value-moving request: quote first, show preview, wait for user yes/ya, then execute with previewId and confirmationText.',
      flows: [
        { intent: 'swap', steps: ['arcox_quote_swap', 'show preview', 'user yes', 'arcox_execute_swap with confirmed=true, previewId, confirmationText'] },
        { intent: 'bridge', steps: ['arcox_quote_bridge', 'show preview', 'user yes', 'arcox_execute_bridge', 'if pending: arcox_bridge_status / arcox_retry_bridge_mint'] },
        { intent: 'send', steps: ['arcox_quote_send', 'show preview', 'user yes', 'arcox_execute_send'] },
        { intent: 'pay', steps: ['arcox_create_payment_request or arcox_get_payment_request', 'arcox_quote_payment_request', 'show preview', 'user yes', 'arcox_pay_payment_request'] },
        { intent: 'intel', steps: ['arcox_intel_get_* to get invoice', 'arcox_x402_pay_invoice without confirmed for preview', 'user yes', 'pay with confirmed=true, previewId', 'retry intel with paymentId'] },
        { intent: 'retry', steps: ['arcox_bridge_status with burnTxHash', 'if attestation ready: arcox_retry_bridge_mint'] },
      ],
      recovery: ['If a tool returns preview_required, call the same tool without confirmed to get previewId.', 'If invoice status is payment_required/settlement_pending, poll status; do not ask for txHash.', 'If a call times out, check status/history before repeating value-moving execution.'],
    }
    const intent = String(params.intent || '').toLowerCase()
    const flows = intent ? guide.flows.filter(f => f.intent.includes(intent) || intent.includes(f.intent)) : guide.flows
    return { content: [{ type: 'text', text: jsonText({ ...guide, flows }) }] }
  })

  registerTool('arcox_ui_map', 'Return the full ARCOX DEX page/action map so an agent can understand the Web UI.', {}, async () => ({
    content: [{ type: 'text', text: jsonText({ pages: arcoxPages, actions: arcoxActions, chains: arcoxChainSupport, retailRules: arcoxRetailRules }) }],
  }))

  registerTool('arcox_action_plan', 'Convert a user intent into a cautious ARCOX action plan with missing slots and signing rules.', {
    intent: z.string().describe('User intent, e.g. bridge 1 usdc arc ke base'),
    pageHint: z.string().optional(),
  }, async (params) => {
    const text = `${params.intent} ${params.pageHint || ''}`.toLowerCase()
    const action = arcoxActions.map(a => ({ action: a, score: [a.id, a.page, ...a.intentExamples].join(' ').toLowerCase().split(/\W+/).reduce((sum, w) => sum + (w && text.includes(w) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score)[0]
    if (!action?.score) return { content: [{ type: 'text', text: jsonText({ status: 'needs_clarification', reason: 'No matching ARCOX action found.', safeNextStep: 'Call arcox_execution_guide, then ask whether user wants swap, bridge, send, pay, or intel.' }) }] }
    const page = arcoxPages.find(p => p.id === action.action.page)
    return { content: [{ type: 'text', text: jsonText({ status: 'planned', matchedAction: action.action, page, missingSlots: action.action.requiredSlots, safetyRules: arcoxRetailRules, safeNextStep: action.action.safeExecution === 'quote_then_confirm' ? 'Quote/preview first, request explicit user confirmation, then execute with previewId and confirmationText.' : 'Fetch quote/status only.' }) }] }
  })

  registerTool('arcox_agent_status', 'Return the bound Agent Wallet MSCA status, delegate, and balances without exposing signing secrets.', {}, async () => {
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    if (!info) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
    const balances = await apiGet(`/api/multi-balance/${encodeURIComponent(info.walletAddress)}`, info.walletAddress).catch(() => null)
    return { content: [{ type: 'text', text: jsonText({
      status: 'active', walletAddress: info.walletAddress, delegateAddress: info.delegateAddress, active: true,
      balances: balances?.balances || null,
      safeNextStep: 'Read-only status. For balances use arcox_wallet_balances.',
    }) }] }
  })

  // ── ARCOX PAY (invoice / payment request) tools — backed by /api/invoices ──
  // Ported from the arcox-mcp runtime but executed with the Agent Wallet MSCA
  // session key instead of a local EOA signer.

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
      const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const invoice = await apiGet(`/api/invoices/${encodeURIComponent(params.invoiceId)}`, userId)
      if (invoice?.error) return { content: [{ type: 'text', text: jsonText({ error: invoice.error }) }] }
      assertPayableInvoice(invoice)
      const { readContract } = await import('viem/actions')
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
      const quote = await server._registeredTools.arcox_quote_payment_request.handler({ invoiceId: params.invoiceId })
      const q = JSON.parse(quote.content[0].text)
      return { content: [{ type: 'text', text: jsonText({ status: 'preview', requiresUserConfirmation: true, ...q, safeNextStep: 'Tampilkan preview ini ke user. Setelah user bilang yes/ya, panggil arcox_pay_payment_request dengan confirmed=true dan confirmationText.' }) }] }
    }
    if (!['yes', 'ya'].includes(String(params.confirmationText || '').trim().toLowerCase())) {
      return { content: [{ type: 'text', text: jsonText({ status: 'confirmation_required', reason: 'Konfirmasi eksplisit (ya/yes) wajib sebelum bayar invoice.' }) }] }
    }
    try {
      const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
      if (!info) return { content: [{ type: 'text', text: jsonText(mscaRequiredResult()) }] }
      const invoice = await apiGet(`/api/invoices/${encodeURIComponent(params.invoiceId)}`, userId)
      if (invoice?.error) return { content: [{ type: 'text', text: jsonText({ error: invoice.error }) }] }
      assertPayableInvoice(invoice)
      if (params.amount && String(params.amount) !== String(invoice.amount)) throw new Error('Invoice amount changed after quote.')
      if (params.token && String(params.token).toUpperCase() !== String(invoice.token).toUpperCase()) throw new Error('Invoice token changed after quote.')
      if (params.merchantAddress && String(params.merchantAddress).toLowerCase() !== String(invoice.merchantAddress).toLowerCase()) throw new Error('Invoice merchantAddress changed after quote.')
      const { executeViaSession } = await import('./sessionKeyService.mjs')
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

  // ── ARCOX INTEL full wallet report (x402-paid) ──
  registerTool('arcox_intel_quote_wallet_report', 'Quote an ARCOX Intel full wallet report. Shows x402 price and confirmation requirement before paid analysis.', {
    address: z.string().describe('Wallet address (0x...)'),
  }, async (params) => {
    try {
      const sessionInfo = await (await import('./vaultStore.mjs')).getSessionKeyInfo(userId)
      const r = await fetch(`${BACKEND_URL}/api/intel/report/address/${encodeURIComponent(params.address)}`, { headers: { ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken(userId)}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}) } })
      const data = await r.json()
      return { content: [{ type: 'text', text: jsonText({ ...data, safeNextStep: data?.paymentRequired || data?.invoice ? 'Invoice x402 dibuat. Pay via arcox_x402_pay_invoice (tanpa confirmed) untuk preview, lalu retry dengan paymentId.' : 'Report tersedia. Call arcox_intel_execute_wallet_report dengan paymentId jika belum ter-unlock.' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'quote wallet report failed' }) }] }
    }
  })

  registerTool('arcox_intel_execute_wallet_report', 'Execute an ARCOX Intel full wallet report after x402 payment. If no paymentId is supplied, returns a payment preview/invoice only.', {
    address: z.string().describe('Wallet address (0x...)'),
    paymentId: z.string().optional().describe('x402 paymentId if already paid'),
  }, async (params) => {
    try {
      const sessionInfo = await (await import('./vaultStore.mjs')).getSessionKeyInfo(userId)
      const r = await fetch(`${BACKEND_URL}/api/intel/report/address/${encodeURIComponent(params.address)}`, { headers: { ...(sessionInfo?.active && sessionInfo.walletAddress ? { Authorization: `Bearer ${mintOwnerToken(userId)}`, 'X-Arcox-Owner': sessionInfo.walletAddress } : {}), 'X-Payment-Id': params.paymentId || '' } })
      const data = await r.json()
      if (r.status === 402 || data?.paymentRequired) return { content: [{ type: 'text', text: jsonText({ paymentRequired: true, ...data, safeNextStep: 'Pay via arcox_x402_pay_invoice (tanpa confirmed) untuk preview, lalu retry tool ini dengan paymentId.' }) }] }
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'execute wallet report failed' }) }] }
    }
  })

  // ── AI ROUTER tools (owner-scoped, backed by /api/ai-router) ──
  const routerOwner = async () => {
    const info = await resolveActiveMsca(userId, boundMscaWalletAddress)
    return info?.walletAddress || ''
  }

  registerTool('get_ai_router_status', 'Get ARCOX AI Router status for the bound Agent Wallet owner.', {
    ownerAddress: z.string().optional().describe('Optional explicit owner address (must match the active MSCA)'),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/status?ownerAddress=${encodeURIComponent(owner)}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'ai router status failed' }) }] }
    }
  })

  registerTool('list_agent_identities', 'List Arc Agent Identities owned by the bound Agent Wallet.', {
    ownerAddress: z.string().optional(), refresh: z.boolean().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/agent-identities?ownerAddress=${encodeURIComponent(owner)}${params.refresh ? '&refresh=true' : ''}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list agent identities failed' }) }] }
    }
  })

  registerTool('select_agent_identity', 'Select an owned Arc Agent Identity as the active identity for new API keys and Agent Jobs.', {
    agentId: z.string().describe('Agent id'), ownerAddress: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiPost('/api/ai-router/agent-identities/select', { ownerAddress: owner, agentId: params.agentId }, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'select agent identity failed' }) }] }
    }
  })

  registerTool('get_ai_router_api_keys', 'List AI Router API keys for the bound Agent Wallet owner.', {
    ownerAddress: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/api-keys?ownerAddress=${encodeURIComponent(owner)}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list api keys failed' }) }] }
    }
  })

  registerTool('create_ai_api_key', 'Create a standard ARCOX AI Router API key. Returns the key once; backend stores only its hash.', {
    ownerAddress: z.string().optional(), label: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiPost('/api/ai-router/api-keys', { ownerAddress: owner, label: params.label || 'ARCOX MCP AI Router' }, owner)
      return { content: [{ type: 'text', text: jsonText({ ...data, safeNextStep: 'Copy the apiKey now. ARCOX stores only the hash and cannot show it again.' }) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'create api key failed' }) }] }
    }
  })

  registerTool('revoke_ai_api_key', 'Revoke an ARCOX AI Router API key owned by the bound Agent Wallet.', {
    keyId: z.string().describe('Key id'), ownerAddress: z.string().optional(),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiPost(`/api/ai-router/api-keys/${encodeURIComponent(params.keyId)}/revoke`, { ownerAddress: owner }, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'revoke api key failed' }) }] }
    }
  })

  registerTool('list_ai_models', 'List OpenAI-compatible ARCOX AI Router models.', {}, async () => {
    try {
      const data = await apiGet('/api/ai-router/models', userId)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list models failed' }) }] }
    }
  })

  registerTool('get_usage_logs', 'Get ARCOX AI Router usage logs for the bound Agent Wallet owner.', {
    ownerAddress: z.string().optional(), limit: z.number().optional().describe('Default 10'),
  }, async (params) => {
    try {
      const owner = params.ownerAddress || await routerOwner()
      if (!owner) return { content: [{ type: 'text', text: jsonText({ ...mscaRequiredResult(), status: 'no_session' }) }] }
      const data = await apiGet(`/api/ai-router/usage?ownerAddress=${encodeURIComponent(owner)}&limit=${params.limit || 10}`, owner)
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'usage logs failed' }) }] }
    }
  })

  registerTool('call_ai_model', 'Call ARCOX AI Router directly with a standard arx_sk API key (billing via Unified Balance Auto Pay).', {
    prompt: z.string().describe('User prompt'),
    model: z.string().optional().describe('Default arcox/auto'),
    apiKey: z.string().optional().describe('arx_sk_... API key. Required unless set in backend env.'),
  }, async (params) => {
    try {
      const apiKey = String(params.apiKey || process.env.ARCOX_AI_ROUTER_API_KEY || '').trim()
      if (!apiKey.startsWith('arx_sk_')) return { content: [{ type: 'text', text: jsonText({ error: 'ARCOX AI Router API key is required (arx_sk_...). Create one with create_ai_api_key.' }) }] }
      const r = await fetch(`${BACKEND_URL}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: params.model || 'arcox/auto', messages: [{ role: 'user', content: params.prompt }], temperature: 0.7 }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await r.json().catch(() => ({}))
      if (r.status === 402) return { content: [{ type: 'text', text: jsonText({ status: 'payment_required', ...data, safeNextStep: 'Deposit USDC to Unified Balance in ARCOX Web UI, enable Auto Pay, then retry.' }) }] }
      if (!r.ok || data?.error) return { content: [{ type: 'text', text: jsonText({ error: data?.error?.message || data?.error || `HTTP ${r.status}` }) }] }
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'call ai model failed' }) }] }
    }
  })

  // ── AGENT JOBS (via AI Router API key, agent:jobs scope) ──
  registerTool('list_agent_jobs', 'List identity-bound Agent Job summaries for the ARCOX API key.', {
    apiKey: z.string().describe('arx_sk_... API key with agent:jobs scope'), limit: z.number().optional().describe('Default 50'),
  }, async (params) => {
    try {
      const key = String(params.apiKey || '').trim()
      if (!key.startsWith('arx_sk_')) return { content: [{ type: 'text', text: jsonText({ error: 'ARCOX API key required (arx_sk_... with agent:jobs scope).' }) }] }
      const r = await fetch(`${BACKEND_URL}/api/ai-router/agent-jobs?limit=${params.limit || 50}`, { headers: { Authorization: `Bearer ${key}` } })
      const data = await r.json()
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'list agent jobs failed' }) }] }
    }
  })

  registerTool('create_agent_job', 'Record an identity-bound Agent Job through the AI Router API key.', {
    apiKey: z.string().describe('arx_sk_... API key with agent:jobs scope'),
    agentId: z.string().optional(), jobId: z.string().optional(), txHash: z.string().optional(), memoId: z.string().optional(),
    status: z.string().optional().describe('Default created'),
  }, async (params) => {
    try {
      const key = String(params.apiKey || '').trim()
      if (!key.startsWith('arx_sk_')) return { content: [{ type: 'text', text: jsonText({ error: 'ARCOX API key required (arx_sk_... with agent:jobs scope).' }) }] }
      const r = await fetch(`${BACKEND_URL}/api/ai-router/agent-jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ agentId: params.agentId, jobId: params.jobId, txHash: params.txHash, memoId: params.memoId, status: params.status || 'created' }),
      })
      const data = await r.json()
      return { content: [{ type: 'text', text: jsonText(data) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: jsonText({ error: e?.message || 'create agent job failed' }) }] }
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
  if ((auth.resource || MCP_RESOURCE_URL) !== MCP_RESOURCE_URL) {
    res.setHeader('WWW-Authenticate', `Bearer realm="ARCOX MCP", error="invalid_token", error_description="wrong resource"`)
    return res.status(401).json({ error: 'invalid_token', error_description: 'Token is not valid for this MCP resource' })
  }

  // Track MCP session for connection status — derive the REAL agent name from
  // the registered OAuth client (Claude vs ChatGPT) instead of hardcoding it, so
  // the Plugin page can show which agent is actually connected.
  const { registerMcpSession, listMcpSessions } = await import('./vaultStore.mjs')
  const agentName = resolveAgentName(auth.clientId)
  // Keep activity as observability only. A valid MCP bearer token and an
  // explicitly authorized session key remain usable after any idle period;
  // inactivity alone must not force a new passkey ceremony.
  let sessionKeyTouched = false
  try {
    const { touchSessionKey } = await import('./sessionKeyService.mjs')
    sessionKeyTouched = Boolean(touchSessionKey(auth.userId))
  } catch {
    // A read-only MCP request must still work when no MSCA session is linked.
  }
  registerMcpSession(auth.userId, auth.clientId, agentName, sessionKeyTouched)
  mcpSessionsRef = listMcpSessions

  // Handle MCP initialize and tool calls via Streamable HTTP
  const sessionId = req.headers['mcp-session-id'] || randomUUID()
  
  const boundMscaWalletAddress = auth.mscaWalletAddress || ''
  let session = sessions.get(sessionId)
  // Claude may reuse an MCP session id after OAuth reconnect/rebinding. Never
  // reuse a server created for a different verified MSCA context; otherwise the
  // request's fresh OAuth token is silently ignored by the old tool closure.
  if (session && (session.userId !== auth.userId
    || session.clientId !== auth.clientId
    || (session.boundMscaWalletAddress || '') !== boundMscaWalletAddress)) {
    sessions.delete(sessionId)
    try { await session.server?.close?.() } catch { /* already closed */ }
    session = null
  }
  if (!session) {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId })
    const server = createMcpServer(auth.userId, { agent: agentName, boundMscaWalletAddress })
    await server.connect(transport)
    session = { transport, server, userId: auth.userId, clientId: auth.clientId, boundMscaWalletAddress, lastActivity: Date.now() }
    sessions.set(sessionId, session)
    scheduleMcpSessionCleanup(sessionId, session)
  } else {
    // A valid OAuth request keeps the same MCP transport alive. This is not
    // session-key authorization and does not revoke/reactivate anything.
    session.lastActivity = Date.now()
  }

  await session.transport.handleRequest(req, res, req.body)
}

function scheduleMcpSessionCleanup(sessionId, session) {
  const elapsed = Date.now() - Number(session.lastActivity || Date.now())
  const delay = Math.max(1000, MCP_SESSION_IDLE_TTL_MS - elapsed)
  const timer = setTimeout(() => {
    if (sessions.get(sessionId) !== session) return
    if (shouldExpireMcpSession(session)) {
      sessions.delete(sessionId)
      try { session.server.close() } catch {}
      return
    }
    scheduleMcpSessionCleanup(sessionId, session)
  }, delay)
  if (timer.unref) timer.unref()
}
