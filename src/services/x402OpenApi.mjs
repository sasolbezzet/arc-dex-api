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
    },
  }
}
