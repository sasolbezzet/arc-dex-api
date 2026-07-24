import 'dotenv/config'
import { reconcileX402Invoice } from './src/middleware/x402Middleware.mjs'

console.log('ARC_RPC_URL:', process.env.ARC_RPC_URL)
console.log('X402_RECONCILE_LOOKBACK_BLOCKS:', process.env.X402_RECONCILE_LOOKBACK_BLOCKS)

const inv = await reconcileX402Invoice('arcox_x402_c8ff5a07f54945cd')
console.log('status:', inv?.status)
console.log('txHash:', inv?.txHash)
console.log('reconciledBy:', inv?.reconciledBy)
console.log('paidAt:', inv?.paidAt)
