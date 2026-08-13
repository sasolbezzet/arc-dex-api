// multiChainBalance.mjs — Fetch balances across all supported chains.
// Uses eth_call for ERC-20 balanceOf and eth_getBalance for native.

import { CHAINS, erc20BalanceOfCalldata } from './chains.mjs'

async function rpcCall(rpcUrl, method, params = []) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'RPC error')
  return data.result
}

function hexToBigInt(hex) {
  if (!hex || hex === '0x') return 0n
  return BigInt(hex)
}

function formatUnits(value, decimals) {
  const divisor = 10n ** BigInt(decimals)
  const whole = value / divisor
  const frac = value % divisor
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return fracStr ? `${whole}.${fracStr}` : whole.toString()
}

async function fetchChainBalances(chainKey, walletAddress) {
  const chain = CHAINS[chainKey]
  if (!chain) return null

  const balances = {}
  const errors = []
  const nativeSymbol = chain.nativeCurrency.symbol

  // Keep native and ERC-20 balances separate. Arc uses USDC as its native
  // currency and also exposes an ERC-20 USDC contract, so one `USDC` key would
  // otherwise overwrite the native value.
  try {
    const hex = await rpcCall(chain.rpcUrl, 'eth_getBalance', [walletAddress, 'latest'])
    balances.nativeBalance = formatUnits(hexToBigInt(hex), chain.nativeCurrency.decimals)
  } catch (error) {
    balances.nativeBalance = null
    errors.push(`native ${nativeSymbol}: ${error?.message || 'RPC lookup failed'}`)
  }
  balances.nativeSymbol = nativeSymbol

  const tokens = {}
  for (const [symbol, address] of Object.entries(chain.tokens)) {
    if (!address) continue
    try {
      const calldata = erc20BalanceOfCalldata(walletAddress)
      const hex = await rpcCall(chain.rpcUrl, 'eth_call', [{ to: address, data: calldata }, 'latest'])
      const decimals = symbol === 'USDC' || symbol === 'EURC' || symbol === 'USYC' ? 6 : symbol === 'cirBTC' ? 8 : 18
      tokens[symbol] = formatUnits(hexToBigInt(hex), decimals)
    } catch (error) {
      tokens[symbol] = null
      errors.push(`${symbol}: ${error?.message || 'RPC lookup failed'}`)
    }
  }
  balances.tokens = tokens
  // Return the exact contract used for every ERC-20 read. Arc's native USDC
  // balance is intentionally separate: Arc documents native USDC with 18
  // decimals and the optional ERC-20 interface with 6 decimals, while both
  // represent the same underlying balance.
  balances.tokenContracts = Object.fromEntries(Object.entries(chain.tokens).filter(([, address]) => Boolean(address)))
  balances.contracts = {
    nativeBalance: null,
    tokens: balances.tokenContracts,
  }
  // Preserve the established flat token keys consumed by the frontend and
  // older MCP clients, while exposing nativeBalance separately.
  Object.assign(balances, tokens)
  const successfulTokenReads = Object.values(tokens).filter(value => value !== null).length
  balances.status = errors.length === 0 ? 'ok' : (successfulTokenReads > 0 || balances.nativeBalance !== null ? 'partial' : 'error')
  if (errors.length) balances.errors = errors
  return balances
}

/**
 * Fetch all balances across all chains for a wallet address.
 * Returns { 'arc-testnet': { USDC: '100', ... }, 'ethereum-sepolia': { ... }, ... }
 */
export async function fetchAllChainBalances(walletAddress) {
  const results = {}
  // Keep the MCP/dashboard contract explicit and deterministic: exactly the
  // four EVM chains used by the Agent Wallet, not future registry additions.
  const chains = ['arc-testnet', 'ethereum-sepolia', 'base-sepolia', 'arbitrum-sepolia']

  // Fetch in parallel
  const promises = chains.map(async (key) => {
    try {
      results[key] = await fetchChainBalances(key, walletAddress)
    } catch (error) {
      // Preserve the four-chain response contract and make an unavailable
      // chain distinguishable from a real zero balance.
      results[key] = {
        nativeBalance: null,
        nativeSymbol: CHAINS[key]?.nativeCurrency?.symbol || null,
        tokens: {},
        tokenContracts: Object.fromEntries(Object.entries(CHAINS[key]?.tokens || {}).filter(([, address]) => Boolean(address))),
        contracts: {
          nativeBalance: null,
          tokens: Object.fromEntries(Object.entries(CHAINS[key]?.tokens || {}).filter(([, address]) => Boolean(address))),
        },
        status: 'error',
        errors: [error?.message || 'RPC lookup failed'],
      }
    }
  })

  await Promise.all(promises)
  return results
}
