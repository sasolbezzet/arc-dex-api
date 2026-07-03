import { AppKit } from '@circle-fin/app-kit'
import { createSolanaKitAdapterFromProvider } from '@circle-fin/adapter-solana-kit'
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2'
import { createSolanaRpc } from '@solana/kit'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import { privateKeyToAccount } from 'viem/accounts'
import bs58 from 'bs58'
import {
  createX402Invoice,
  estimateUnifiedBalanceX402,
  markUnifiedBalanceSpendSubmitted,
  reconcileX402Invoice,
} from '../src/middleware/x402Middleware.mjs'
import {
  delegateConfig,
  estimateDelegatedUnifiedSpend,
  spendDelegatedUnifiedBalance,
} from '../src/services/aiRouterSpendService.mjs'

const DEPOSIT_AMOUNT = process.env.SOLANA_E2E_DEPOSIT_AMOUNT || '0.40'
const TEST_AMOUNT = process.env.SOLANA_E2E_TEST_AMOUNT || '0.001'
const GATEWAY = 'https://gateway-api-testnet.circle.com'

const solanaKeypair = parseSolanaKey(process.env.SOLANA_PRIVATE_KEY)
const solanaOwner = solanaKeypair.publicKey.toBase58()
const evmKey = String(process.env.EOA_PRIVATE_KEY || '')
const normalizedEvmKey = evmKey.startsWith('0x') ? evmKey : `0x${evmKey}`
const evmOwner = privateKeyToAccount(normalizedEvmKey).address
const kit = new AppKit()
const solanaAdapter = browserStyleSolanaAdapter(solanaKeypair)
const evmAdapter = createViemAdapterFromPrivateKey({ privateKey: normalizedEvmKey })
const config = delegateConfig()
let delegateRemoved = false

try {
  const startingBalance = await gatewaySolanaBalance()
  const deposit = await kit.unifiedBalance.deposit({
    from: { adapter: solanaAdapter, chain: 'Solana_Devnet' },
    amount: DEPOSIT_AMOUNT,
    token: 'USDC',
  })
  print('deposit', { txHash: deposit.txHash, amount: deposit.amount })
  await waitForGatewayBalance(startingBalance + Number(DEPOSIT_AMOUNT) - 0.000001)

  const withdrawInput = {
    from: { adapter: evmAdapter, allocations: [{ chain: 'Arc_Testnet', amount: TEST_AMOUNT }] },
    to: { adapter: solanaAdapter, chain: 'Solana_Devnet', recipientAddress: solanaOwner },
    amount: TEST_AMOUNT,
    token: 'USDC',
  }
  const withdrawEstimate = await kit.unifiedBalance.estimateSpend(withdrawInput)
  print('withdraw_estimate', withdrawEstimate)
  const withdraw = await kit.unifiedBalance.spend(withdrawInput)
  print('withdraw', { txHash: withdraw.txHash, transferId: withdraw.transferId })

  const before = await delegateStatus()
  print('delegate_before', before)
  if (normalizeStatus(before) === 'ready') {
    const removed = await kit.unifiedBalance.removeDelegate({
      from: { adapter: solanaAdapter, chain: 'Solana_Devnet' },
      delegateAddress: config.solanaDelegateAddress,
    })
    delegateRemoved = true
    print('delegate_off_tx', removed)
  }
  const afterOff = await delegateStatus()
  print('delegate_after_off', afterOff)
  if (normalizeStatus(afterOff) === 'ready') throw new Error('Solana delegate remained ready after removal')

  const added = await kit.unifiedBalance.addDelegate({
    from: { adapter: solanaAdapter, chain: 'Solana_Devnet' },
    delegateAddress: config.solanaDelegateAddress,
  })
  delegateRemoved = false
  print('delegate_on_tx', added)
  const finalDelegate = await delegateStatus()
  print('delegate_final', finalDelegate)
  if (normalizeStatus(finalDelegate) !== 'ready') throw new Error('Solana delegate did not return to ready')

  const autoPayInput = {
    sourceAccount: evmOwner,
    solanaSourceAccount: solanaOwner,
    amount: TEST_AMOUNT,
    sourceChains: ['Solana_Devnet'],
    destinationChain: 'Arc_Testnet',
    recipient: config.recipient,
  }
  const autoPayEstimate = await estimateDelegatedUnifiedSpend(autoPayInput)
  print('auto_pay_estimate', { totalFee: autoPayEstimate.totalFee, totalDebit: autoPayEstimate.totalDebit })
  const autoPay = await spendDelegatedUnifiedBalance({ ...autoPayInput, estimate: autoPayEstimate, maxTotalDebit: '0.25' })
  print('auto_pay', { txHash: autoPay.txHash, transferId: autoPay.transferId, chargedAmount: autoPay.chargedAmount })

  const invoice = createX402Invoice({
    service: 'solana_e2e',
    resource: '/api/intel/address/0x0000000000000000000000000000000000000000',
    amount: TEST_AMOUNT,
    ownerWallet: evmOwner,
  })
  const x402Input = { ...autoPayInput, amount: invoice.uniqueAmount, recipient: invoice.recipient }
  const x402Estimate = await estimateDelegatedUnifiedSpend(x402Input)
  estimateUnifiedBalanceX402(invoice.invoiceId, { fees: x402Estimate.fees, delegateStatus: 'ready' })
  const x402Spend = await spendDelegatedUnifiedBalance({ ...x402Input, estimate: x402Estimate, maxTotalDebit: '0.25' })
  markUnifiedBalanceSpendSubmitted(invoice.invoiceId, { txHash: x402Spend.txHash, transferId: x402Spend.transferId }, { trustedGateway: true })
  const settled = await reconcileX402Invoice(invoice.invoiceId)
  print('x402', { invoiceId: invoice.invoiceId, status: settled.status, txHash: x402Spend.txHash, transferId: x402Spend.transferId })
  if (settled.status !== 'paid') throw new Error(`x402 invoice ended in ${settled.status}`)

  print('summary', { ok: true, solanaOwner, evmOwner })
} catch (error) {
  console.error(error)
  if (delegateRemoved) {
    try {
      await kit.unifiedBalance.addDelegate({
        from: { adapter: solanaAdapter, chain: 'Solana_Devnet' },
        delegateAddress: config.solanaDelegateAddress,
      })
      console.error('Recovery: Solana delegate restored')
    } catch (recoveryError) {
      console.error('Recovery failed:', recoveryError)
    }
  }
  process.exitCode = 1
}

function browserStyleSolanaAdapter(keypair) {
  const walletAddress = keypair.publicKey.toBase58()
  const provider = {
    address: walletAddress,
    publicKey: keypair.publicKey,
    isConnected: true,
    connect: async () => ({ address: walletAddress, publicKey: keypair.publicKey }),
    signTransaction: async encoded => {
      const walletTransaction = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'))
      if (walletTransaction.message.staticAccountKeys[0].toBase58() !== walletAddress) throw new Error('Browser signer fee payer mismatch')
      walletTransaction.sign([keypair])
      return walletTransaction
    },
  }
  return createSolanaKitAdapterFromProvider({
    provider,
    getRpc: () => createSolanaRpc(process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com'),
    capabilities: { addressContext: 'user-controlled' },
  })
}

function parseSolanaKey(value = '') {
  let bytes
  try { bytes = Uint8Array.from(JSON.parse(value)) } catch {
    try { bytes = bs58.decode(value) } catch { bytes = Uint8Array.from(Buffer.from(value, 'base64')) }
  }
  return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes)
}

async function delegateStatus() {
  return kit.unifiedBalance.getDelegateStatus({
    from: { adapter: solanaAdapter, chain: 'Solana_Devnet' },
    delegateAddress: config.solanaDelegateAddress,
  })
}

function normalizeStatus(value) {
  return String(value?.status || value?.state || value || '').toLowerCase().replaceAll('_', ' ')
}

async function gatewaySolanaBalance() {
  const response = await fetch(`${GATEWAY}/v1/balances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'USDC', sources: [{ depositor: solanaOwner, domain: 5 }] }),
  })
  const data = await response.json()
  return Number(data?.balances?.[0]?.balance || 0)
}

async function waitForGatewayBalance(minimum) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const balance = await gatewaySolanaBalance()
    if (balance >= minimum) return balance
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`Gateway balance did not reach ${minimum}`)
}

function print(step, value) {
  const payload = value && typeof value === 'object' ? value : { value }
  console.log(JSON.stringify({ step, ...payload }, (_, item) => typeof item === 'bigint' ? item.toString() : item))
}
