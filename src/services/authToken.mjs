// Shared backend auth-token minting for the MCP server.
//
// The DEX frontend authenticates a wallet via SIWE (`POST /api/auth/login`) and
// receives an HMAC-signed token that `requireAuth` in server.mjs validates for
// the protected money endpoints (/api/eoa-swap-quote, /api/send-estimate, ...).
//
// The remote MCP server authenticates the SAME wallet via OAuth 2.1 + SIWE
// (userId === wallet address, ownership proven). So it is legitimate for the MCP
// server to mint a backend auth token for that verified userId in order to read
// quotes on the user's behalf. This is the exact same token shape and trust level
// as the DEX SIWE login — it does NOT grant fund movement (execute tools still
// route through the vault approval + frontend MetaMask flow).
//
// Algorithm MUST stay byte-for-byte identical to createAuthToken/verifyAuthToken
// in server.mjs (same AUTH_SECRET, same payload, same HMAC-SHA256/base64url).
import { createHmac } from 'crypto'
import { getAddress } from 'viem'

const AUTH_SECRET = process.env.AUTH_SECRET || ''
const AUTH_TTL_MS = Number(process.env.AUTH_TTL_MS || 24 * 60 * 60 * 1000)

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function signPayload(payload) {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url')
}

// Mint a backend auth token for an already-verified wallet address.
// Returns '' when AUTH_SECRET is missing or the address is invalid.
export function mintOwnerToken(address) {
  if (!AUTH_SECRET || !address) return ''
  let normalized
  try {
    normalized = getAddress(address).toLowerCase()
  } catch {
    return ''
  }
  const payload = b64url(JSON.stringify({ address: normalized, exp: Date.now() + AUTH_TTL_MS }))
  return `${payload}.${signPayload(payload)}`
}
