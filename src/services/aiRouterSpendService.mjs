import { AppKit } from '@circle-fin/app-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { privateKeyToAccount } from 'viem/accounts'

let kit
let adapter

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

export async function estimateDelegatedAiSpend({ sourceAccount, amount }) {
  const cfg = delegateConfig()
  if (!cfg.enabled || !cfg.delegateAddress) throw new Error('Enable Auto Pay first')
  if (!cfg.recipient) throw new Error('ARCOX treasury recipient is not configured')
  return getKit().unifiedBalance.estimateSpend({
    from: {
      adapter: getAdapter(),
      address: cfg.delegateAddress,
      sourceAccount,
    },
    to: {
      adapter: getAdapter(),
      chain: 'Arc_Testnet',
      recipientAddress: cfg.recipient,
      useForwarder: true,
    },
    amount,
    token: 'USDC',
  })
}

export async function spendDelegatedAiPayment({ sourceAccount, amount, estimate: preparedEstimate }) {
  const cfg = delegateConfig()
  if (!cfg.enabled || !cfg.delegateAddress) throw new Error('Enable Auto Pay first')
  if (!cfg.recipient) throw new Error('ARCOX treasury recipient is not configured')
  const estimate = preparedEstimate || await estimateDelegatedAiSpend({ sourceAccount, amount })
  const result = await getKit().unifiedBalance.spend({
    from: {
      adapter: getAdapter(),
      address: cfg.delegateAddress,
      sourceAccount,
    },
    to: {
      adapter: getAdapter(),
      chain: 'Arc_Testnet',
      recipientAddress: cfg.recipient,
      useForwarder: true,
    },
    amount,
    token: 'USDC',
  })
  return {
    estimate,
    result,
    txHash: result?.txHash || result?.transactionHash || result?.hash || result?.transactionHashDestination || result?.destinationTxHash || '',
    transferId: result?.transferId || result?.id || '',
  }
}
