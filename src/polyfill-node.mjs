// Node.js polyfill for browser-only globals referenced by Circle SDK's
// nested packages.  Without this, toModularTransport / createPublicClient
// throws "window is not defined" and developer-controlled-wallets fails
// to parse location as a URL.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}
if (!globalThis.location) {
  globalThis.location = {
    protocol: 'https:',
    hostname: 'arcoxdex.vercel.app',
    href: 'https://arcoxdex.vercel.app/',
    origin: 'https://arcoxdex.vercel.app',
    pathname: '/',
    toString() { return this.href },
  }
}
