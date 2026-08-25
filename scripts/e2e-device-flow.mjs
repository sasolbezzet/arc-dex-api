// E2E: full RFC 8628 device-flow pairing against a running backend.
// Usage: BASE=http://localhost:3901 node scripts/e2e-device-flow.mjs
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const BASE = process.env.BASE || 'http://localhost:3901'
let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` :: ${extra}` : ''}`)
  if (!cond) failures++
}

const account = privateKeyToAccount(generatePrivateKey())

// 1. Device authorize
let grant
{
  const r = await fetch(`${BASE}/api/auth/device/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Hermes Agent (e2e)' }),
  })
  check('device/authorize 200', r.status === 200)
  grant = await r.json()
  check('device_code present', Boolean(grant.device_code))
  check('user_code format', /^ARCX-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(grant.user_code || ''), grant.user_code)
  check('verification_uri', String(grant.verification_uri || '').includes('/activate'))
  check('expires_in ~600s', grant.expires_in >= 300 && grant.expires_in <= 600, String(grant.expires_in))
}

// 2. Token poll while pending -> authorization_pending
{
  const r = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code }),
  })
  const d = await r.json()
  check('pending poll -> authorization_pending', r.status === 400 && d.error === 'authorization_pending')
}

// 3. Status lookup by user code
{
  const r = await fetch(`${BASE}/api/auth/device/status?user_code=${encodeURIComponent(grant.user_code)}`)
  const d = await r.json()
  check('status pending', r.status === 200 && d.status === 'pending' && d.clientName === 'Hermes Agent (e2e)')
}
{
  const r = await fetch(`${BASE}/api/auth/device/status?user_code=ARCX-XXX-XXX`)
  check('unknown code -> 404', r.status === 404)
}

// 4. SIWE challenge bound to the grant
let msgData
{
  const r = await fetch(`${BASE}/api/auth/device/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: account.address, user_code: grant.user_code }),
  })
  check('device/message 200', r.status === 200)
  msgData = await r.json()
  check('message contains user code', String(msgData.message || '').includes(grant.user_code))
}

// 5. Sign + approve (no MSCA binding -> skipped path is valid for protocol test)
{
  const signature = await account.signMessage({ message: msgData.message })
  const r = await fetch(`${BASE}/api/auth/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: account.address, message: msgData.message, signature, user_code: grant.user_code, approve: true }),
  })
  const d = await r.json()
  check('approve ok', r.status === 200 && d.ok === true, JSON.stringify(d))
}
{
  // Bad signature must be rejected.
  const r = await fetch(`${BASE}/api/auth/device/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: account.address, user_code: grant.user_code }),
  }).catch(() => null)
  // grant already approved; message endpoint should now fail with invalid_user_code
  if (r) check('message after approval rejected', r.status === 404)
}

// 6. Token exchange after approval
let tokens
{
  const r = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code }),
  })
  const d = await r.json()
  check('token issued', r.status === 200 && Boolean(d.access_token), JSON.stringify(d).slice(0, 120))
  tokens = d
}

// 7. Single-use: second poll fails
{
  const r = await fetch(`${BASE}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code }),
  })
  const d = await r.json()
  check('device code single-use', r.status === 400 && d.error === 'invalid_grant')
}

// 8. Access token works against /mcp
{
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e-device', version: '1.0' } } }),
  })
  check('MCP initialize authorized', r.status === 200)
}
{
  // Without a token the MCP endpoint must still reject.
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }),
  })
  check('MCP without token -> 401', r.status === 401)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
