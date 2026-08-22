// Type declarations for the ARCOX x402 client SDK (sdk/arcox-x402.mjs).

export interface X402ClientOptions {
  baseUrl?: string
  authToken?: string
  ownerWallet?: string
  agentId?: string
}

export interface X402Invoice {
  invoiceId: string
  paymentId: string
  agentId?: string
  ownerWallet?: string
  service: string
  resource: string
  status: 'payment_required' | 'estimate_ready' | 'settlement_pending' | 'paid' | 'expired' | 'failed' | 'cancelled' | 'refunded' | string
  asset: string
  network: string
  chainId: number
  usdcAddress: string
  recipient: string
  baseAmount: string
  uniqueAmount: string
  amount: string
  amountBaseUnits: string
  decimals: number
  paymentMethod: string
  paymentMethods: string[]
  createdAt: string
  expiresAt: string
  expiresInSeconds: number
  txHash?: string
  paidAt?: string
  serviceStatus?: string
  serviceError?: string
  refundEligible?: boolean
  refundStatus?: string
  refundApprovedAt?: string
  refundedAt?: string
  refundTxHash?: string
  refundAttempts?: number
  refundExecuteError?: string
}

export interface X402Stats {
  generatedAt: string
  totals: { invoices: number; paid: number; open: number; expired: number; failed: number; cancelled: number }
  byStatus: Record<string, number>
  byService: Record<string, number>
  byServiceStatus: Record<string, number>
  byRefundStatus: Record<string, number>
  revenueUsdc: number
  revenueLast24hUsdc: number
  paid24h: number
  refunds: { pending_review: number; refund_approved: number; refunded: number; manual_review: number; refund_failed_manual: number; refundedUsdc: number }
  providerErrors: { provider_not_found: number; provider_error: number }
}

export interface IntelCatalogEntry {
  route: string
  service: string
  description: string
  price: string
  priceEnv: string
  cacheTier: 'static' | 'slow' | 'default' | 'dynamic'
  cacheTtlSeconds: number
  required: string[]
  defaults: Record<string, string>
  readOnly: true
  degraded: boolean
}

export interface CircuitState {
  key: string
  state: 'closed' | 'open' | 'half_open'
  failureCount: number
  openedAt?: number
  lastFailureAt?: number
  lastSuccessAt?: number
}

export interface ApiResponse<T> {
  status: number
  ok: boolean
  data: T
}

export interface X402Client {
  config: () => Promise<ApiResponse<Record<string, unknown>>>
  openApi: () => Promise<ApiResponse<Record<string, unknown>>>
  catalog: () => Promise<ApiResponse<{ ok: true; readOnly: true; services: IntelCatalogEntry[] }>>
  providerHealth: () => Promise<ApiResponse<{ ok: true; circuits: CircuitState[] }>>
  createInvoice: (resource: string, opts?: Record<string, unknown>) => Promise<ApiResponse<{ ok: true; invoice: X402Invoice; x402: X402Invoice; config: Record<string, unknown> }>>
  paymentRequest: (resource: string, opts?: Record<string, unknown>) => Promise<ApiResponse<{ ok: true; invoice: X402Invoice; x402: X402Invoice; config: Record<string, unknown> }>>
  getInvoice: (invoiceId: string) => Promise<ApiResponse<{ ok: true; invoice: X402Invoice; x402: X402Invoice }>>
  getPaymentRequest: (paymentId: string) => Promise<ApiResponse<{ ok: true; invoice: X402Invoice; x402: X402Invoice }>>
  unlock: (resource: string, paymentId: string) => Promise<ApiResponse<Record<string, unknown>>>
  waitForInvoice: (invoiceId: string, options?: { timeoutMs?: number; pollMs?: number }) => Promise<X402Invoice | undefined>
  pay: (invoice: X402Invoice, transfer: (invoice: X402Invoice) => Promise<unknown>) => Promise<{ invoice: X402Invoice; transferResult: unknown }>
  stats: () => Promise<ApiResponse<{ ok: true; stats: X402Stats }>>
  treasuryHealth: () => Promise<ApiResponse<Record<string, unknown>>>
  approvedRefunds: () => Promise<ApiResponse<{ ok: true; refunds: X402Invoice[] }>>
  refundLog: () => Promise<ApiResponse<{ ok: true; log: Array<Record<string, unknown>> }>>
}

export function createX402Client(options?: X402ClientOptions): X402Client
