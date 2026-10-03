#!/usr/bin/env node
// probe-swap-routes.mjs — probe READ-ONLY ketersediaan route Circle Stablecoin
// Service (endpoint yang dipakai /api/eoa-swap-quote) untuk pasangan token yang
// diminta retail: USDC↔cirBTC, EURC↔cirBTC di Arc mainnet, plus token arbitrary
// (paste CA) dan chain lain (Base/Arbitrum/Ethereum).
//
// Tidak menandatangani apa pun, tidak menyentuh dana: hanya GET /quote.
//
// Pemakaian:
//   node --env-file=.env scripts/probe-swap-routes.mjs
//   node --env-file=.env scripts/probe-swap-routes.mjs --chain=Arc
//   node --env-file=.env scripts/probe-swap-routes.mjs --json
import { arcNetwork } from '../src/config/arcNetwork.mjs'

const BASE = 'https://api.circle.com'
const onlyChain = process.argv.find(v => v.startsWith('--chain='))?.split('=')[1]
const asJson = process.argv.includes('--json')

const env = process.env
const apiKey = arcNetwork().isMainnet
  ? String(env.CIRCLE_API_KEY_MAINNET || '').trim()
  : String(env.KIT_KEY || env.CIRCLE_API_KEY || '').trim()
if (!apiKey) throw new Error('CIRCLE_API_KEY_MAINNET (mainnet) atau KIT_KEY (testnet) wajib ada di .env')

// Alamat token per chain (mainnet). Sumber: docs Arc + Circle token locators.
const TOKENS = {
  Arc: {
    USDC: '0x3600000000000000000000000000000000000000',
    EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    cirBTC: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
  },
  Base: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    EURC: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
    WETH: '0x4200000000000000000000000000000000000006',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  },
  Arbitrum: {
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    EURC: '0x643b34980E635719C15a2D4ce695b0c30E3f2aC5',
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  },
  Ethereum: {
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    EURC: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
    cirBTC: '0x72DFB2E44f59C5AD2bAFE84314E5b99a7cd5075E',
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
}

const FROM = '0x000000000000000000000000000000000000dEaD'
const AMOUNTS = { USDC: '1000000', EURC: '1000000', cirBTC: '10000' }

const PAIRS = [
  ['Arc', 'USDC', 'cirBTC'],
  ['Arc', 'cirBTC', 'USDC'],
  ['Arc', 'EURC', 'cirBTC'],
  ['Arc', 'cirBTC', 'EURC'],
  ['Arc', 'USDC', 'EURC'],
  ['Arc', 'EURC', 'USDC'],
  ['Ethereum', 'USDC', 'cirBTC'],
  ['Ethereum', 'cirBTC', 'USDC'],
  ['Base', 'USDC', 'EURC'],
  ['Base', 'USDC', 'WETH'],
  ['Base', 'USDC', 'DAI'],
  ['Base', 'USDC', 'cbBTC'],
  ['Arbitrum', 'USDC', 'WETH'],
  ['Arbitrum', 'USDC', 'EURC'],
]

async function quote(chain, tokenInAddress, tokenOutAddress, amount) {
  const url = new URL('/v1/stablecoinKits/quote', BASE)
  url.searchParams.set('tokenInAddress', tokenInAddress)
  url.searchParams.set('tokenInChain', chain)
  url.searchParams.set('tokenOutAddress', tokenOutAddress)
  url.searchParams.set('tokenOutChain', chain)
  url.searchParams.set('fromAddress', FROM)
  url.searchParams.set('toAddress', FROM)
  url.searchParams.set('amount', amount)
  url.searchParams.set('slippageBps', '300')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'arcox-probe/1.0' },
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : {}
    if (!response.ok) {
      return { ok: false, status: response.status, error: data?.error?.message || data?.message || `HTTP ${response.status}` }
    }
    const q = data?.quote || data
    return {
      ok: true,
      estimatedAmount: q?.estimatedAmount,
      minAmount: q?.minAmount,
      provider: q?.route?.provider || q?.provider,
      fees: (q?.fees || []).map(f => `${f.type}:${f.amount}`).join(','),
    }
  } catch (error) {
    return { ok: false, status: 0, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

const rows = []
for (const [chain, tokenIn, tokenOut] of PAIRS) {
  if (onlyChain && chain !== onlyChain) continue
  const inAddress = TOKENS[chain]?.[tokenIn]
  const outAddress = TOKENS[chain]?.[tokenOut]
  if (!inAddress || !outAddress) {
    rows.push({ chain, pair: `${tokenIn}->${tokenOut}`, ok: false, error: 'alamat token belum dipetakan di probe' })
    continue
  }
  const result = await quote(chain, inAddress, outAddress, AMOUNTS[tokenIn] || '1000000')
  rows.push({ chain, pair: `${tokenIn}->${tokenOut}`, ...result })
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 1))
} else {
  for (const row of rows) {
    const status = row.ok ? `OK out=${row.estimatedAmount} min=${row.minAmount} provider=${row.provider || '-'}` : `FAIL ${row.status || ''} ${row.error}`
    console.log(`${row.chain.padEnd(9)} ${row.pair.padEnd(16)} ${status}`)
  }
}
