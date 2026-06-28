import { AppKit } from '@circle-fin/app-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { privateKeyToAccount } from 'viem/accounts'

let kit
let adapter
const GATEWAY_API = 'https://gateway-api-testnet.circle.com'
const GATEWAY_CHAINS = [
  { chain: 'Arc_Testnet', domain: 26 },
  { chain: 'Base_Sepolia', domain: 6 },
  { chain: 'Ethereum_Sepolia', domain: 0 },
  { chain: 'Arbitrum_Sepolia', domain: 3 },
]

function getKit() {
  if (!kit) kit = new AppKit()
  return kit
}

function getAdapter() {
  if (!adapter) {
    adapter = createViemAdapterFromPrivateKey({ privateKey: delegatePrivateKey() })
  }
  return adapter
}

export function delegateConfig() {
  const signer = delegateSignerAddress()
  return {
    delegateAddress: firstValidAddress(process.env.AI_ROUTER_DELEGATE_ADDRESS, signer, process.env.CIRCLE_DELEGATE_ADDRESS),
    recipient: firstValidAddress(process.env.AI_ROUTER_TREASURY_ADDRESS, process.env.ARCOX_TREASURY_WALLET_ADDRESS, process.env.X402_RECIPIENT_ADDRESS, process.env.CIRCLE_X402_TREASURY_ADDRESS),
    enabled: Boolean(delegatePrivateKey()),
  }
}

function firstValidAddress(...values) {
  return values.find(value => /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim())) || ''
}

function delegatePrivateKey() {
  const key = process.env.AI_ROUTER_DELEGATE_PRIVATE_KEY || process.env.EOA_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY || process.env.OWNER_PRIVATE_KEY || ''
  return key ? key.startsWith('0x') ? key : `0x${key}` : ''
}

function delegateSignerAddress() {
  try {
    const privateKey = delegatePrivateKey()
    return privateKey ? privateKeyToAccount(privateKey).address : ''
  } catch {
    return ''
  }
}

export async function estimateDelegatedAiSpend({ sourceAccount, amount, sourceChains = [] }) {
  const cfg = delegateConfig()
  if (!cfg.enabled || !cfg.delegateAddress) throw new Error('Enable Auto Pay first')
  if (!cfg.recipient) throw new Error('ARCOX treasury recipient is not configured')
  const receiveUnits = usdcUnits(amount)
  let spendUnits = receiveUnits
  let estimate
  let stable = false
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const spendAmount = formatUsdc(spendUnits)
    const allocations = await delegatedAllocations(sourceAccount, spendAmount, sourceChains)
    estimate = await getKit().unifiedBalance.estimateSpend({
      from: [{ adapter: getAdapter(), sourceAccount, allocations }],
      to: { chain: 'Arc_Testnet', recipientAddress: cfg.recipient, useForwarder: true },
      amount: spendAmount,
      token: 'USDC',
    })
    const nextSpend = receiveUnits + totalFeeUnits(estimate?.fees)
    if (nextSpend === spendUnits) {
      stable = true
      break
    }
    spendUnits = nextSpend
  }
  if (!stable) throw new Error('Gateway fee estimate did not stabilize. Try again.')
  return {
    ...estimate,
    requestedReceiveAmount: formatUsdc(receiveUnits),
    spendAmount: formatUsdc(spendUnits),
    totalFee: formatUsdc(spendUnits - receiveUnits),
  }
}

export async function spendDelegatedAiPayment({ sourceAccount, amount, estimate: preparedEstimate, sourceChains = [] }) {
  const cfg = delegateConfig()
  if (!cfg.enabled || !cfg.delegateAddress) throw new Error('Enable Auto Pay first')
  if (!cfg.recipient) throw new Error('ARCOX treasury recipient is not configured')
  const estimate = preparedEstimate || await estimateDelegatedAiSpend({ sourceAccount, amount, sourceChains })
  const spendAmount = estimate.spendAmount || amount
  const allocations = await delegatedAllocations(sourceAccount, spendAmount, sourceChains)
  const result = await getKit().unifiedBalance.spend({
    from: [{
      adapter: getAdapter(),
      sourceAccount,
      allocations,
    }],
    to: {
      chain: 'Arc_Testnet',
      recipientAddress: cfg.recipient,
      useForwarder: true,
    },
    amount: spendAmount,
    token: 'USDC',
  })
  return {
    estimate,
    result,
    txHash: result?.txHash || result?.transactionHash || result?.hash || result?.transactionHashDestination || result?.destinationTxHash || '',
    transferId: result?.transferId || result?.id || '',
    chargedAmount: spendAmount,
    serviceAmount: amount,
    totalFee: estimate.totalFee || '0',
  }
}

async function delegatedAllocations(sourceAccount, amount, sourceChains) {
  const allowed = new Set(sourceChains.length ? sourceChains : ['Arc_Testnet'])
  const response = await gatewayRequest('/v1/balances', {
    token: 'USDC',
    sources: GATEWAY_CHAINS.map(({ domain }) => ({ depositor: sourceAccount, domain })),
  })
  const balances = new Map((response?.balances || []).map(item => [Number(item.domain), usdcUnits(String(item.balance || '0'))]))
  let remaining = usdcUnits(amount)
  const allocations = []
  for (const { chain, domain } of GATEWAY_CHAINS) {
    if (!allowed.has(chain) || remaining <= 0n) continue
    const available = balances.get(domain) || 0n
    if (available <= 0n) continue
    const value = available < remaining ? available : remaining
    allocations.push({ chain, amount: formatUsdc(value) })
    remaining -= value
  }
  if (remaining > 0n) throw new Error('Please deposit more USDC to Unified Balance or enable Auto Pay on another funded chain')
  return allocations
}

async function gatewayRequest(path, body) {
  const attempts = 2
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${GATEWAY_API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'arcox-ai-router/1.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.AI_ROUTER_GATEWAY_TIMEOUT_MS || 7_000)),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.success === false) throw new Error(data?.message || `Circle Gateway HTTP ${response.status}`)
      return data
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw new Error(lastError?.name === 'TimeoutError' ? 'Circle Gateway balance request timed out' : (lastError?.message || 'Circle Gateway balance request failed'))
}

function usdcUnits(value) {
  const normalized = String(value || '0').trim()
  if (!/^\d+(\.\d{0,6})?$/.test(normalized)) throw new Error('Invalid USDC amount')
  const [whole, fraction = ''] = normalized.split('.')
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
}

function formatUsdc(value) {
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

function totalFeeUnits(fees) {
  return (Array.isArray(fees) ? fees : []).reduce((total, fee) => total + usdcUnits(String(fee?.amount || '0')), 0n)
}
