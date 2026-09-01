import { Router } from 'express'
import { listCredentials, addCredential, deduplicateCredentials, revealCredential, deleteCredential, getLimits, setLimits, listApprovals, createApproval, approveRequest, rejectRequest, listActivity, listAgentCardLinks, upsertAgentCardLink, removeAgentCardLink, createChallenge, consumeChallenge, createSession, validateSession, listMcpSessions } from '../services/vaultStore.mjs'
import { readAgentActivity, readAgentApprovals } from '../services/supabasePersistence.mjs'
import { listRelatedAddresses, listAgentBindings, listAgentBindingsForIdentity, identityOwnsAgentBinding, resolveOwnerAddressForWallet, revokeAgentBinding, getAgentBinding, agentClientId as agentClientIdFromBinding } from '../services/sessionKeyService.mjs'
import { getDailySpend } from '../services/agentSpendLedger.mjs'
import { verifyMessage } from 'viem'
import { verifyOwnerToken } from '../services/authToken.mjs'

const vault = Router()

// ── Auth middleware: require SIWE session token ──
// Flow: POST /api/vault/challenge → sign with MetaMask → POST /api/vault/verify → get session token
// All subsequent requests: Authorization: Bearer <sessionToken>
async function requireAuth(req, res, next) {
  const auth = req.headers['authorization']
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', hint: 'POST /api/vault/challenge to start SIWE login' })
  }
  const token = auth.slice(7)
  const userId = validateSession(token) || verifyOwnerToken(token)
  if (!userId) {
    // OAuth/MCP bearer tokens authenticate an agent, not the vault owner. Keep
    // the distinction explicit so owner-only management endpoints do not look
    // like an expired login to a connected agent (and remain easy to audit).
    try {
      const { validateAccessToken } = await import('../services/mcpServer.mjs')
      if (validateAccessToken(token)) return res.status(403).json({ error: 'owner_authentication_required', message: 'Agent token cannot manage owner vault settings' })
    } catch { /* invalid/non-OAuth tokens remain a normal 401 */ }
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
vault.get('/sessions', requireAuth, async (req, res) => {
  // Session presence is observability data, not an ownership grant. Read only
  // the authenticated owner's namespace; traversing aliases here could expose
  // a foreign owner's Claude/GPT connection after a stale rebind.
  const sessions = listMcpSessions(req.owner)
  res.json({ sessions: [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)) })
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

vault.post('/credentials/deduplicate', requireAuth, (req, res) => {
  res.json(deduplicateCredentials(req.owner))
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
vault.get('/approvals', requireAuth, async (req, res) => {
  const localApprovals = listApprovals(req.owner)
  const read = await readAgentApprovals(req.owner, localApprovals)
  res.json({ approvals: read.approvals, persistenceSource: read.source })
})

vault.post('/approvals', requireAuth, (req, res) => {
  const { action, amount, token, source, to, details } = req.body
  if (!action || !amount) return res.status(400).json({ error: 'action, amount required' })
  // This HTTP route is the vault UI/API boundary, not the authenticated MCP
  // context. Never trust a caller-supplied `agent` label here; MCP tools pass
  // their verified OAuth client context directly to createMcpServer.
  const approval = createApproval(req.owner, { agent: 'vault-ui', action, amount, token, source, to, details })
  res.json({ approval })
})

vault.post('/approvals/:id/approve', requireAuth, (req, res) => {
  const { txHash, explorerUrl } = req.body || {}
  const a = approveRequest(req.owner, req.params.id, { txHash, explorerUrl })
  if (!a) return res.status(404).json({ error: 'Pending approval not found' })
  res.json({ success: true, approval: a })
})

vault.post('/approvals/:id/reject', requireAuth, (req, res) => {
  const a = rejectRequest(req.owner, req.params.id)
  if (!a) return res.status(404).json({ error: 'Pending approval not found' })
  res.json({ success: true, approval: a })
})

// ── Activity ──
vault.get('/activity', requireAuth, async (req, res) => {
  // The Plugin intentionally exposes only the five newest Agent Activity
  // entries. Keep the cap server-side so clients cannot accidentally request
  // the entire financial/audit stream into the browser.
  const limit = Math.min(Number(req.query.limit) || 5, 5)
  const relatedOwners = listRelatedAddresses(req.owner)
  const localActivity = relatedOwners
    .flatMap(owner => listActivity(owner, limit))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, limit)
  const read = await readAgentActivity(relatedOwners, localActivity, limit)
  res.json({ activity: read.activity, persistenceSource: read.source, ownerScope: 'eoa-and-linked-msca' })
})

// ── Per-agent management (Fase 4) ──
// GET /api/vault/agents — every agent binding owned by this passkey session,
// enriched with the OAuth client name (agent display name) and daily spend.
async function resolveClientName(clientId) {
  if (!clientId) return ''
  try {
    const { resolveAgentName } = await import('../services/mcpServer.mjs')
    return resolveAgentName(clientId)
  } catch {
    return ''
  }
}

vault.get('/agents', requireAuth, async (req, res) => {
  try {
    // Scope by the authenticated identity only. EOA sessions see rows owned by
    // that EOA; an MSCA passkey session sees rows for that exact MSCA. Do not
    // traverse walletFamily/reverse aliases here: those are historical display
    // metadata and must never grant visibility into another owner's agents.
    const bindings = listAgentBindingsForIdentity(req.owner)
    const agents = []
    for (const binding of bindings) {
      agents.push({
        agentKey: binding.agentKey,
        walletAddress: binding.walletAddress,
        boundAt: binding.boundAt,
        lastUsedAt: binding.lastUsedAt,
        spentToday: getDailySpend(binding.agentKey),
        clientName: await resolveClientName(binding.agentKey.split('|')[0] || ''),
      })
    }
    agents.sort((a, b) => Number(a.boundAt || 0) - Number(b.boundAt || 0))
    res.json({ agents })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to list agents' })
  }
})

function activityBelongsToAgent(entry, binding, clientId) {
  const entryOwner = String(entry?.owner || '').toLowerCase()
  const data = entry?.data && typeof entry.data === 'object' ? entry.data : {}
  const dataAgentKey = String(data.agentKey || '').trim().toLowerCase()
  const expectedAgentKey = `${clientId}|${String(binding.ownerAddress || '').toLowerCase()}`
  // Wallet-level activity is not automatically visible to every agent sharing
  // that MSCA. Agent-scoped events must carry the exact composite key; this
  // prevents one agent from reading another agent's card/payment history.
  return (entryOwner === String(binding.walletAddress || '').toLowerCase()
      && dataAgentKey === expectedAgentKey)
    || (entryOwner === String(binding.ownerAddress || '').toLowerCase()
      && (String(data.agentClientId || '').toLowerCase() === clientId || Boolean(dataAgentKey && dataAgentKey === expectedAgentKey)))
}

// GET /api/vault/agents/:agentKey/activity — recent activity for exactly one
// agent. EOA-level events are included only when their audit payload carries
// this OAuth clientId; MSCA-level events are scoped to the binding's wallet.
vault.get('/agents/:agentKey/activity', requireAuth, async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '')
    const binding = getAgentBinding(agentKey)
    if (!binding) return res.status(404).json({ error: 'agent_not_found' })
    if (!identityOwnsAgentBinding(req.owner, binding)) {
      return res.status(403).json({ error: 'forbidden', message: 'Agent milik owner lain' })
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 5)
    const clientId = agentClientIdFromBinding(agentKey)
    const local = [
      ...listActivity(binding.ownerAddress, 100),
      ...listActivity(binding.walletAddress, 100),
    ].filter(entry => activityBelongsToAgent(entry, binding, clientId))
    const [ownerRead, walletRead] = await Promise.all([
      readAgentActivity(binding.ownerAddress, local.filter(entry => String(entry.owner).toLowerCase() === String(binding.ownerAddress).toLowerCase()), limit),
      readAgentActivity(binding.walletAddress, local.filter(entry => String(entry.owner).toLowerCase() === String(binding.walletAddress).toLowerCase()), limit),
    ])
    const byId = new Map([...ownerRead.activity, ...walletRead.activity]
      .filter(entry => activityBelongsToAgent(entry, binding, clientId))
      .map(entry => [String(entry.id), entry]))
    const activity = [...byId.values()]
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
      .slice(0, limit)
      .map(entry => ({
        id: entry.id,
        at: entry.ts,
        type: entry.type,
        amount: entry.data?.amount,
        detail: entry.data?.action || entry.data?.merchantName || entry.data?.label || entry.data?.status || '',
        data: entry.data || {},
      }))
    res.json({ activity, persistenceSource: ownerRead.source === 'json' && walletRead.source === 'json' ? 'json' : 'supabase-merged' })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to read agent activity' })
  }
})

async function cardsForWallet(walletAddress) {
  const { listCards } = await import('../services/cardSimulator.mjs')
  return listCards(walletAddress).map(card => ({
    cardId: card.cardId,
    label: card.label,
    last4: card.last4,
    maxPerTx: card.limits?.perTx || '',
    daily: card.limits?.daily || '',
  }))
}

// GET /api/vault/cards — masked owner cards available for manual agent linking.
vault.get('/cards', requireAuth, async (req, res) => {
  try {
    const bindings = listAgentBindingsForIdentity(req.owner)
    const cards = []
    const seen = new Set()
    for (const binding of bindings) {
      for (const card of await cardsForWallet(binding.walletAddress)) {
        if (!seen.has(card.cardId)) {
          seen.add(card.cardId)
          cards.push(card)
        }
      }
    }
    res.json({ cards })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to list owner cards' })
  }
})

// GET /api/vault/agents/:agentKey/cards — linked cards expose only masked
// metadata. PAN/CVV stay behind the existing fresh-passkey card route.
vault.get('/agents/:agentKey/cards', requireAuth, async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '')
    const binding = getAgentBinding(agentKey)
    if (!binding) return res.status(404).json({ error: 'agent_not_found' })
    if (!identityOwnsAgentBinding(req.owner, binding)) return res.status(403).json({ error: 'forbidden', message: 'Agent milik owner lain' })
    const { getCard } = await import('../services/cardSimulator.mjs')
    const linked = listAgentCardLinks(agentKey)
    const cards = linked.map(link => {
      const card = getCard(binding.walletAddress, link.cardId)
      if (!card) return null
      return { cardId: card.cardId, label: card.label, last4: card.last4, maxPerTx: link.maxPerTx, daily: link.daily, linkedAt: link.linkedAt }
    }).filter(Boolean)
    res.json({ cards })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to list agent cards' })
  }
})

// POST /api/vault/agents/:agentKey/cards — owner explicitly links one of the
// binding MSCA's cards to this agent and sets optional agent-specific caps.
vault.post('/agents/:agentKey/cards', requireAuth, async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '')
    const binding = getAgentBinding(agentKey)
    if (!binding) return res.status(404).json({ error: 'agent_not_found' })
    if (!identityOwnsAgentBinding(req.owner, binding)) return res.status(403).json({ error: 'forbidden', message: 'Agent milik owner lain' })
    const cardId = String(req.body?.cardId || '').trim()
    const { getCard } = await import('../services/cardSimulator.mjs')
    const card = getCard(binding.walletAddress, cardId)
    if (!card) return res.status(404).json({ error: 'card_not_found' })
    const link = upsertAgentCardLink(agentKey, {
      cardId,
      maxPerTx: req.body?.maxPerTx ?? card.limits?.perTx,
      daily: req.body?.daily ?? card.limits?.daily,
    })
    res.json({ ok: true, card: { cardId: card.cardId, label: card.label, last4: card.last4, ...link } })
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Failed to link card' })
  }
})

// DELETE /api/vault/cards/:cardId/agent-link — remove this card from every
// agent link owned by the authenticated identity, without touching the card.
vault.delete('/cards/:cardId/agent-link', requireAuth, async (req, res) => {
  try {
    const cardId = String(req.params.cardId || '').trim()
    const bindings = listAgentBindingsForIdentity(req.owner)
    const { getCard } = await import('../services/cardSimulator.mjs')
    let removed = 0
    for (const binding of bindings) {
      if (!getCard(binding.walletAddress, cardId)) continue
      if (removeAgentCardLink(binding.agentKey, cardId)) removed++
    }
    res.json({ ok: true, removed })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to unlink card' })
  }
})

// POST /api/vault/agents/bootstrap-connection-token — create the first
// connection-token agent directly from an active owner/passkey session. This is
// the entry point for Hermes default mode, before an OAuth/device binding exists.
vault.post('/agents/bootstrap-connection-token', requireAuth, async (req, res) => {
  try {
    const { getSessionKeyInfo } = await import('../services/vaultStore.mjs')
    // Hermes must be explicitly bound to the wallet created for Hermes. The
    // walletAddress is REQUIRED: falling back to the owner's active session
    // would silently reuse Claude's wallet and violate the one-agent/one-wallet
    // invariant (agent_wallet_mismatch only fires when walletAddress is sent).
    const requestedWallet = String(req.body?.walletAddress || '').trim().toLowerCase()
    if (!requestedWallet) {
      return res.status(400).json({ error: 'wallet_address_required', message: 'Pilih wallet Agent Hermes secara eksplisit sebelum membuat token koneksi.' })
    }
    const session = await getSessionKeyInfo(requestedWallet)
    if (!session?.active || !session.walletAddress) {
      return res.status(409).json({ error: 'agent_wallet_session_required', message: 'Aktifkan Agent Wallet Hermes terlebih dahulu.' })
    }
    if (requestedWallet && String(session.walletAddress).toLowerCase() !== requestedWallet) {
      return res.status(409).json({ error: 'agent_wallet_mismatch', message: 'Wallet Hermes tidak cocok dengan session Passkey.' })
    }
    const { issueBootstrapConnectionToken } = await import('../services/mcpServer.mjs')
    const ttlDays = Math.min(Math.max(Number(req.body?.ttlDays) || 90, 1), 3650)
    const clientName = String(req.body?.clientName || 'Hermes Agent').trim().slice(0, 64) || 'Hermes Agent'
    const ownerAddress = resolveOwnerAddressForWallet(req.owner, session.walletAddress)
    if (!ownerAddress) {
      return res.status(409).json({ error: 'owner_identity_required', message: 'Identitas owner EOA belum terhubung ke Agent Wallet.' })
    }
    const issued = issueBootstrapConnectionToken({
      clientName,
      userId: ownerAddress,
      mscaWalletAddress: session.walletAddress,
      ttlDays,
    })
    res.json({
      token: issued.token,
      agentKey: issued.agentKey,
      agentName: clientName,
      walletAddress: session.walletAddress,
      expiresAt: issued.expiresAt,
      mcpUrl: `${process.env.ARCOX_PAY_BASE_URL || 'https://arcoxdex.vercel.app'}/mcp`,
      message: 'Hubungkan ARCOX ke agent ini. Token ditampilkan sekali; simpan sebelum menutup modal.',
    })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to bootstrap connection token' })
  }
})

// POST /api/vault/agents/:agentKey/connection-token — issue a long-lived MCP
// bearer token bound to this agent's MSCA (Fase 4B). Owner-only; the token
// works immediately at /mcp without any device-flow pairing.
vault.post('/agents/:agentKey/connection-token', requireAuth, async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '')
    const binding = getAgentBinding(agentKey)
    if (!binding) return res.status(404).json({ error: 'agent_not_found' })
    if (!identityOwnsAgentBinding(req.owner, binding)) {
      return res.status(403).json({ error: 'forbidden', message: 'Agent milik owner lain' })
    }
    const ttlDays = Math.min(Math.max(Number(req.body?.ttlDays) || 90, 1), 3650)
    const { issueConnectionToken } = await import('../services/mcpServer.mjs')
    const issued = issueConnectionToken({
      agentKey,
      clientName: await resolveClientName(agentKey.split('|')[0] || ''),
      userId: binding.ownerAddress,
      mscaWalletAddress: binding.walletAddress,
      ttlDays,
    })
    res.json({
      token: issued.token,
      agentName: (await resolveClientName(agentKey.split('|')[0] || '')) || 'MCP Agent',
      walletAddress: binding.walletAddress,
      expiresAt: issued.expiresAt,
      mcpUrl: `${process.env.ARCOX_PAY_BASE_URL || 'https://arcoxdex.vercel.app'}/mcp`,
      message: 'Hubungkan ARCOX ke agent ini. Token ditampilkan sekali; simpan sebelum menutup modal.',
    })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to issue connection token' })
  }
})

// DELETE /api/vault/agents/:agentKey — revoke exactly one agent binding and
// kill every OAuth token (access + refresh) issued under that clientId so the
// agent is truly offline. Owner-only.
vault.delete('/agents/:agentKey', requireAuth, async (req, res) => {
  try {
    const agentKey = String(req.params.agentKey || '')
    const binding = getAgentBinding(agentKey)
    if (!binding) return res.status(404).json({ error: 'agent_not_found' })
    if (!identityOwnsAgentBinding(req.owner, binding)) {
      return res.status(403).json({ error: 'forbidden', message: 'Agent milik owner lain' })
    }
    const action = String(req.body?.action || 'revoke').toLowerCase()
    if (action === 'delete') {
      const { deleteAgentBinding } = await import('../src/services/sessionKeyService.mjs')
      deleteAgentBinding(agentKey)
    } else {
      revokeAgentBinding(agentKey)
    }
    const removed = action === 'delete'
    // Kill the OAuth tokens for this clientId (access + refresh), including
    // legacy `oauth:<clientId>` keys.
    const clientId = agentClientIdFromBinding(agentKey)
    try {
      const { revokeTokensForClient } = await import('../services/mcpServer.mjs')
      revokeTokensForClient(clientId)
    } catch (error) {
      console.warn('[vault] token revoke best-effort failed:', error?.message || error)
    }
    res.json({ ok: true, removed, revoked: removed, agentKey })
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to revoke agent' })
  }
})

export default vault
