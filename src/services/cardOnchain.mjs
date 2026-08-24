// ARC on-chain helpers for the Card Simulator.
//
// Balance: reads the real USDC balance of the Agent Wallet MSCA on Arc Testnet
// (contract 0x3600...0000).
// Transfers: executes a USDC `transfer` userOperation from the MSCA through the
// existing session-key + paymaster path (same as arcox_pay), so a card spend
// truly *debits* the wallet's on-chain USDC balance. The destination is the
// configured merchant settlement wallet (defaults to the ARCOX treasury), to
// simulate the merchant side of a card network.

import { createPublicClient, defineChain, getAddress, http, parseUnits } from 'viem'
import { resolveArcRpc } from '../config/arcRpc.mjs'

const ARC_TESTNET_CHAIN = defineChain({
  id: 5042002, name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: { default: { http: [] } },
})

export const ARC_USDC_TOKEN = '0x3600000000000000000000000000000000000000'

export function cardMerchantWallet() {
  const explicit = String(process.env.CARDS_MERCHANT_WALLET || '').trim()
  if (explicit) return explicit
  // Default: ARCOX treasury (simulates the merchant side of the card network)
  return String(process.env.ARCOX_TREASURY_WALLET_ADDRESS || '').trim() || '0x0000000000000000000000000000000000000000'
}

export function onchainModeEnabled() {
  return String(process.env.CARDS_SYNC_ONCHAIN || 'true').toLowerCase() !== 'false'
}

export async function readArcUsdcBalance(walletAddress) {
  const fake = String(process.env.CARDS_FAKE_BALANCE || '').trim()
  if (fake) return parseUnits(fake, 6)
  const rpc = resolveArcRpc({ preferCanteen: process.env.USE_CANTEEN_RPC === 'true' })
  const client = createPublicClient({
    chain: { ...ARC_TESTNET_CHAIN, rpcUrls: { default: { http: [rpc] } } },
    transport: http(rpc),
  })
  return client.readContract({
    address: ARC_USDC_TOKEN,
    abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [getAddress(walletAddress)],
  })
}

export function usdcUnitsToHuman(units) {
  const base = units / 1_000_000n
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${base.toString()}${frac ? `.${frac}` : ''}`
}

export async function executeArcTransfer(walletAddress, { to, amountUnits } = {}) {
  const fake = String(process.env.CARDS_FAKE_TRANSFER || '').trim()
  if (fake === 'true') {
    return { status: 'success', txHash: '0xfake'.padEnd(66, 'f'), explorerUrl: 'https://testnet.arcscan.app/tx/fake' }
  }
  const { executeViaSession } = await import('./sessionKeyService.mjs')
  const result = await executeViaSession(walletAddress, [{
    to: ARC_USDC_TOKEN, value: 0n,
    abi: [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable',
      inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }],
    functionName: 'transfer',
    args: [getAddress(to), parseUnits(usdcUnitsToHuman(amountUnits), 6)],
  }], { paymaster: true, chainKey: 'arc-testnet', feeProfile: 'arc-pay', requireTransactionHash: true, requireSuccessfulTransactionReceipt: true })
  if (result.status !== 'success') {
    return { status: 'error', reason: result.reason || 'transfer failed', error: result.error, txHash: result.txHash }
  }
  return { status: 'success', txHash: result.txHash, explorerUrl: result.explorerUrl }
}