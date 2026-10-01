// Machine-readable OpenAPI 3.0 spec for the ARCOX x402 monetization surface.
// Served at GET /api/x402/openapi.json. Built at call time so prices and
// limits in the spec reflect the current environment configuration.
import { getIntelCatalog } from './intelCatalog.mjs'
import { priceFromEnv, x402Config } from '../middleware/x402Middleware.mjs'

export function x402OpenApiSpec() {
  const cfg = x402Config()
  const catalog = getIntelCatalog()
  return {
    openapi: '3.0.3',
    info: {
      title: 'ARCOX x402 API',
      version: '2.1.0',
      description: 'Pay-per-request read-only access to Arkham intelligence. Every paid resource returns an x402 invoice (HTTP 402) until paid; retry with the paymentId to unlock the data. All Intel resources are read-only — no transaction execution.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'x402', description: 'Invoice lifecycle, payment requests, refunds, stats' },
      { name: 'intel', description: 'Read-only Arkham intelligence resources (x402-paid)' },
      { name: 'marketplace', description: 'Mirror of the Circle x402 discovery directory: free catalog/quote, fee-quoted resale' },
    ],
    paths: {
      '/api/x402/config': {
        get: {
          tags: ['x402'], summary: 'Public x402 configuration', description: 'Network, asset, recipient, pricing defaults, abuse limits, refund and treasury settings.',
          responses: { 200: { description: 'Configuration' } },
        },
      },
      '/api/x402/openapi.json': { get: { tags: ['x402'], summary: 'This OpenAPI document', responses: { 200: { description: 'OpenAPI 3.0 document' } } } },
      '/api/x402/invoices/create': {
        post: {
          tags: ['x402'], summary: 'Create an x402 invoice',
          description: 'Requires an authenticated active MSCA (Authorization + X-Arcox-Owner). Enforced per-owner abuse limits: max open invoices and optional creation cooldown.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['resource'], properties: {
            resource: { type: 'string', description: 'API resource path to pay for, e.g. /api/intel/address/0x...' },
            service: { type: 'string' }, amount: { type: 'string' }, agentId: { type: 'string' }, ownerWallet: { type: 'string' },
          } } } } },
          responses: { 200: { description: 'Invoice created' }, 401: { description: 'Unauthenticated' }, 429: { description: 'Abuse limit reached' }, 503: { description: 'Treasury low balance gate' } },
        },
      },
      '/api/x402/payment-request': { post: { tags: ['x402'], summary: 'Create a payment request (alias of invoice create)', responses: { 200: { description: 'Payment request created' } } } },
      '/api/x402/invoices/{invoiceId}/status': {
        get: { tags: ['x402'], summary: 'Reconcile and read an invoice', description: 'Reconciles on-chain payment evidence before returning state.', parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Invoice state' }, 404: { description: 'Not found' } } },
      },
      '/api/x402/payment-request/{paymentId}': {
        get: { tags: ['x402'], summary: 'Read a payment request by paymentId', parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Payment request state' } } },
      },
      '/api/x402/stats': {
        get: { tags: ['x402'], summary: 'Usage analytics (owner-gated)', description: 'Revenue, invoices by status, per-service usage, provider errors, refund pipeline state. Requires an active authenticated MSCA session.', responses: { 200: { description: 'Stats' }, 401: { description: 'Unauthenticated' } } },
      },
      '/api/x402/treasury-health': {
        get: { tags: ['x402'], summary: 'Treasury unified-balance health', description: 'Total USDC across Gateway chains vs. the configured minimum. Fail-open when the Gateway is unreachable.', responses: { 200: { description: 'Health' } } },
      },
      '/api/x402/refunds/approved': { get: { tags: ['x402'], summary: 'List auto-approved refunds', responses: { 200: { description: 'Approved refunds' } } } },
      '/api/x402/refunds/log': { get: { tags: ['x402'], summary: 'Refund audit log', responses: { 200: { description: 'Audit log entries' } } } },
      '/api/x402/refunds/scan': { post: { tags: ['x402'], summary: 'Trigger a refund eligibility scan', responses: { 200: { description: 'Newly approved refunds' } } } },
      '/api/x402/refunds/{invoiceId}/execute': {
        post: { tags: ['x402'], summary: 'Execute an approved refund', description: 'Spends USDC from the treasury Unified Balance back to the payer. Same delegated path the worker uses; owner-gated.', parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Refund executed' }, 401: { description: 'Unauthenticated' }, 404: { description: 'Invoice not found' }, 409: { description: 'Not approved or spend failed' } } },
      },
      '/api/x402/refunds/{invoiceId}/complete': {
        post: { tags: ['x402'], summary: 'Mark a refund completed (manual operator path)', parameters: [{ name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['txHash'], properties: { txHash: { type: 'string' } } } } } }, responses: { 200: { description: 'Refund recorded' } } },
      },
      '/api/intel/catalog': {
        get: { tags: ['intel'], summary: 'Structured service catalog', description: `Lists all ${catalog.length} read-only Intel services with price, cache tier, required parameters, and circuit-breaker degraded flag. Free endpoint.`, responses: { 200: { description: 'Catalog' } } },
      },
      '/api/intel/provider-health': {
        get: { tags: ['intel'], summary: 'Arkham provider circuit-breaker state', description: 'Per-service circuit state (closed/open/half-open) with failure counts. Free endpoint.', responses: { 200: { description: 'Circuit states' } } },
      },
      '/api/marketplace/stats': {
        get: { tags: ['marketplace'], summary: 'Mirror statistics', description: 'Resource/provider/chain counts, price buckets, last sync time, and the outbound payment executor status. Free endpoint.', responses: { 200: { description: 'Stats' } } },
      },
      '/api/marketplace/catalog': {
        get: {
          tags: ['marketplace'], summary: 'Search the mirrored x402 directory',
          description: 'Keyword/category/chain/price filters over every resource in the Circle x402 discovery directory. Returns provider prices and the ARCOX platform fee; never charges. Free endpoint.',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'network', in: 'query', schema: { type: 'string' } },
            { name: 'maxPriceUsdc', in: 'query', schema: { type: 'number' } },
            { name: 'gatewayOnly', in: 'query', schema: { type: 'boolean' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'Matching resources' } },
        },
      },
      '/api/marketplace/quote': {
        get: {
          tags: ['marketplace'], summary: 'Quote one resource with the ARCOX platform fee',
          description: 'Returns the provider price for the chosen chain, the ARCOX platform fee on top, the total the buyer pays, and the exact upstream URL that would be called. Free endpoint.',
          parameters: [
            { name: 'resource', in: 'query', required: true, schema: { type: 'string' }, description: 'Resource id (mkt_...), full URL, or unique URL fragment' },
            { name: 'chain', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Quote' }, 404: { description: 'Resource not found' } },
        },
      },
      '/api/marketplace/sync': {
        post: { tags: ['marketplace'], summary: 'Refresh the mirror (owner-gated)', description: 'Pages through the Circle x402 discovery directory and rewrites the local catalogue. Requires an active authenticated MSCA session.', responses: { 200: { description: 'Sync summary' }, 401: { description: 'Unauthenticated' }, 502: { description: 'Discovery unreachable' } } },
      },
      '/api/marketplace/call': {
        post: {
          tags: ['marketplace'], summary: 'Buy a mirrored resource through ARCOX (x402-paid + platform fee)',
          description: 'Creates an ARCOX x402 invoice for the provider price plus the platform fee, pays the provider through the configured outbound executor once the invoice is paid, and returns the provider response. Requires the executor to be configured; returns 503 otherwise. Requires an authenticated active MSCA (Authorization + X-Arcox-Owner).',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
            resource: { type: 'string' }, id: { type: 'string' }, chain: { type: 'string' }, data: {}, headers: { type: 'object' }, maxAmountUsdc: { type: 'number' },
          } } } } },
          responses: { 200: { description: 'Provider response with fee breakdown' }, 402: { description: 'x402 invoice (provider price + platform fee)' }, 400: { description: 'Unpayable resource or cap exceeded' }, 503: { description: 'Payment executor not configured' } },
        },
      },
    },
    components: {
      securitySchemes: {
        ownerAuth: { type: 'http', scheme: 'bearer', description: 'Owner token minted from the active MSCA session' },
        ownerHeader: { type: 'apiKey', in: 'header', name: 'X-Arcox-Owner', description: 'Active MSCA wallet address' },
        paymentIdHeader: { type: 'apiKey', in: 'header', name: 'X-Payment-Id', description: 'paymentId of a paid invoice to unlock the resource' },
      },
    },
    'x-arcox-intel-services': catalog.map(entry => ({
      route: entry.route,
      service: entry.service,
      price: entry.price,
      priceEnv: entry.priceEnv,
      cacheTier: entry.cacheTier,
      required: entry.required,
      defaults: entry.defaults,
      readOnly: true,
    })),
    'x-arcox-pricing': {
      baseAmount: cfg.baseAmount,
      ttlSeconds: cfg.ttlSeconds,
      recipient: cfg.circleTreasuryAddress,
      network: cfg.network,
      chainId: cfg.chainId,
      usdcAddress: cfg.usdcAddress,
      defaultPrice: priceFromEnv('X402_BASE_AMOUNT', '0.005'),
      platformFee: cfg.platformFee,
    },
  }
}
