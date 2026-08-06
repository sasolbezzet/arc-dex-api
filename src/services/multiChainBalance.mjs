// multiChainBalance.mjs — Fetch balances across all supported chains.
// Uses eth_call for ERC-20 balanceOf and eth_getBalance for native.

import { CHAINS, erc20BalanceOfCalldata } from './chains.mjs'

async function rpcCall(rpcUrl, method, params = []) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
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

  // Native token balance (ETH on ETH/ARB/BASE, USDC on Arc)
  try {
    const hex = await rpcCall(chain.rpcUrl, 'eth_getBalance', [walletAddress, 'latest'])
    const wei = hexToBigInt(hex)
    balances[chain.nativeCurrency.symbol] = formatUnits(wei, chain.nativeCurrency.decimals)
  } catch {
    balances[chain.nativeCurrency.symbol] = '0'
  }

  // ERC-20 token balances
  for (const [symbol, address] of Object.entries(chain.tokens)) {
    if (!address) continue
    try {
      const calldata = erc20BalanceOfCalldata(walletAddress)
      const hex = await rpcCall(chain.rpcUrl, 'eth_call', [
        { to: address, data: calldata },
        'latest',
      ])
      const raw = hexToBigInt(hex)
      // Most ERC-20 on testnets use 6 decimals (USDC, EURC) — try 6 first
      const decimals = symbol === 'USDC' ? 6 : symbol === 'EURC' ? 6 : 18
      balances[symbol] = formatUnits(raw, decimals)
    } catch {
      balances[symbol] = '0'
    }
  }

  return balances
}

/**
 * Fetch all balances across all chains for a wallet address.
 * Returns { 'arc-testnet': { USDC: '100', ... }, 'ethereum-sepolia': { ... }, ... }
 */
export async function fetchAllChainBalances(walletAddress) {
  const results = {}
  const chains = Object.keys(CHAINS)

  // Fetch in parallel
  const promises = chains.map(async (key) => {
    try {
      results[key] = await fetchChainBalances(key, walletAddress)
    } catch {
      results[key] = {}
    }
  })

  await Promise.all(promises)
  return results
}
