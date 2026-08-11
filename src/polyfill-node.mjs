// Node.js compatibility shim for Circle SDK URL parsing.
// Do not define globalThis.window here: @circle-fin/adapter-viem-v2 uses
// `typeof window` to distinguish server-side developer-controlled wallets
// from browser EIP-1193 wallets. Making window point at globalThis sends the
// server down the browser chain-switch path and calls
// wallet_switchEthereumChain on a raw HTTP RPC.
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
