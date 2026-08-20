import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const mode = String(process.env.SUPABASE_PERSISTENCE_MODE || (process.env.NODE_ENV === 'production' ? 'shadow' : 'off')).toLowerCase()
const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '')
const enabled = (mode === 'shadow' || mode === 'canary')
  && /^https:\/\/[^\s]+\.supabase\.co$/.test(url)
  && serviceRoleKey.length > 20

const client = enabled
  ? createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  : null

const stats = globalThis.__arcoxSupabaseOAuthShadowStats || {
  writes: 0,
  failures: 0,
  lastError: '',
}
globalThis.__arcoxSupabaseOAuthShadowStats = stats

function sha256(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function isoOrNull(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function safePayload(payload = {}) {
  // Explicit allow-list: never persist protocol secrets or user assertions.
  return {
    clientIdHash: payload.clientId ? sha256(payload.clientId) : '',
    userIdHash: payload.userId ? sha256(payload.userId) : '',
    redirectUriHash: payload.redirectUri ? sha256(payload.redirectUri) : '',
    resourceHash: payload.resource ? sha256(payload.resource) : '',
    requestIdHash: payload.requestId ? sha256(payload.requestId) : '',
    challengeNonceHash: payload.challengeNonce ? sha256(payload.challengeNonce) : '',
    hasPkceChallenge: Boolean(payload.codeChallenge),
    hasMscaWalletAddress: Boolean(payload.mscaWalletAddress),
  }
}

export function supabaseOAuthShadowStatus() {
  return {
    enabled,
    mode,
    primary: false,
    writes: stats.writes,
    failures: stats.failures,
    lastError: stats.lastError,
  }
}

export function buildOAuthShadowRow({ stateKey, stateType, expiresAt, consumed = false, payload = {} }) {
  if (!stateKey || !['authorization_code', 'oauth_request', 'siwe_challenge'].includes(String(stateType))) return null
  const expiry = isoOrNull(expiresAt)
  if (!expiry) return null
  return {
    state_key: sha256(stateKey),
    state_type: String(stateType),
    expires_at: expiry,
    consumed: Boolean(consumed),
    payload: safePayload(payload),
  }
}

export function scheduleOAuthShadowState(row) {
  if (!enabled || !row) return
  void client.from('oauth_ephemeral_state').upsert({
    ...row,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'state_key' }).then(({ error }) => {
    if (error) throw error
    stats.writes++
  }).catch(error => {
    stats.failures++
    stats.lastError = String(error?.message || error).slice(0, 240)
  })
}

export function scheduleOAuthShadowSnapshot({ codes = new Map(), requests = new Map(), challenges = new Map() } = {}) {
  for (const [stateKey, payload] of codes) {
    scheduleOAuthShadowState(buildOAuthShadowRow({
      stateKey,
      stateType: 'authorization_code',
      expiresAt: payload?.expires,
      consumed: Boolean(payload?.consumed),
      payload,
    }))
  }
  for (const [stateKey, payload] of requests) {
    scheduleOAuthShadowState(buildOAuthShadowRow({
      stateKey,
      stateType: 'oauth_request',
      expiresAt: payload?.expires,
      payload,
    }))
  }
  for (const [stateKey, payload] of challenges) {
    scheduleOAuthShadowState(buildOAuthShadowRow({
      stateKey,
      stateType: 'siwe_challenge',
      expiresAt: payload?.expires,
      consumed: Boolean(payload?.consumed),
      payload: { ...payload, challengeNonce: stateKey },
    }))
  }
}

export function scheduleOAuthShadowDelete(stateKey) {
  if (!enabled || !stateKey) return
  void client.from('oauth_ephemeral_state').delete().eq('state_key', sha256(stateKey)).then(({ error }) => {
    if (error) throw error
  }).catch(error => {
    stats.failures++
    stats.lastError = String(error?.message || error).slice(0, 240)
  })
}

export async function purgeExpiredOAuthShadowState() {
  if (!enabled) return { enabled: false, deleted: 0 }
  const { data, error } = await client
    .from('oauth_ephemeral_state')
    .delete()
    .lt('expires_at', new Date().toISOString())
    .select('state_key')
  if (error) throw error
  return { enabled: true, deleted: Array.isArray(data) ? data.length : 0 }
}

export { enabled as supabaseOAuthShadowEnabled }
