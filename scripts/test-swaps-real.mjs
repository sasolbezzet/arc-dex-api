import { readFileSync } from 'node:fs'
import { AppKit, SwapChain } from '@circle-fin/app-kit'
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { privateKeyToAccount } from 'viem/accounts'

const execute = process.argv.includes('--execute')
const withFee = process.argv.includes('--fee')
const throughApi = process.argv.includes('--api')
const requestedWallet = process.argv.find(value => value.startsWith('--wallet='))?.split('=')[1] || 'eoa'
const requestedPair = process.argv.find(value => value.startsWith('--pair='))?.split('=')[1]
const requestedAmount = process.argv.find(value => value.startsWith('--amount='))?.split('=')[1]
const kitKey = process.env.KIT_KEY
const privateKey = process.env.EOA_PRIVATE_KEY
if (!kitKey) throw new Error('KIT_KEY is required')
if (!privateKey) throw new Error('EOA_PRIVATE_KEY is required')

const owner = privateKeyToAccount(privateKey).address
const circleWallet = circleWalletForOwner(owner)
const kit = new AppKit()
const eoaAdapter = createViemAdapterFromPrivateKey({ privateKey, rpcUrl: process.env.ARC_RPC_URL || process.env.ARC_RPC })
const circleAdapter = createCircleWalletsAdapter({
  apiKey: process.env.CIRCLE_API_KEY,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET,
})
const tokenParam = token => token === 'cirBTC' ? '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' : token
const pairs = [
  ['USDC', 'EURC', '0.1'],
  ['EURC', 'USDC', '0.1'],
  ['USDC', 'cirBTC', '0.1'],
  ['cirBTC', 'USDC', '0.000001'],
  ['EURC', 'cirBTC', '0.1'],
  ['cirBTC', 'EURC', '0.000001'],
]
  .filter(([tokenIn, tokenOut]) => !requestedPair || requestedPair === `${tokenIn}-${tokenOut}`)
  .map(([tokenIn, tokenOut, amountIn]) => [tokenIn, tokenOut, requestedAmount || amountIn])

if (throughApi) {
  if (requestedWallet !== 'circle') throw new Error('--api currently supports --wallet=circle')
  await testCircleApiSwaps()
  process.exit(0)
}

for (const [tokenIn, tokenOut, amountIn] of pairs) {
  const isCircle = requestedWallet === 'circle'
  const params = {
    from: {
      adapter: isCircle ? circleAdapter : eoaAdapter,
      chain: SwapChain.Arc_Testnet,
      ...(isCircle ? { address: circleWallet } : {}),
    },
    tokenIn: tokenParam(tokenIn),
    tokenOut: tokenParam(tokenOut),
    amountIn,
    config: {
      kitKey,
      allowanceStrategy: 'approve',
      slippageBps: 300,
      ...(withFee ? {
        customFee: {
          percentageBps: Number(process.env.ARCOX_ROUTER_FEE_BPS || 30),
          recipientAddress: process.env.ARCOX_FEE_TREASURY || owner,
        },
      } : {}),
    },
  }
  try {
    const estimate = await estimateRoute(params, tokenIn, tokenOut)
    const row = {
      wallet: requestedWallet,
      pair: `${tokenIn}-${tokenOut}`,
      amountIn,
      amountOut: estimate?.estimatedOutput?.amount,
      stopLimit: estimate?.stopLimit?.amount,
      executable: true,
    }
    if (execute) {
      const result = await executeRoute(params, tokenIn, tokenOut)
      row.txHash = result?.txHash || result?.transactionHash || result?.steps?.find?.(step => step?.txHash)?.txHash
      row.explorerUrl = result?.explorerUrl
      row.stepTxHashes = result?.steps?.map(step => step?.txHash).filter(Boolean)
    }
    console.log(JSON.stringify(row))
  } catch (error) {
    console.log(JSON.stringify({
      wallet: requestedWallet,
      pair: `${tokenIn}-${tokenOut}`,
      amountIn,
      executable: false,
      error: error?.message || String(error),
    }))
  }
}

async function estimateRoute(params, tokenIn, tokenOut) {
  if (tokenIn !== 'EURC' || tokenOut !== 'cirBTC') return kit.estimateSwap(params)
  let first
  try {
    first = await kit.estimateSwap({ ...params, tokenIn: 'EURC', tokenOut: 'USDC' })
  } catch (error) {
    throw new Error(`EURC → USDC quote failed: ${error.message}`)
  }
  let second
  try {
    second = await kit.estimateSwap({
      ...params,
      tokenIn: 'USDC',
      tokenOut: tokenParam('cirBTC'),
      amountIn: first.estimatedOutput.amount,
      config: withoutCustomFee(params.config),
    })
  } catch (error) {
    throw new Error(`USDC → cirBTC quote failed for ${first.estimatedOutput.amount} USDC: ${error.message}`)
  }
  return { ...second, fees: [...(first.fees || []), ...(second.fees || [])], route: 'EURC → USDC → cirBTC' }
}

async function executeRoute(params, tokenIn, tokenOut) {
  if (tokenIn !== 'EURC' || tokenOut !== 'cirBTC') return kit.swap(params)
  const first = await kit.swap({ ...params, tokenIn: 'EURC', tokenOut: 'USDC' })
  const second = await kit.swap({
    ...params,
    tokenIn: 'USDC',
    tokenOut: tokenParam('cirBTC'),
    amountIn: first.amountOut,
    config: withoutCustomFee(params.config),
  })
  return { ...second, steps: [first, second], route: 'EURC → USDC → cirBTC' }
}

function withoutCustomFee(config) {
  const { customFee: _customFee, ...rest } = config || {}
  return rest
}

function circleWalletForOwner(address) {
  const db = JSON.parse(readFileSync(new URL('../wallets-db.json', import.meta.url), 'utf8'))
  const entry = db[address.toLowerCase()] || db[address]
  if (!entry?.address) throw new Error(`Circle wallet not found for ${address}`)
  return entry.address
}

async function testCircleApiSwaps() {
  const issuedAt = new Date().toISOString()
  const message = [
    'ARCOX DEX login',
    'Only sign this message on the official ARCOX DEX website.',
    `Address: ${owner}`,
    `Issued At: ${issuedAt}`,
    'Network: Arc Testnet',
  ].join('\n')
  const signature = await privateKeyToAccount(privateKey).signMessage({ message })
  const authResponse = await fetch('http://127.0.0.1:3001/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: owner, issuedAt, signature }),
  })
  const auth = await authResponse.json()
  if (!authResponse.ok || !auth.token) throw new Error(auth.error || 'ARCOX API login failed')
  for (const [tokenIn, tokenOut, amountIn] of pairs) {
    const payload = { metamaskAddress: owner, tokenIn, tokenOut, amountIn }
    try {
      const quote = await apiPost('/api/quote', payload, auth.token)
      if (quote.available === false) throw new Error(quote.error || 'Route unavailable')
      const row = { wallet: 'circle-api', pair: `${tokenIn}-${tokenOut}`, amountIn, amountOut: quote.amountOut, executable: true }
      if (execute) {
        const swap = await apiPost('/api/swap', payload, auth.token)
        if (swap.available === false) throw new Error(swap.error || 'Route unavailable')
        row.txHash = swap.result?.txHash || swap.result?.transactionHash
        row.feeTxHash = swap.result?.platformFee?.txHash
        row.explorerUrl = swap.result?.explorerUrl
        row.stepTxHashes = swap.result?.steps?.map(step => step?.txHash).filter(Boolean)
      }
      console.log(JSON.stringify(row))
    } catch (error) {
      console.log(JSON.stringify({ wallet: 'circle-api', pair: `${tokenIn}-${tokenOut}`, amountIn, executable: false, error: error.message }))
    }
  }
}

async function apiPost(path, body, token) {
  const response = await fetch(`http://127.0.0.1:3001${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `ARCOX API HTTP ${response.status}`)
  return data
}
