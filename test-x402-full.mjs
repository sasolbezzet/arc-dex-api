import { createWalletClient, createPublicClient, http, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const pk = '0x19aabb0f6870a1cde38809104bd546c97ae831590925bbe16df83b54d17222e6'
const account = privateKeyToAccount(pk)

const chain = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } },
}

const client = createWalletClient({ account, chain, transport: http() })
const publicClient = createPublicClient({ chain, transport: http() })

const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'
const ERC20_ABI = [{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}]

async function run() {
  console.log("1. Fetching x402 invoice from API...")
  const res1 = await fetch('http://localhost:3001/api/intel/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  if (res1.status !== 402) throw new Error("Expected 402, got " + res1.status)
  
  const data = await res1.json()
  const invoice = data.x402
  console.log("Invoice received:", invoice.invoiceId, "| Amount:", invoice.uniqueAmount, "USDC | To:", invoice.recipient)
  
  console.log("\n2. Sending USDC transaction on Arc Testnet...")
  const amountBaseUnits = parseUnits(invoice.uniqueAmount, 6)
  
  const txHash = await client.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [invoice.recipient, amountBaseUnits]
  })
  console.log("Tx Hash:", txHash)
  
  console.log("\n3. Waiting for receipt...")
  await publicClient.waitForTransactionReceipt({ hash: txHash })
  console.log("Transaction confirmed!")
  
  // Wait a moment for safety
  await new Promise(resolve => setTimeout(resolve, 3000))
  
  console.log("\n4. Fetching intel again with x-payment-id header...")
  const res2 = await fetch('http://localhost:3001/api/intel/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', {
    headers: { 'x-payment-id': invoice.paymentId }
  })
  
  const intel = await res2.json()
  console.log("\n--- RESULT ---")
  console.log("Status:", res2.status)
  console.log("Arkham Intel Data (Truncated):")
  console.log(JSON.stringify(intel).slice(0, 500) + '...')
  
  if (intel.arkhamEntity || intel.intelPresentation) {
    console.log("SUCCESS! x402 payment validated and intel unlocked.")
  } else {
    console.log("FAILED to unlock intel.")
  }
}

run().catch(console.error)
