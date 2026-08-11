// Helpers for the Circle Modular Wallet JSON-RPC proxy.
// The configured client URL may be either the RPC base (/v1/rpc) or the
// tenant endpoint (/v1/rpc/w3s/buidl). The browser proxy path can contain the
// tenant endpoint, so joining must be idempotent and segment-aware.

function pathSegments(pathname) {
  return String(pathname || '').split('/').filter(Boolean)
}

export function buildCircleModularTarget(baseUrl, requestPath = '') {
  const base = new URL(String(baseUrl || '').replace(/\/+$/, ''))
  const request = new URL(`https://proxy.invalid/${String(requestPath || '').replace(/^\/+/, '')}`)
  const baseSegments = pathSegments(base.pathname)
  const requestSegments = pathSegments(request.pathname)

  // Find the largest exact segment overlap between the end of the configured
  // base and the beginning of the mounted request path. This supports both:
  //   /v1/rpc + /w3s/buidl       -> /v1/rpc/w3s/buidl
  //   /v1/rpc/w3s/buidl + /w3s/buidl -> /v1/rpc/w3s/buidl
  //   /v1/rpc/w3s/buidl + /w3s/buidl/foo -> /v1/rpc/w3s/buidl/foo
  let overlap = 0
  const maxOverlap = Math.min(baseSegments.length, requestSegments.length)
  for (let size = 1; size <= maxOverlap; size++) {
    const baseSuffix = baseSegments.slice(-size).join('/')
    const requestPrefix = requestSegments.slice(0, size).join('/')
    if (baseSuffix === requestPrefix) overlap = size
  }

  const joinedSegments = baseSegments.concat(requestSegments.slice(overlap))
  base.pathname = `/${joinedSegments.join('/')}`
  // req.url's query belongs to the JSON-RPC endpoint request and must survive
  // proxying even when the configured base URL has no query component.
  base.search = request.search
  base.hash = ''
  return base.toString().replace(/\/$/, '')
}

export function circleModularProxyHeaders(clientKey, appInfo = 'platform=web;version=1.0.15;uri=arcoxdex.vercel.app') {
  return {
    'Content-Type': 'application/json',
    // This value is deliberately constructed only from server configuration.
    Authorization: `Bearer ${String(clientKey || '')}`,
    'X-AppInfo': appInfo,
  }
}

// The endpoint is public because the browser reaches it through Vercel. Keep
// only methods required by the Modular Wallet SDK and ordinary UserOperation
// reads/submission. In particular, do not turn this into an arbitrary upstream
// JSON-RPC relay under the server's Circle credential.
const CIRCLE_MODULAR_ETH_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_estimateUserOperationGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getUserOperationByHash',
  'eth_getUserOperationReceipt',
  'eth_sendUserOperation',
  'eth_supportedEntryPoints',
  // Used by toCircleSmartAccount after WebAuthn login to resolve the
  // deterministic MSCA address. Keep this explicit rather than allowing a
  // broad circle_* wildcard on the public proxy.
  'circle_getAddress',
  'circle_getAddressMapping',
  'circle_createAddressMapping',
  'circle_getUserOperationGasPrice',
  'pm_getPaymasterData',
  'pm_getPaymasterStubData',
])

export function isAllowedCircleModularMethod(method) {
  return CIRCLE_MODULAR_ETH_METHODS.has(String(method || ''))
    || /^rp_(getLoginOptions|getLoginVerification|getRegistrationOptions|getRegistrationVerification)$/.test(String(method || ''))
}

// Upstream Circle failures have occasionally arrived as HTML from an nginx
// gateway, or as malformed text with an application/json content type. Viem's
// JSON-RPC transport cannot parse either form. Normalize every upstream body at
// the proxy boundary so the client always receives a JSON-RPC-shaped response.
export function normalizeCircleModularResponse({ status, contentType = '', text = '', id = null } = {}) {
  const rawStatus = Number(status)
  const upstreamStatus = Number.isFinite(rawStatus) ? rawStatus : 502
  let parsed
  try { parsed = JSON.parse(String(text || '')) } catch { parsed = null }
  const validJsonRpc = parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.jsonrpc === '2.0'
    && (Object.prototype.hasOwnProperty.call(parsed, 'result') || Object.prototype.hasOwnProperty.call(parsed, 'error'))
  if (validJsonRpc) {
    // HTTP 204/304 cannot carry a response body. JSON-RPC clients need the
    // envelope, so use 200 for these otherwise-invalid body/status combinations.
    const bodyStatus = upstreamStatus === 204 || upstreamStatus === 304 ? 200 : upstreamStatus
    return { status: bodyStatus, body: parsed, passthrough: true }
  }
  return {
    // Invalid upstream content is a proxy failure regardless of whether the
    // gateway used a 2xx or 4xx status; never present HTML as an application
    // error to the JSON-RPC client.
    status: 502,
    body: {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: `Circle Modular upstream returned invalid JSON-RPC (HTTP ${upstreamStatus})`,
        data: {
          upstreamStatus,
          upstreamContentType: String(contentType || '').slice(0, 120) || null,
        },
      },
    },
    passthrough: false,
  }
}
