import { AppKit } from '@circle-fin/app-kit'
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets'

let kit
let adapter

function getKit() {
  if (!kit) kit = new AppKit()
  return kit
}

function getAdapter() {
  if (!adapter) {
    adapter = createCircleWalletsAdapter({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    })
  }
  return adapter
}

export function delegateConfig() {
  return {
    delegateAddress: firstValidAddress(process.env.AI_ROUTER_DELEGATE_ADDRESS, process.env.CIRCLE_DELEGATE_ADDRESS, process.env.CIRCLE_X402_TREASURY_ADDRESS),
    recipient: firstValidAddress(process.env.AI_ROUTER_TREASURY_ADDRESS, process.env.ARCOX_TREASURY_WALLET_ADDRESS, process.env.X402_RECIPIENT_ADDRESS, process.env.CIRCLE_X402_TREASURY_ADDRESS),
    enabled: Boolean(process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET),
  }
}

function firstValidAddress(...values) {
  return values.find(value => /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim())) || ''
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

export async function spendDelegatedAiPayment({ sourceAccount, amount }) {
  const cfg = delegateConfig()
  if (!cfg.enabled || !cfg.delegateAddress) throw new Error('Enable Auto Pay first')
  if (!cfg.recipient) throw new Error('ARCOX treasury recipient is not configured')
  const estimate = await estimateDelegatedAiSpend({ sourceAccount, amount })
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
