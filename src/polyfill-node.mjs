// Node.js polyfill for browser-only globals referenced by Circle SDK's
// nested viem@2.45.3 HTTP transport.  Without this, toModularTransport /
// createPublicClient throws "window is not defined" on every RPC call.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}