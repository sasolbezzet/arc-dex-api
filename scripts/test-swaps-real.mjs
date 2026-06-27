import { readFileSync } from 'node:fs'
import { AppKit, SwapChain } from '@circle-fin/app-kit'
import { ArcTestnet } from '@circle-fin/app-kit/chains'
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
  if (requestedWallet === 'circle') await testCircleApiSwaps()
  else if (requestedWallet === 'eoa') await testEoaApiSwaps()
  else throw new Error('--api supports --wallet=eoa or --wallet=circle')
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
  const token = await authenticateApi()
  for (const [tokenIn, tokenOut, amountIn] of pairs) {
    const payload = { metamaskAddress: owner, tokenIn, tokenOut, amountIn }
    try {
      const quote = await apiPost('/api/quote', payload, token)
      if (quote.available === false) throw new Error(quote.error || 'Route unavailable')
      const row = { wallet: 'circle-api', pair: `${tokenIn}-${tokenOut}`, amountIn, amountOut: quote.amountOut, executable: true }
      if (execute) {
        const swap = await apiPost('/api/swap', payload, token)
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

async function testEoaApiSwaps() {
  const token = await authenticateApi()
  for (const [tokenIn, tokenOut, amountIn] of pairs) {
    const payload = { metamaskAddress: owner, tokenIn, tokenOut, amountIn }
    try {
      const quote = await apiPost('/api/eoa-swap-quote', payload, token)
      const row = { wallet: 'eoa-api', pair: `${tokenIn}-${tokenOut}`, amountIn, amountOut: quote.amountOut, executable: true }
      if (execute) {
        const prepared = await apiPost('/api/eoa-swap-prepare', payload, token)
        const stepTxHashes = []
        for (const leg of prepared.legs || []) {
          const context = { chain: ArcTestnet, address: owner }
          const approval = await eoaAdapter.prepareAction('token.approve', {
            tokenAddress: leg.tokenInAddress,
            delegate: prepared.adapterContract,
            amount: BigInt(leg.amountBaseUnits),
          }, context)
          const approvalTx = await approval.execute()
          await eoaAdapter.waitForTransaction(approvalTx, undefined, ArcTestnet)
          stepTxHashes.push(approvalTx)
          const swapRequest = await eoaAdapter.prepareAction('swap.execute', {
            executeParams: normalizePreparedExecution(leg.executionParams),
            tokenInputs: [{
              permitType: 0,
              token: leg.tokenInAddress,
              amount: BigInt(leg.amountBaseUnits),
              permitCalldata: '0x',
            }],
            signature: leg.signature,
            inputAmount: BigInt(leg.amountBaseUnits),
            tokenInAddress: leg.tokenInAddress,
          }, context)
          const localEstimate = await swapRequest.estimate()
          const localGas = Number(localEstimate?.gas || 0)
          const proxyGas = Number(leg.gasLimit || 0)
          const gasLimit = Math.max(proxyGas, Math.ceil(localGas * 1.3))
          const swapTx = await swapRequest.execute({ gasLimit })
          let receipt
          try {
            receipt = await eoaAdapter.waitForTransaction(swapTx, undefined, ArcTestnet)
          } catch (error) {
            throw new Error(`${error.message}; txHash=${swapTx}; localGas=${localGas}; proxyGas=${proxyGas}; gasLimit=${gasLimit}`)
          }
          if (receipt.status === 'reverted') throw new Error(`Prepared swap reverted: ${swapTx}; gasUsed=${String(receipt.gasUsed || '')}; gasLimit=${gasLimit}`)
          stepTxHashes.push(swapTx)
        }
        row.txHash = stepTxHashes.at(-1)
        row.stepTxHashes = stepTxHashes
      }
      console.log(JSON.stringify(row))
    } catch (error) {
      console.log(JSON.stringify({ wallet: 'eoa-api', pair: `${tokenIn}-${tokenOut}`, amountIn, executable: false, error: error.message }))
    }
  }
}

async function authenticateApi() {
  const issuedAt = new Date().toISOString()
  const message = [
    'ARCOX DEX login',
    'Only sign this message on the official ARCOX DEX website.',
    `Address: ${owner}`,
    `Issued At: ${issuedAt}`,
    'Network: Arc Testnet',
  ].join('\n')
  const signature = await privateKeyToAccount(privateKey).signMessage({ message })
  const response = await fetch('http://127.0.0.1:3001/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: owner, issuedAt, signature }),
  })
  const auth = await response.json()
  if (!response.ok || !auth.token) throw new Error(auth.error || 'ARCOX API login failed')
  return auth.token
}

function normalizePreparedExecution(params) {
  return {
    instructions: (params?.instructions || []).map(instruction => ({
      ...instruction,
      value: BigInt(instruction.value),
      amountToApprove: BigInt(instruction.amountToApprove),
      minTokenOut: BigInt(instruction.minTokenOut),
    })),
    tokens: params?.tokens || [],
    execId: BigInt(params.execId),
    deadline: BigInt(params.deadline),
    metadata: params.metadata,
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
