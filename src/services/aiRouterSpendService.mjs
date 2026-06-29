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
  const balances = await delegatedBalances(sourceAccount)
  const allowed = new Set(sourceChains.length ? sourceChains : ['Arc_Testnet'])
  const candidates = GATEWAY_CHAINS
    .filter(item => allowed.has(item.chain) && (balances.get(item.domain) || 0n) > 0n)
    .sort((left, right) => sourcePriority(left.chain) - sourcePriority(right.chain))
  for (const candidate of candidates) {
    try {
      return await estimateForSources({ sourceAccount, receiveUnits, sourceChains: [candidate.chain], balances, recipient: cfg.recipient })
    } catch {}
  }
  if (candidates.length > 1) {
    return estimateForSources({ sourceAccount, receiveUnits, sourceChains: candidates.map(item => item.chain), balances, recipient: cfg.recipient })
  }
  throw new Error('Please deposit more USDC to Unified Balance or enable Auto Pay on another funded chain')
}

export async function spendDelegatedAiPayment({ sourceAccount, amount, estimate: preparedEstimate, sourceChains = [] }) {
  const cfg = delegateConfig()
  if (!cfg.enabled || !cfg.delegateAddress) throw new Error('Enable Auto Pay first')
  if (!cfg.recipient) throw new Error('ARCOX treasury recipient is not configured')
  const estimate = preparedEstimate || await estimateDelegatedAiSpend({ sourceAccount, amount, sourceChains })
  const spendAmount = estimate.spendAmount || amount
  const allocations = Array.isArray(estimate.sourceAllocations) && estimate.sourceAllocations.length
    ? estimate.sourceAllocations
    : await delegatedAllocations(sourceAccount, spendAmount, sourceChains)
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
  const actualFeeUnits = totalFeeUnits(result?.fees || estimate.fees)
  return {
    estimate,
    result,
    txHash: result?.txHash || result?.transactionHash || result?.hash || result?.transactionHashDestination || result?.destinationTxHash || '',
    transferId: result?.transferId || result?.id || '',
    chargedAmount: formatUsdc(usdcUnits(spendAmount) + actualFeeUnits),
    serviceAmount: amount,
    totalFee: formatUsdc(actualFeeUnits),
    sourceAllocations: allocations,
  }
}

async function estimateForSources({ sourceAccount, receiveUnits, sourceChains, balances, recipient }) {
  const spendAmount = formatUsdc(receiveUnits)
  const sourceAllocations = await delegatedAllocations(sourceAccount, spendAmount, sourceChains, balances)
  const estimate = await getKit().unifiedBalance.estimateSpend({
    from: [{ adapter: getAdapter(), sourceAccount, allocations: sourceAllocations }],
    to: { chain: 'Arc_Testnet', recipientAddress: recipient, useForwarder: true },
    amount: spendAmount,
    token: 'USDC',
  })
  const feeUnits = totalFeeUnits(estimate?.fees)
  const availableUnits = GATEWAY_CHAINS
    .filter(item => sourceChains.includes(item.chain))
    .reduce((total, item) => total + (balances.get(item.domain) || 0n), 0n)
  if (availableUnits < receiveUnits + feeUnits) throw new Error('Unified Balance source cannot cover the service amount and Gateway fee')
  return {
    ...estimate,
    requestedReceiveAmount: spendAmount,
    spendAmount,
    totalFee: formatUsdc(feeUnits),
    totalDebit: formatUsdc(receiveUnits + feeUnits),
    sourceAllocations,
  }
}

async function delegatedBalances(sourceAccount) {
  const response = await gatewayRequest('/v1/balances', {
    token: 'USDC',
    sources: GATEWAY_CHAINS.map(({ domain }) => ({ depositor: sourceAccount, domain })),
  })
  return new Map((response?.balances || []).map(item => [Number(item.domain), usdcUnits(String(item.balance || '0'))]))
}

async function delegatedAllocations(sourceAccount, amount, sourceChains, knownBalances) {
  const allowed = new Set(sourceChains.length ? sourceChains : ['Arc_Testnet'])
  const balances = knownBalances || await delegatedBalances(sourceAccount)
  let remaining = usdcUnits(amount)
  const allocations = []
  const orderedChains = GATEWAY_CHAINS
    .filter(item => allowed.has(item.chain))
    .sort((left, right) => sourcePriority(left.chain) - sourcePriority(right.chain))
  for (const { chain, domain } of orderedChains) {
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

function sourcePriority(chain) {
  return ({ Base_Sepolia: 0, Arbitrum_Sepolia: 1, Arc_Testnet: 2, Ethereum_Sepolia: 3 })[chain] ?? 9
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
  const entries = Array.isArray(fees) ? fees : []
  const gasFeeIncludesForwarder = entries.some(fee => fee?.type === 'gasFee')
  return entries.reduce((total, fee) => {
    if (gasFeeIncludesForwarder && fee?.type === 'forwarder') return total
    return total + usdcUnits(String(fee?.amount || '0'))
  }, 0n)
}
