import { randomUUID, createHash } from 'crypto'

const usedProofs = globalThis.__arcoxX402UsedProofs || new Set()
globalThis.__arcoxX402UsedProofs = usedProofs

export function priceFromEnv(name, fallback) {
  return String(process.env[name] || fallback)
}

export function makeX402Requirement(req, config = {}) {
  const paymentId = `x402_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  return {
    service: config.service || 'arcox_intel',
    amount: String(config.amount || process.env.X402_DEFAULT_PRICE_USDC || '0.01'),
    asset: String(config.asset || process.env.X402_ASSET || 'USDC'),
    network: String(config.network || process.env.X402_NETWORK || 'arc-testnet'),
    recipient: String(config.recipient || process.env.X402_RECIPIENT_ADDRESS || ''),
    resource: String(config.resource || req.originalUrl || req.path),
    expiresInSeconds: Number(config.expiresInSeconds || process.env.X402_PAYMENT_EXPIRY_SECONDS || 300),
    paymentId,
  }
}

export function withArcoxX402(handler, config = {}) {
  return async (req, res, next) => {
    if (String(process.env.ARCOX_INTEL_ENABLED || 'true').toLowerCase() === 'false') {
      return res.status(503).json({ error: 'ARCOX Intel is disabled' })
    }

    const enabled = String(process.env.X402_ENABLED || 'true').toLowerCase() === 'true'
    if (!enabled) return handler(req, res, next)

    const requirement = makeX402Requirement(req, config)
    if (!requirement.recipient) {
      requirement.recipient = 'configure_X402_RECIPIENT_ADDRESS'
    }

    const proof = readProof(req)
    const verifyPayment = String(process.env.X402_VERIFY_PAYMENT || 'false').toLowerCase() === 'true'
    const mockPaid = String(req.headers['x-payment'] || '').toLowerCase() === 'mock-paid'

    if (!proof && !(mockPaid && !verifyPayment)) {
      return res.status(402).json({ error: 'Payment Required', x402: requirement })
    }

    if (mockPaid && !verifyPayment) {
      req.arcoxX402 = { mode: 'mock-paid', requirement }
      return handler(req, res, next)
    }

    const validation = validateProof(proof, requirement)
    if (!validation.ok) return res.status(402).json({ error: validation.error, x402: requirement })
    const id = createHash('sha256').update(JSON.stringify(proof)).digest('hex')
    if (usedProofs.has(id) || usedProofs.has(String(proof.paymentId || proof.nonce || ''))) {
      return res.status(402).json({ error: 'x402 proof already used', x402: requirement })
    }
    usedProofs.add(id)
    usedProofs.add(String(proof.paymentId || proof.nonce || id))
    req.arcoxX402 = { mode: 'proof', requirement }
    return handler(req, res, next)
  }
}

function readProof(req) {
  const raw = req.headers['x-arcox-payment-proof'] || req.headers['x-payment-proof'] || req.body?.paymentProof
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

function validateProof(proof, requirement) {
  if (!proof || typeof proof !== 'object') return { ok: false, error: 'Missing x402 proof' }
  const required = {
    resource: requirement.resource,
    amount: requirement.amount,
    recipient: requirement.recipient,
    network: requirement.network,
  }
  for (const [key, value] of Object.entries(required)) {
    if (String(proof[key] || '') !== String(value)) return { ok: false, error: `Invalid x402 proof ${key}` }
  }
  if (!proof.paymentId && !proof.nonce) return { ok: false, error: 'Invalid x402 proof paymentId' }
  if (!proof.signature && !proof.txHash && !proof.proof) return { ok: false, error: 'Invalid x402 proof signature' }
  return { ok: true }
}
