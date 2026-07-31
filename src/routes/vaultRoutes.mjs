import { Router } from 'express'
import { listCredentials, addCredential, revealCredential, deleteCredential, getLimits, setLimits, listApprovals, createApproval, approveRequest, rejectRequest, listActivity, createChallenge, consumeChallenge, createSession, validateSession, listMcpSessions } from '../services/vaultStore.mjs'
import { verifyMessage } from 'viem'

const vault = Router()

// ── Auth middleware: require SIWE session token ──
// Flow: POST /api/vault/challenge → sign with MetaMask → POST /api/vault/verify → get session token
// All subsequent requests: Authorization: Bearer <sessionToken>
function requireAuth(req, res, next) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', hint: 'POST /api/vault/challenge to start SIWE login' })
  }
  const token = auth.slice(7)
  const userId = validateSession(token)
  if (!userId) {
    return res.status(401).json({ error: 'Session expired or invalid', hint: 'Re-authenticate via /api/vault/challenge' })
  }
  req.owner = userId
  next()
}

// ── SIWE Challenge ──
vault.post('/challenge', (req, res) => {
  const { address } = req.body
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: 'Valid EVM wallet address required' })
  }
  const { nonce, message } = createChallenge(address)
  res.json({ nonce, message })
})

// ── SIWE Verify ──
vault.post('/verify', async (req, res) => {
  const { address, message, signature } = req.body
  if (!address || !message || !signature) {
    return res.status(400).json({ error: 'address, message, signature required' })
  }
  // Extract nonce from message
  const nonceMatch = message.match(/Nonce: (\w+)/)
  if (!nonceMatch) return res.status(400).json({ error: 'Invalid SIWE message' })
  const challenge = consumeChallenge(nonceMatch[1])
  if (!challenge) return res.status(401).json({ error: 'Challenge expired or not found' })
  if (challenge.address !== address.toLowerCase()) {
    return res.status(401).json({ error: 'Address mismatch' })
  }
  try {
    const valid = await verifyMessage({ address, message, signature })
    if (!valid) return res.status(401).json({ error: 'Invalid signature' })
  } catch {
    return res.status(401).json({ error: 'Signature verification failed' })
  }
  const userId = address.toLowerCase()
  const token = createSession(userId)
  res.json({ token, userId, expiresIn: 86400 })
})

// ── MCP sessions (connection status) ──
vault.get('/sessions', requireAuth, (req, res) => {
  res.json({ sessions: listMcpSessions(req.owner) })
})

// ── Credentials ──
vault.get('/credentials', requireAuth, (req, res) => {
  res.json({ credentials: listCredentials(req.owner) })
})

vault.post('/credentials', requireAuth, (req, res) => {
  const { type, label, value } = req.body
  if (!type || !label || !value) return res.status(400).json({ error: 'type, label, value required' })
  const validTypes = ['eoa', 'circle', 'solana', 'api_key']
  if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` })
  const cred = addCredential(req.owner, { type, label, value })
  res.json({ credential: cred })
})

vault.post('/credentials/:id/reveal', requireAuth, (req, res) => {
  const cred = revealCredential(req.owner, req.params.id)
  if (!cred) return res.status(404).json({ error: 'Credential not found' })
  res.json({ credential: cred })
})

vault.delete('/credentials/:id', requireAuth, (req, res) => {
  const ok = deleteCredential(req.owner, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Credential not found' })
  res.json({ ok: true })
})

// ── Limits ──
vault.get('/limits', requireAuth, (req, res) => {
  res.json({ limits: getLimits(req.owner) })
})

vault.post('/limits', requireAuth, (req, res) => {
  const { maxPerTx, dailyLimit, autoApprove, whitelist } = req.body
  const limits = setLimits(req.owner, { maxPerTx, dailyLimit, autoApprove, whitelist })
  res.json({ limits })
})

// ── Approvals ──
vault.get('/approvals', requireAuth, (req, res) => {
  res.json({ approvals: listApprovals(req.owner) })
})

vault.post('/approvals', requireAuth, (req, res) => {
  const { agent, action, amount, token, source, to, details } = req.body
  if (!action || !amount) return res.status(400).json({ error: 'action, amount required' })
  const approval = createApproval(req.owner, { agent, action, amount, token, source, to, details })
  res.json({ approval })
})

vault.post('/approvals/:id/approve', requireAuth, (req, res) => {
  const { txHash, explorerUrl } = req.body || {}
  const a = approveRequest(req.owner, req.params.id, { txHash, explorerUrl })
  if (!a) return res.status(404).json({ error: 'Pending approval not found' })
  res.json({ approval: a })
})

vault.post('/approvals/:id/reject', requireAuth, (req, res) => {
  const a = rejectRequest(req.owner, req.params.id)
  if (!a) return res.status(404).json({ error: 'Pending approval not found' })
  res.json({ approval: a })
})

// ── Activity ──
vault.get('/activity', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  res.json({ activity: listActivity(req.owner, limit) })
})

export default vault
