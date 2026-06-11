import { existsSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID, createHash } from 'crypto'

const PROOF_DB = './x402-proof-db.json'

function loadProofs() {
  try {
    if (!existsSync(PROOF_DB)) return {}
    const db = JSON.parse(readFileSync(PROOF_DB, 'utf8'))
    return db && typeof db === 'object' ? db : {}
  } catch {
    return {}
  }
}

function saveProofs(db) {
  writeFileSync(PROOF_DB, JSON.stringify(db, null, 2))
}

function proofId(proof) {
  return createHash('sha256').update(JSON.stringify(proof)).digest('hex')
}

function readProof(req) {
  const raw = req.headers['x-arcox-payment-proof'] || req.body?.paymentProof
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

function enabledFromEnv(config) {
  if (typeof config.enabled === 'boolean') return config.enabled
  return String(process.env.X402_ENABLED || 'false').toLowerCase() === 'true'
}

export function withX402PaymentRequired(handler, config = {}) {
  return async (req, res, next) => {
    const enabled = enabledFromEnv(config)
    if (!enabled) return handler(req, res, next)

    const resource = config.resource || req.originalUrl || req.path
    const requirement = {
      amount: String(config.price || '0.01'),
      token: String(config.token || process.env.X402_DEFAULT_TOKEN || 'USDC'),
      network: String(config.network || process.env.X402_DEFAULT_NETWORK || 'arc-testnet'),
      recipient: String(config.recipient || process.env.X402_FEE_WALLET || ''),
      resource,
      requestId: req.headers['x-arcox-payment-request-id'] || randomUUID(),
    }

    if (!requirement.recipient) {
      return res.status(500).json({ error: 'x402 fee wallet is not configured' })
    }

    const proof = readProof(req)
    if (!proof) {
      return res.status(402).json({
        error: 'Payment required',
        x402: requirement,
      })
    }

    const expected = {
      requestId: requirement.requestId,
      amount: requirement.amount,
      token: requirement.token,
      network: requirement.network,
      recipient: requirement.recipient,
      resource: requirement.resource,
    }
    for (const [key, value] of Object.entries(expected)) {
      if (String(proof[key] || '') !== String(value)) {
        return res.status(402).json({ error: `Invalid x402 proof ${key}`, x402: requirement })
      }
    }
    if (!proof.proof && !proof.signature && !proof.txHash) {
      return res.status(402).json({ error: 'Invalid x402 proof', x402: requirement })
    }

    const id = proofId(proof)
    const db = loadProofs()
    if (db[id] || db[String(proof.requestId)]) {
      return res.status(402).json({ error: 'x402 proof already used', x402: requirement })
    }
    db[id] = { ...expected, usedAt: new Date().toISOString() }
    db[String(proof.requestId)] = { proofId: id, usedAt: new Date().toISOString() }
    saveProofs(db)
    return handler(req, res, next)
  }
}
