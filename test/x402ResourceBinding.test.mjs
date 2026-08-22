import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MSCA = '0x2222222222222222222222222222222222222222'
const DELEGATE = '0x3333333333333333333333333333333333333333'

function makeRes() {
  const res = { statusCode: 200, body: null, headers: {} }
  res.status = code => { res.statusCode = code; return res }
  res.json = body => { res.body = body; return res }
  return res
}

test('x402 paid invoice unlocks when retry has different query params but same path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-x402-binding-'))
  const previousAuth = process.env.AUTH_SECRET
  const previousDb = process.env.X402_INVOICE_DB
  const previousSessionPath = process.env.SESSION_KEYS_PATH
  const previousEncryptionKey = process.env.SESSION_KEY_ENCRYPTION_KEY
  const previousSupabaseUrl = process.env.SUPABASE_URL
  const previousSupabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  process.env.AUTH_SECRET = 'test-auth-secret-' + Math.random()
  process.env.X402_INVOICE_DB = join(dir, 'invoices.json')
  process.env.SESSION_KEYS_PATH = join(dir, 'session-keys.json')
  process.env.SESSION_KEY_ENCRYPTION_KEY = 'test-only-session-encryption-key'
  // Force JSON-file persistence so a manually paid invoice stays authoritative
  // (the CI shell may expose Supabase env vars that would shadow it).
  process.env.SUPABASE_URL = ''
  process.env.SUPABASE_SERVICE_ROLE_KEY = ''
  await writeFile(process.env.SESSION_KEYS_PATH, JSON.stringify({
    users: {
      [MSCA.toLowerCase()]: {
        walletAddress: MSCA, delegateAddress: DELEGATE, active: true,
        authorizationUserOpHash: '0x' + 'a'.repeat(64),
      },
    },
  }), 'utf8')

  try {
    const { withArcoxX402, createX402Invoice, publicInvoice } = await import('../src/middleware/x402Middleware.mjs?binding-' + Date.now() + '-' + Math.random())
    const { mintOwnerToken } = await import('../src/services/authToken.mjs')

    // Create and pay an invoice whose resource includes a query string
    const invoice = createX402Invoice({
      ownerWallet: MSCA,
      resource: '/api/intel/address/0x123/counterparties?limit=5',
      amount: '0.02',
    })
    invoice.status = 'paid'
    invoice.txHash = '0x' + 'a'.repeat(64)
    invoice.paidAt = new Date().toISOString()

    let handlerCalled = false
    // No config.resource on purpose: production routes let the middleware bind
    // the resource from req.originalUrl so each path is validated separately.
    const wrapped = withArcoxX402((req, res) => {
      handlerCalled = true
      res.json({ ok: true, unlocked: true, invoiceId: req.arcoxX402?.invoice?.invoiceId })
    }, { service: 'arcox_intel', priceEnv: 'ARCOX_INTEL_PRICE_COUNTERPARTIES', amount: '0.02' })

    const bearer = `Bearer ${mintOwnerToken(MSCA)}`

    // Retry with a DIFFERENT query (limit=10) but the same path → should unlock
    const resA = makeRes()
    await wrapped({
      originalUrl: '/api/intel/address/0x123/counterparties?limit=10',
      path: '/api/intel/address/0x123/counterparties',
      query: { limit: '10' },
      headers: { 'x-arcox-owner': MSCA, 'x-payment-id': invoice.paymentId, authorization: bearer },
    }, resA)
    assert.equal(resA.statusCode, 200, `same-path retry should unlock, got ${resA.statusCode} ${JSON.stringify(resA.body)}`)
    assert.equal(handlerCalled, true)
    assert.equal(resA.body.unlocked, true)
    assert.equal(resA.body.invoiceId, invoice.invoiceId)

    // Retry with a DIFFERENT path → must create a new invoice (402)
    handlerCalled = false
    const resB = makeRes()
    await wrapped({
      originalUrl: '/api/intel/risk/address/0x123',
      path: '/api/intel/risk/address/0x123',
      query: {},
      headers: { 'x-arcox-owner': MSCA, 'x-payment-id': invoice.paymentId, authorization: bearer },
    }, resB)
    assert.equal(resB.statusCode, 402, 'different path must require a new payment')
    assert.match(resB.body.error, /mismatch|expired|Payment/i)
    assert.ok(resB.body.x402, 'new invoice returned')
    assert.notEqual(publicInvoice(resB.body.x402).invoiceId, invoice.invoiceId)
  } finally {
    if (previousAuth === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousAuth
    if (previousDb === undefined) delete process.env.X402_INVOICE_DB
    else process.env.X402_INVOICE_DB = previousDb
    if (previousSessionPath === undefined) delete process.env.SESSION_KEYS_PATH
    else process.env.SESSION_KEYS_PATH = previousSessionPath
    if (previousEncryptionKey === undefined) delete process.env.SESSION_KEY_ENCRYPTION_KEY
    else process.env.SESSION_KEY_ENCRYPTION_KEY = previousEncryptionKey
    if (previousSupabaseUrl === undefined) delete process.env.SUPABASE_URL
    else process.env.SUPABASE_URL = previousSupabaseUrl
    if (previousSupabaseKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousSupabaseKey
    await rm(dir, { recursive: true, force: true })
  }
})
