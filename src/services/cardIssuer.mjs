// ARCOX Card Issuer adapter.
//
// A thin provider interface between the Card Simulator (authoritative local
// engine: limits, categories, txs, ledger) and a real card issuer for the
// actual PAN + network rails. Currently ships two drivers:
//
//   - lithic : Lithic v1 REST (sandbox/real) — best fit for agent spend
//   - stripe : Stripe Issuing (test mode via sk_test_...)
//
// CARD_PROVIDER=simulator (default) keeps the pure simulator. When
// CARD_PROVIDER=lithic|stripe and valid keys exist, provisioning routes card
// creation + state + events through the driver, while our simulator remains
// the source of truth for limits/categories and user-facing data.
//
// NOTE: no real key is required to run or test — drivers are exercised with
// stubbed fetch in the test suite, and the simulator stays the no-key
// default.

import { randomUUID } from 'crypto'

const LITHIC_BASE = 'https://sandbox.lithic.com/v1'
const STRIPE_BASE = 'https://api.stripe.com'

function providerFromEnv() {
  return String(process.env.CARD_PROVIDER || 'simulator').trim().toLowerCase()
}

function config() {
  return {
    provider: providerFromEnv(),
    lithicApiKey: String(process.env.LITHIC_API_KEY || '').trim(),
    lithicBin: String(process.env.LITHIC_BIN || '').trim(),
    stripeKey: String(process.env.STRIPE_SECRET_KEY || '').trim(),
    stripeFunding: String(process.env.STRIPE_FUNDING_ACCOUNT || '').trim(),
    stripeCardholder: String(process.env.STRIPE_CARDHOLDER_ID || '').trim(),
    webhookPath: '/api/cards/webhook',
    note: 'Adapter over Card Simulator. Provider only touched when CARD_PROVIDER!=simulator.',
  }
}


function maskPan(value) {
  return String(value || '').replace(/\d(?=\d{4})/g, '•')
}

async function requestJson(baseUrl, path, { method = 'GET', headers = {}, body, form = false } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.CARD_ISSUER_TIMEOUT_MS || 8_000))
  let payload
  let contentType = 'application/json'
  if (form && body !== undefined) {
    // Stripe's API only accepts application/x-www-form-urlencoded for writes.
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) params.append(k, v)
    }
    payload = params.toString()
    contentType = 'application/x-www-form-urlencoded'
  } else if (body !== undefined) {
    payload = JSON.stringify(body)
  }
  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': contentType, 'User-Agent': 'arcox-api/2.0', ...headers },
      ...(payload !== undefined ? { body: payload } : {}),
    })
    const text = await resp.text()
    let data = {}
    if (text) {
      try { data = JSON.parse(text) } catch {
        try { data = await resp.json() } catch { data = { raw: text } }
      }
    } else if (resp.ok) {
      try { data = await resp.json() } catch { data = {} }
    }
    if (!resp.ok) {
      const error = new Error(data?.error?.message || data?.message || `Issuer HTTP ${resp.status}`)
      error.status = resp.status
      error.data = data
      throw error
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}

// ── Lithic driver ────────────────────────────────────────────────────────────
// Sandbox semantics: api.financial_account is created implicitly; card issuing
// uses the Account (funding) token; velocity controls go on the card.
function lithicDriver({ apiKey, bin }) {
  const auth = { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}` }
  return {
    provider: 'lithic',
    async issueCard({ label = 'ARCOX Agent Card', spendLimit } = {}) {
      const account = await requestJson(LITHIC_BASE, '/accounts', {
        method: 'POST', headers: auth,
        body: { type: 'operating', name: 'ARCOX Agent Funding' },
      })
      const accountToken = account.token
      const body = { type: 'VIRTUAL', spend_limit_duration: 'TRANSACTION' }
      if (spendLimit) body.spend_limit = Math.round(Number(spendLimit) * 100) // cents
      if (bin) body.bin = bin // when the program's BINs are not auto
      const card = await requestJson(LITHIC_BASE, '/cards', { method: 'POST', headers: auth, body })
      return {
        providerCardId: card.token,
        pan: card.pan || maskPan(card.last_four),
        last4: card.last_four,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        cvv: card.cvc || null,
        status: 'active',
      }
    },
    async setControls(cardToken, { perTxLimit, dailyLimit, monthlyLimit, blockedCategories }) {
      const body = {
        spend_limit: perTxLimit ? Math.round(Number(perTxLimit) * 100) : undefined,
        spend_limit_duration: perTxLimit ? 'TRANSACTION' : undefined,
        merchant_category_codes: undefined,
      }
      return requestJson(LITHIC_BASE, `/cards/${cardToken}`, { method: 'PATCH', headers: auth, body })
    },
    async freeze(cardToken, frozen = true) {
      return requestJson(LITHIC_BASE, `/cards/${cardToken}`, { method: 'PATCH', headers: auth, body: { status: frozen ? 'PAUSED' : 'ACTIVE' } })
    },
    async getCard(cardToken) {
      return requestJson(LITHIC_BASE, `/cards/${cardToken}`, { headers: auth })
    },
    async topUp(amountUsdc) {
      // Lithic balance lives in a Linked/Fiat account; ARCOX funds through its
      // banking rail. Interface kept for parity.
      const cents = Math.round(Number(amountUsdc) * 100)
      return { ok: true, amountCents: cents, note: 'Provider funding configured separately' }
    },
    parseWebhook(payload) {
      // Lithic event type field: event.type in [card.created, auth.authorization_created, ...]
      const type = payload?.type || payload?.event?.type || ''
      const cardId = payload?.data?.card_token || payload?.card_token || payload?.data?.card?.token || ''
      const amountCents = Number(payload?.auth?.amount || payload?.data?.amount || 0)
      const merchant = payload?.auth?.merchant || payload?.merchant || {}
      return {
        eventType: type,
        cardId: cardId || null,
        amount: String((amountCents / 100).toFixed(6)),
        merchantName: merchant?.name || merchant?.legal_name || '',
        category: merchant?.category || '',
        status: type.includes('authorization') ? 'authorized'
          : type.includes('settled') ? 'settled'
          : type.includes('refund') ? 'refunded'
          : type.includes('decline') ? 'declined' : 'unknown',
      }
    },
  }
}

function stripeDriver(stripeKey) {
  const basic = `Basic ${Buffer.from(`${stripeKey}:`).toString('base64')}`
  // Stripe Issuing requires a cardholder when creating a card. In test mode we
  // create one automatically (dummy US billing) unless STRIPE_CARDHOLDER_ID is
  // already set in the dashboard.
  let cachedCardholderId = String(process.env.STRIPE_CARDHOLDER_ID || '').trim()
  async function ensureCardholder() {
    if (cachedCardholderId) return cachedCardholderId
    const ch = await requestJson(STRIPE_BASE, '/v1/issuing/cardholders', {
      method: 'POST', headers: { Authorization: basic }, form: true,
      body: {
        type: 'individual',
        name: 'ARCOX Agent',
        email: 'agent@arcox.test',
        'billing[address][line1]': '1 Market Street',
        'billing[address][city]': 'San Francisco',
        'billing[address][state]': 'CA',
        'billing[address][postal_code]': '94105',
        'billing[address][country]': 'US',
      },
    })
    cachedCardholderId = ch.id
    return ch.id
  }
  return {
    provider: 'stripe',
    async issueCard({ label = 'ARCOX Agent Card' } = {}) {
      const funding = config().stripeFunding
      const cardholder = await ensureCardholder()
      const body = [['type', 'virtual'], ['status', 'active'], ['cardholder', cardholder]]
      if (label) body.push(['metadata[arcox_label]', label])
      if (funding) body.push(['funding', funding])
      const card = await requestJson(STRIPE_BASE, '/v1/issuing/cards', {
        method: 'POST', headers: { Authorization: basic }, form: true, body: Object.fromEntries(body),
      })
      return {
        providerCardId: card.id,
        pan: card.number || '',
        last4: card.last4,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        cvv: card.cvc || null,
        status: 'active',
      }
    },
    async setCard(cardToken, { perTxLimit, dailyLimit }) {
      const body = {}
      if (perTxLimit) body.spending_controls = JSON.stringify({ monthly_limit: Math.round(Number(perTxLimit) * 100) })
      return requestJson(STRIPE_BASE, `/v1/issuing/cards/${cardToken}`, { method: 'POST', headers: { Authorization: basic }, form: true, body })
    },
    async freeze(cardToken, frozen = true) {
      const form = new URLSearchParams({ status: frozen ? 'paused' : 'active' })
      return requestJson(STRIPE_BASE, `/v1/issuing/cards/${cardToken}`, { method: 'POST', headers: { Authorization: basic }, form: true, body: Object.fromEntries(form) })
    },
    async getCard(cardToken) {
      return requestJson(STRIPE_BASE, `/v1/issuing/cards/${cardToken}`, { headers: { Authorization: basic } })
    },
    async getBalance() {
      const balances = await requestJson(STRIPE_BASE, '/v1/issuing/balance', { headers: { Authorization: basic } })
      const availableCents = balances?.available?.[0]?.amount || 0
      return { availableUsdc: String((availableCents / 100).toFixed(2)) }
    },
    async topUp(amountUsdc) {
      // Stripe Issuing top-ups use the funding account; exposed for parity.
      return { ok: true, amountUsd: Number(amountUsdc), note: 'Configure funding account in Stripe dashboard' }
    },
    parseWebhookEvent(payload) {
      const type = payload?.type || ''
      const obj = payload?.data?.object || {}
      let amount = obj?.total_amount ? Number(obj.total_amount) : 0
      if (obj?.amount) amount = Number(obj.amount)
      if (obj?.authorization?.amount) amount = Number(obj.authorization.amount)
      const merchant = obj?.merchant_data || {}
      return {
        eventType: type,
        cardId: obj?.card || obj?.card_id || '',
        amount: String((amount / 100).toFixed(2)),
        merchantId: merchant?.name || '',
        category: merchant?.category || '',
        status: type.includes('authorization') ? 'authorized'
          : type.includes('settled') ? 'settled'
          : type.includes('refund') ? 'refunded'
          : type.includes('decline') ? 'declined'
          : type.includes('created') ? 'created' : 'unknown',
      }
    },
  }
}

export function getIssuer() {
  const cfg = config()
  if (cfg.provider === 'lithic' && cfg.lithicApiKey) return lithicDriver(cfg.lithicApiKey, cfg.lithicBin)
  if (cfg.provider === 'stripe' && cfg.stripeKey) return stripeDriver(cfg.stripeKey)
  return {
    provider: 'simulator',
    async issueCard() {
      throw new Error('CARD_PROVIDER=simulator has no real issuer; set CARD_PROVIDER=lithic|stripe with keys to issue real test cards.')
    },
    async setCard() { throw new Error('simulator: set CARD_PROVIDER first') },
    async freeze() { throw new Error('simulator: set CARD_PROVIDER first') },
    async getCard() { throw new Error('simulator: set CARD_PROVIDER first') },
    async topUp() { throw new Error('simulator: set CARD_PROVIDER first') },
    parseWebhookEvent() { return null },
  }
}

export function cardIssuerConfig() {
  const cfg = config()
  const active = (cfg.provider !== 'simulator') && Boolean(cfg.lithicApiKey || cfg.stripeKey)
  return {
    provider: active ? cfg.provider : 'simulator',
    configured: active,
    lithicSandbox: Boolean(cfg.lithicApiKey),
    stripeTestMode: Boolean(cfg.stripeKey),
    simulator: !active,
    note: 'Real issuer active only when CARD_PROVIDER matches and keys are present.',
  }
}