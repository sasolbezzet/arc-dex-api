import { Router } from 'express'
import { listCredentials, addCredential, revealCredential, deleteCredential, getLimits, setLimits, listApprovals, createApproval, approveRequest, rejectRequest, listActivity } from '../services/vaultStore.mjs'

const vault = Router()

// ── Auth middleware: require wallet address + validate format ──
function requireOwner(req, res, next) {
  const owner = req.headers['x-wallet-address'] || req.query.address || req.body?.address
  if (!owner || typeof owner !== 'string') {
    return res.status(401).json({ error: 'Wallet address required (x-wallet-address header)' })
  }
  // Basic validation: must look like EVM address or Solana pubkey
  const clean = owner.toLowerCase().trim()
  if (!/^0x[a-f0-9]{40}$/.test(clean) && !/^[1-9a-hj-np-z]{32,44}$/.test(owner.trim())) {
    return res.status(400).json({ error: 'Invalid wallet address format' })
  }
  req.owner = clean
  next()
}

// ── Credentials ──
vault.get('/credentials', requireOwner, (req, res) => {
  res.json({ credentials: listCredentials(req.owner) })
})

vault.post('/credentials', requireOwner, (req, res) => {
  const { type, label, value } = req.body
  if (!type || !label || !value) return res.status(400).json({ error: 'type, label, value required' })
  const validTypes = ['eoa', 'circle', 'solana', 'api_key']
  if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` })
  const cred = addCredential(req.owner, { type, label, value })
  res.json({ credential: cred })
})

vault.post('/credentials/:id/reveal', requireOwner, (req, res) => {
  const cred = revealCredential(req.owner, req.params.id)
  if (!cred) return res.status(404).json({ error: 'Credential not found' })
  res.json({ credential: cred })
})

vault.delete('/credentials/:id', requireOwner, (req, res) => {
  const ok = deleteCredential(req.owner, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Credential not found' })
  res.json({ ok: true })
})

// ── Limits ──
vault.get('/limits', requireOwner, (req, res) => {
  res.json({ limits: getLimits(req.owner) })
})

vault.post('/limits', requireOwner, (req, res) => {
  const { maxPerTx, dailyLimit, autoApprove, whitelist } = req.body
  const limits = setLimits(req.owner, { maxPerTx, dailyLimit, autoApprove, whitelist })
  res.json({ limits })
})

// ── Approvals ──
vault.get('/approvals', requireOwner, (req, res) => {
  res.json({ approvals: listApprovals(req.owner) })
})

vault.post('/approvals', requireOwner, (req, res) => {
  const { agent, action, amount, token, source, to, details } = req.body
  if (!action || !amount) return res.status(400).json({ error: 'action, amount required' })
  const approval = createApproval(req.owner, { agent, action, amount, token, source, to, details })
  res.json({ approval })
})

vault.post('/approvals/:id/approve', requireOwner, (req, res) => {
  const a = approveRequest(req.owner, req.params.id)
  if (!a) return res.status(404).json({ error: 'Pending approval not found' })
  res.json({ approval: a })
})

vault.post('/approvals/:id/reject', requireOwner, (req, res) => {
  const a = rejectRequest(req.owner, req.params.id)
  if (!a) return res.status(404).json({ error: 'Pending approval not found' })
  res.json({ approval: a })
})

// ── Activity ──
vault.get('/activity', requireOwner, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  res.json({ activity: listActivity(req.owner, limit) })
})

export default vault
