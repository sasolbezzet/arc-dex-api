const DEFAULT_DESTINATION_CHAIN = 'arc-testnet'
const DEFAULT_TOKEN = 'USDC'
const ECO_QUOTES_API = process.env.ECO_QUOTES_API_URL || 'https://quotes.eco.com/api/v3/quotes/single'
const ECO_DAPP_ID = process.env.ECO_DAPP_ID || 'arcox-pay'

function liveRoutesEnabled() {
  return String(process.env.ECO_LIVE_ROUTES || 'false').toLowerCase() === 'true'
}

function normalizeInput(input = {}) {
  return {
    sourceChain: String(input.sourceChain || '').trim(),
    destinationChain: String(input.destinationChain || DEFAULT_DESTINATION_CHAIN).trim(),
    sourceToken: String(input.sourceToken || DEFAULT_TOKEN).trim().toUpperCase(),
    destinationToken: String(input.destinationToken || DEFAULT_TOKEN).trim().toUpperCase(),
    amount: String(input.amount || '').trim(),
    recipient: String(input.recipient || '').trim(),
    invoiceId: input.invoiceId ? String(input.invoiceId).trim() : undefined,
  }
}

export async function quoteEcoRoutePayment(input = {}) {
  const normalized = normalizeInput(input)
  const mockMode = !liveRoutesEnabled()
  const publicQuote = await maybeFetchPublicEcoQuote(normalized).catch((error) => ({
    unavailable: true,
    error: error.message,
  }))
  return {
    provider: 'eco',
    apiMode: 'public-no-auth',
    mockMode,
    ...normalized,
    routeId: publicQuote?.quoteResponse?.encodedRoute ? `eco_${Date.now().toString(36)}` : `eco_mock_${Date.now().toString(36)}`,
    estimatedFee: publicQuote?.quoteResponse?.fees?.[0]?.amount || (mockMode ? '0.00' : undefined),
    ecoQuote: publicQuote?.quoteResponse ? {
      intentExecutionType: publicQuote.quoteResponse.intentExecutionType,
      sourceChainID: publicQuote.quoteResponse.sourceChainID,
      destinationChainID: publicQuote.quoteResponse.destinationChainID,
      sourceAmount: publicQuote.quoteResponse.sourceAmount,
      destinationAmount: publicQuote.quoteResponse.destinationAmount,
      deadline: publicQuote.quoteResponse.deadline,
      estimatedFulfillTimeSec: publicQuote.quoteResponse.estimatedFulfillTimeSec,
      encodedRouteAvailable: Boolean(publicQuote.quoteResponse.encodedRoute),
      contracts: publicQuote.contracts,
    } : undefined,
    estimatedSteps: [
      'Get a public no-auth Eco V3 quote with dAppID attribution.',
      'User approves reward token to quote contracts.sourcePortal.',
      'User publishes and funds the intent with quoteResponse.encodedRoute.',
      'Track fulfillment through Eco intent status.',
      'ARCOX invoice status is updated after verified destination payment.',
    ],
    notes: mockMode
      ? [
          'Eco route preview is available without an API key.',
          publicQuote?.unavailable
            ? `No live Eco quote returned for this input: ${publicQuote.error}`
            : 'A live quote can be attempted when supported chain ids and token addresses are known.',
          'No value-moving execution is created in this adapter.',
          'Production routing must bind encodedRoute, invoiceId, amount, token, and recipient before accepting payment.',
        ]
      : [
          'Eco public quote mode is enabled without API keys.',
          'Execution still requires wallet approval and Portal publishAndFund; this adapter only previews.',
        ],
  }
}

async function maybeFetchPublicEcoQuote(input) {
  if (!liveRoutesEnabled()) return null
  const quoteRequest = toEcoQuoteRequest(input)
  if (!quoteRequest) return null
  const response = await fetch(ECO_QUOTES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dAppID: ECO_DAPP_ID, quoteRequest }),
    signal: AbortSignal.timeout(Number(process.env.ECO_QUOTE_TIMEOUT_MS || 8000)),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.message || data?.error || `Eco quote HTTP ${response.status}`)
  return data?.data || data
}

function toEcoQuoteRequest(input) {
  const sourceChainID = chainIdFor(input.sourceChain)
  const destinationChainID = chainIdFor(input.destinationChain)
  const sourceToken = tokenAddressFor(input.sourceChain, input.sourceToken)
  const destinationToken = tokenAddressFor(input.destinationChain, input.destinationToken)
  if (!sourceChainID || !destinationChainID || !sourceToken || !destinationToken || !input.recipient || !input.amount) return null
  return {
    sourceChainID,
    destinationChainID,
    sourceToken,
    destinationToken,
    sourceAmount: decimalToUnits(input.amount, 6),
    funder: input.recipient,
    recipient: input.recipient,
  }
}

function chainIdFor(chain) {
  const key = String(chain || '').toLowerCase().replace(/[_\s]+/g, '-')
  const ids = {
    base: 8453,
    'base-mainnet': 8453,
    optimism: 10,
    'op-mainnet': 10,
    arbitrum: 42161,
    ethereum: 1,
    polygon: 137,
    solana: 900,
  }
  return ids[key] || Number(chain) || 0
}

function tokenAddressFor(chain, token) {
  const tokenKey = String(token || '').toUpperCase()
  const chainKey = String(chain || '').toLowerCase().replace(/[_\s]+/g, '-')
  if (tokenKey !== 'USDC') return ''
  const usdc = {
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'base-mainnet': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    'op-mainnet': '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    polygon: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  }
  return usdc[chainKey] || ''
}

function decimalToUnits(value, decimals) {
  const raw = String(value || '')
  if (!/^\d+(\.\d+)?$/.test(raw)) return raw
  const [whole, frac = ''] = raw.split('.')
  return `${BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(frac.padEnd(decimals, '0').slice(0, decimals) || '0')}`
}

export async function createEcoPaymentAddress(input = {}) {
  const mockMode = !liveRoutesEnabled()
  return {
    provider: 'eco',
    mockMode,
    invoiceId: String(input.invoiceId || ''),
    merchantAddress: String(input.merchantAddress || ''),
    destinationChain: String(input.destinationChain || DEFAULT_DESTINATION_CHAIN),
    destinationToken: String(input.destinationToken || DEFAULT_TOKEN).toUpperCase(),
    paymentAddress: mockMode ? null : null,
    notes: mockMode
      ? ['Mock mode only. A production Eco payment address is not created.']
      : ['Production Eco payment-address creation is not wired yet.'],
  }
}

export async function checkEcoRouteStatus(input = {}) {
  return {
    provider: 'eco',
    mockMode: !liveRoutesEnabled(),
    routeId: input.routeId ? String(input.routeId) : undefined,
    invoiceId: input.invoiceId ? String(input.invoiceId) : undefined,
    status: 'mock_pending',
    notes: ['Eco status checking is a compatibility placeholder until production credentials and route IDs are wired.'],
  }
}
