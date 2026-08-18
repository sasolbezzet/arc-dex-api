import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData } from 'viem'

const AMM_ROUTER = '0x9f2443691bddd8343590c68e2a2cdec5fd0b6124'
const AMM_POOL = '0xd4aF8e12903A4c6bD60BbC353fb97ffC9Cc2Dc2D'
const TREASURY = '0xE34FF1D2C925DDafB28C95C2396fC49A6f64569e'
const USDC = '0x3600000000000000000000000000000000000000'
const CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF'

const poolSwapAbi = [{
  type: 'function', name: 'swap', stateMutability: 'nonpayable',
  inputs: [
    { name: 'tokenIn', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
  ],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}]

test('MCP AMM route builds fee transfer, pool approval, and direct pool.swap calls', async () => {
  const previous = {
    router: process.env.ARCOX_AMM_ROUTER,
    pool: process.env.ARCOX_AMM_POOL,
  }
  process.env.ARCOX_AMM_ROUTER = AMM_ROUTER
  process.env.ARCOX_AMM_POOL = AMM_POOL
  try {
    const mod = await import('../src/services/mcpServer.mjs?amm-route-' + Date.now())
    const result = mod.buildPreparedSwapCalls({
      source: 'arcox-amm-router',
      tokenIn: 'USDC',
      tokenOut: 'cirBTC',
      amountIn: '1',
      amountOut: '0.1',
      ammRouter: AMM_ROUTER,
      ammPool: AMM_POOL,
      platformFee: { amount: '0.003', swapAmountIn: '0.997', treasury: TREASURY },
    }, { tokenIn: 'USDC', tokenOut: 'cirBTC' })

    assert.equal(result.reason, null)
    assert.equal(result.calls.length, 3)
    assert.equal(result.calls[0].to.toLowerCase(), USDC.toLowerCase())
    assert.equal(result.calls[1].to.toLowerCase(), USDC.toLowerCase())
    assert.equal(result.calls[2].to.toLowerCase(), AMM_POOL.toLowerCase())
    const decoded = decodeFunctionData({ abi: poolSwapAbi, data: result.calls[2].data })
    assert.equal(decoded.functionName, 'swap')
    assert.equal(decoded.args[0].toLowerCase(), USDC.toLowerCase())
    assert.equal(decoded.args[1], 997000n)
  } finally {
    if (previous.router === undefined) delete process.env.ARCOX_AMM_ROUTER
    else process.env.ARCOX_AMM_ROUTER = previous.router
    if (previous.pool === undefined) delete process.env.ARCOX_AMM_POOL
    else process.env.ARCOX_AMM_POOL = previous.pool
  }
})

test('MCP AMM route rejects a quote for an unregistered pool', async () => {
  const previous = {
    router: process.env.ARCOX_AMM_ROUTER,
    pool: process.env.ARCOX_AMM_POOL,
  }
  process.env.ARCOX_AMM_ROUTER = AMM_ROUTER
  process.env.ARCOX_AMM_POOL = AMM_POOL
  try {
    const mod = await import('../src/services/mcpServer.mjs?amm-pool-guard-' + Date.now())
    const result = mod.buildPreparedSwapCalls({
      source: 'arcox-amm-router', tokenIn: 'USDC', tokenOut: 'cirBTC', amountIn: '1', amountOut: '0.1',
      ammRouter: AMM_ROUTER, ammPool: '0x0000000000000000000000000000000000000001',
    }, { tokenIn: 'USDC', tokenOut: 'cirBTC' })
    assert.equal(result.calls, null)
    assert.equal(result.reason, 'amm_pool_mismatch')
  } finally {
    if (previous.router === undefined) delete process.env.ARCOX_AMM_ROUTER
    else process.env.ARCOX_AMM_ROUTER = previous.router
    if (previous.pool === undefined) delete process.env.ARCOX_AMM_POOL
    else process.env.ARCOX_AMM_POOL = previous.pool
  }
})
